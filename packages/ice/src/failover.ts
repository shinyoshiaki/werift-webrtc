import {
  type CandidatePair,
  CandidatePairState,
  CONNECTION_WRITE_CONNECT_FAILURES,
  CONNECTION_WRITE_CONNECT_TIMEOUT,
  compareCandidatePairPriority,
  DEAD_CONNECTION_RECEIVE_TIMEOUT,
  FAILOVER_BACKUP_ATTEMPTS,
  FAILOVER_RECOVERY_RESPONSES,
  MIN_PINGS_AT_WEAK_PING_INTERVAL,
  STABLE_WRITABLE_CONNECTION_PING_INTERVAL,
  WEAK_CONNECTION_RECEIVE_TIMEOUT,
  WEAK_OR_STABILIZING_WRITABLE_CONNECTION_PING_INTERVAL,
} from "./iceBase";
import type { Protocol } from "./types/model";

/** Ta: the minimum spacing (ms) between two backup checks, as the ordinary schedule. */
const PACING_MS = 20;

/**
 * Delays before a socket whose backup pairs all failed starts again from its
 * highest-priority pair, one per retry; after the last one it goes on every
 * last delay (16 s) while the selection lasts.
 */
const BACKUP_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;

/**
 * What the agent knows about a monitored pair (the selected pair and the
 * backups). Only a response to a check makes a pair writable: application
 * data or a request from the peer only counts as received (as RFC 7675
 * consent does not take data as consent).
 */
export type PairLiveness = {
  /** When the pair began to be monitored (ms, `Date.now()`). */
  since: number;
  /** The last response to a check (undefined: none since monitoring began). */
  lastResponse?: number;
  /** The last response, request or application data received on the pair. */
  lastReceived: number;
  /** Consecutive checks that went unanswered. */
  unanswered: number;
  /** Responses since monitoring began (stabilizing below MIN_PINGS_AT_WEAK_PING_INTERVAL). */
  responses: number;
  /** Consecutive responses (reset by an unanswered check). */
  consecutive: number;
};

/**
 * No longer writable: CONNECTION_WRITE_CONNECT_FAILURES consecutive checks
 * unanswered and CONNECTION_WRITE_CONNECT_TIMEOUT since the last response
 * (or, for a pair never answered, since monitoring began).
 */
export const isUnwritable = (liveness: PairLiveness, now: number) =>
  liveness.unanswered >= CONNECTION_WRITE_CONNECT_FAILURES &&
  now - (liveness.lastResponse ?? liveness.since) >=
    CONNECTION_WRITE_CONNECT_TIMEOUT;

/** Answered since monitoring began and not unwritable. */
export const isWritable = (liveness: PairLiveness, now: number) =>
  liveness.lastResponse !== undefined && !isUnwritable(liveness, now);

/** The last check went unanswered, or nothing was received for WEAK_CONNECTION_RECEIVE_TIMEOUT. */
export const isWeak = (liveness: PairLiveness, now: number) =>
  liveness.unanswered > 0 ||
  now - liveness.lastReceived >= WEAK_CONNECTION_RECEIVE_TIMEOUT;

/**
 * Interval (ms) to the next check of a backup pair: the weak / stabilizing
 * one until it answered MIN_PINGS_AT_WEAK_PING_INTERVAL times and while its
 * last check goes unanswered, else the stable one (0.8–1.2 times).
 */
export const backupPingInterval = (liveness: PairLiveness) =>
  liveness.unanswered > 0 ||
  liveness.responses < MIN_PINGS_AT_WEAK_PING_INTERVAL
    ? WEAK_OR_STABILIZING_WRITABLE_CONNECTION_PING_INTERVAL
    : STABLE_WRITABLE_CONNECTION_PING_INTERVAL * (0.8 + 0.4 * Math.random());

/**
 * When the next check of a monitored pair is due (ms), given when the last
 * one was sent and the interval it uses while the pair is not weak (D3):
 * - its last check went unanswered (weak): WEAK_OR_STABILIZING_WRITABLE_CONNECTION_PING_INTERVAL
 *   after it;
 * - otherwise `stableInterval` after it, but no later than the moment the
 *   pair has received nothing for WEAK_CONNECTION_RECEIVE_TIMEOUT (weak by
 *   silence), and never sooner than the weak interval.
 * Something received later only moves it later: a caller that wakes up at
 * the time computed earlier computes it again.
 */
export const nextPingAt = (
  liveness: PairLiveness,
  lastSentAt: number,
  stableInterval: number,
) => {
  const weakAt =
    lastSentAt + WEAK_OR_STABILIZING_WRITABLE_CONNECTION_PING_INTERVAL;
  if (liveness.unanswered > 0) return weakAt;
  return Math.max(
    weakAt,
    Math.min(
      lastSentAt + stableInterval,
      liveness.lastReceived + WEAK_CONNECTION_RECEIVE_TIMEOUT,
    ),
  );
};

/** The agent's side of `FailoverMonitor`. */
export interface FailoverHost {
  /**
   * Failover applies now: full ICE on both sides, semi-aggressive nomination
   * or renomination, a selected pair that is not ICE-TCP, an open agent.
   */
  enabled(): boolean;
  selected(): CandidatePair | undefined;
  /** The checklist, highest priority first. */
  pairs(): readonly CandidatePair[];
  /** `pair` may be a backup (not ICE-TCP, checked by the agent). */
  eligible(pair: CandidatePair): boolean;
  iceControlling(): boolean;
  /**
   * Send one check of `pair` without a nomination; resolves true when it
   * was answered. `signal` cancels it.
   */
  ping(pair: CandidatePair, signal: AbortSignal): Promise<boolean>;
  /** A backup that was not valid (Waiting, Frozen, Failed) answered: it is valid now. */
  validated(pair: CandidatePair): void;
  /** A backup was dropped (never answered, or received nothing for DEAD_CONNECTION_RECEIVE_TIMEOUT). */
  dropped(pair: CandidatePair): void;
  /** The writability of a monitored pair may have changed. */
  changed(): void;
  /** A socket the agent failed over from answered FAILOVER_RECOVERY_RESPONSES times in a row. */
  recovered(): void;
}

/** The backup of one local socket (`Protocol`: a UDP socket or a TURN allocation). */
type BackupRecord = {
  pair?: CandidatePair;
  /** When the next check of `pair` is due (see `nextPingAt`; recomputed when it comes). */
  nextAt: number;
  /** When the last check of `pair` was sent. */
  sentAt?: number;
  /** The interval `pair` uses while not weak, fixed when its last check was sent. */
  stableInterval: number;
  /** Checks of `pair` still waiting for their outcome. */
  inFlight: number;
  /** Pairs of this socket that failed as its backup in this round. */
  failed: Set<CandidatePair>;
  /** Rounds started again from the highest-priority pair. */
  retries: number;
  retryTimer?: ReturnType<typeof setTimeout>;
};

/**
 * Failover of the selected pair without an ICE restart, as libwebrtc keeps
 * pinging its connections after the selection.
 *
 * One backup pair is monitored per local socket other than the selected
 * pair's (`CandidatePair.protocol`: a UDP socket, whose host and
 * server-reflexive candidates share one path, or a TURN allocation): the
 * highest-priority pair of the socket that did not fail. A backup that never
 * answers (unwritable) or receives nothing for DEAD_CONNECTION_RECEIVE_TIMEOUT
 * fails and the next pair of its socket follows, up to
 * FAILOVER_BACKUP_ATTEMPTS pairs; then the socket starts again from its best
 * pair after BACKUP_RETRY_DELAYS_MS, then every 16 s while the selection
 * lasts. All checks run from one timer, paced by
 * Ta, and stop with `halt()` / `reset()`.
 *
 * The selected pair is checked by the consent freshness checks (the agent
 * reports their outcome with `responded` / `unanswered`); the monitor keeps
 * its liveness beside the backups'.
 */
export class FailoverMonitor {
  private liveness = new WeakMap<CandidatePair, PairLiveness>();
  private readonly backups = new Map<Protocol, BackupRecord>();
  /** Pairs RFC 8445 §8.1.2 failed without a check: they may still become a backup. */
  private pruned = new WeakSet<CandidatePair>();
  /** Sockets the agent failed over from, until one of their pairs answered FAILOVER_RECOVERY_RESPONSES times in a row. */
  private readonly demoted = new Set<Protocol>();
  private abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private readonly host: FailoverHost;

  constructor(host: FailoverHost) {
    this.host = host;
  }

  /** The liveness of `pair`, while it is monitored. */
  livenessOf(pair: CandidatePair): PairLiveness | undefined {
    return this.liveness.get(pair);
  }

  /** The monitored backup pairs, one per socket. */
  get backupPairs(): CandidatePair[] {
    const pairs: CandidatePair[] = [];
    for (const record of this.backups.values()) {
      if (record.pair) pairs.push(record.pair);
    }
    return pairs;
  }

  /** `pair` is monitored and writable. */
  writable(pair: CandidatePair, now = Date.now()) {
    const liveness = this.liveness.get(pair);
    return !!liveness && isWritable(liveness, now);
  }

  /** `pair` is monitored, answered since and is unwritable now. */
  knownUnwritable(pair: CandidatePair, now = Date.now()) {
    const liveness = this.liveness.get(pair);
    return (
      !!liveness &&
      liveness.lastResponse !== undefined &&
      isUnwritable(liveness, now)
    );
  }

  /** A backup is writable. */
  hasWritableBackup(now = Date.now()) {
    return this.backupPairs.some((pair) => this.writable(pair, now));
  }

  /**
   * The backup to fail over to: the highest-priority writable one that is
   * not weak, else the highest-priority writable one.
   */
  target(now = Date.now()): CandidatePair | undefined {
    const writable = this.backupPairs.filter((pair) =>
      this.writable(pair, now),
    );
    const best = (pairs: CandidatePair[]) =>
      pairs.reduce<CandidatePair | undefined>(
        (best, pair) => (!best || this.outranks(pair, best) ? pair : best),
        undefined,
      );
    return (
      best(writable.filter((pair) => !isWeak(this.liveness.get(pair)!, now))) ??
      best(writable)
    );
  }

  /**
   * `pair` may be nominated to move the selection up: its socket is not one
   * the agent failed over from (until it recovered) and the pair is not known
   * to be unwritable.
   */
  allows(pair: CandidatePair) {
    return !this.demoted.has(pair.protocol) && !this.knownUnwritable(pair);
  }

  /**
   * `pair` was selected (first selection, or a replacement): its check was
   * just answered. The monitor follows the new selection.
   */
  selected(pair: CandidatePair) {
    if (!this.host.enabled()) return;
    this.track(pair);
    this.responded(pair);
    this.refresh();
  }

  /** The agent failed over from `pair`: its socket waits to recover before the selection may move back. */
  demote(pair: CandidatePair) {
    this.demoted.add(pair.protocol);
    const liveness = this.liveness.get(pair);
    if (liveness) liveness.consecutive = 0;
  }

  /** A check of monitored `pair` was answered. */
  responded(pair: CandidatePair, now = Date.now()) {
    const liveness = this.liveness.get(pair);
    if (!liveness) return;
    liveness.lastResponse = now;
    liveness.lastReceived = now;
    liveness.unanswered = 0;
    liveness.responses++;
    liveness.consecutive++;
  }

  /** A check of monitored `pair` went unanswered. */
  unanswered(pair: CandidatePair) {
    const liveness = this.liveness.get(pair);
    if (!liveness) return;
    liveness.unanswered++;
    liveness.consecutive = 0;
  }

  /** Something (a request, application data) arrived on monitored `pair`. */
  received(pair: CandidatePair, now = Date.now()) {
    const liveness = this.liveness.get(pair);
    if (liveness) liveness.lastReceived = now;
  }

  /**
   * The pairs RFC 8445 §8.1.2 must keep for the current selection: the
   * backup of each other socket (the monitored one, or the one it would
   * monitor next).
   */
  keeps(): Set<CandidatePair> {
    const keeps = new Set<CandidatePair>();
    const selected = this.host.selected();
    if (!selected || !this.host.enabled()) return keeps;
    for (const protocol of this.backupProtocols(selected)) {
      const record = this.backups.get(protocol);
      const pair = record?.pair ?? this.candidateFor(protocol, record);
      if (pair) keeps.add(pair);
    }
    return keeps;
  }

  /** RFC 8445 §8.1.2 failed `pair` without a check: it may still become a backup. */
  prunedWithoutCheck(pair: CandidatePair) {
    this.pruned.add(pair);
  }

  /**
   * Bring the backups in line with the selection and the checklist (a new
   * selection, a pair added, a backup that failed) and arm the timer.
   */
  refresh() {
    const selected = this.host.selected();
    if (!selected || !this.host.enabled()) {
      this.halt();
      return;
    }
    const now = Date.now();
    const protocols = this.backupProtocols(selected);
    for (const [protocol, record] of this.backups) {
      if (protocols.has(protocol)) continue;
      this.dropRecord(record);
      this.backups.delete(protocol);
    }
    const pairs = this.host.pairs();
    for (const protocol of protocols) {
      let record = this.backups.get(protocol);
      if (!record) {
        record = {
          nextAt: now,
          stableInterval: 0,
          inFlight: 0,
          failed: new Set(),
          retries: 0,
        };
        this.backups.set(protocol, record);
      }
      const current = record.pair;
      if (
        current &&
        (!pairs.includes(current) ||
          !this.host.eligible(current) ||
          current === selected ||
          // Failed by another check (a nomination that went unanswered).
          (current.state === CandidatePairState.FAILED &&
            record.inFlight === 0))
      ) {
        this.fail(record, current, false);
      }
      // A higher-priority pair of the socket appeared (a candidate trickled
      // or gathered later): it becomes the backup instead (D2).
      if (record.pair && !record.retryTimer) {
        const best = this.candidateFor(protocol, record);
        if (best && best !== record.pair && this.outranks(best, record.pair)) {
          this.replace(record, record.pair);
        }
      }
      if (record.pair || record.retryTimer) continue;
      const next =
        record.failed.size < FAILOVER_BACKUP_ATTEMPTS
          ? this.candidateFor(protocol, record)
          : undefined;
      if (next) {
        this.adopt(record, next, now);
      } else {
        this.scheduleRetry(protocol, record);
      }
    }
    this.arm();
  }

  /** Stop the checks and timers; the liveness of the pairs stays (a role change). */
  halt() {
    this.abort.abort();
    this.abort = new AbortController();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const record of this.backups.values()) this.dropRecord(record);
    this.backups.clear();
  }

  /** Stop everything and forget every pair (restart, close, a selection reset). */
  reset() {
    this.halt();
    this.demoted.clear();
    this.liveness = new WeakMap();
    this.pruned = new WeakSet();
    this.lastSentAt = Number.NEGATIVE_INFINITY;
  }

  /** The sockets that keep a backup: every socket of an eligible pair but the selected pair's. */
  private backupProtocols(selected: CandidatePair) {
    const protocols = new Set<Protocol>();
    for (const pair of this.host.pairs()) {
      if (pair.protocol === selected.protocol) continue;
      if (!this.host.eligible(pair)) continue;
      protocols.add(pair.protocol);
    }
    return protocols;
  }

  /**
   * The next backup of `protocol`: its highest-priority eligible pair that
   * did not fail in this round. A pair a check failed is skipped in the first
   * round (one RFC 8445 §8.1.2 failed unchecked is not); a retry round takes
   * every pair again.
   */
  private candidateFor(protocol: Protocol, record?: BackupRecord) {
    const retrying = (record?.retries ?? 0) > 0;
    return this.host
      .pairs()
      .find(
        (pair) =>
          pair.protocol === protocol &&
          this.host.eligible(pair) &&
          !record?.failed.has(pair) &&
          (pair.state !== CandidatePairState.FAILED ||
            this.pruned.has(pair) ||
            retrying),
      );
  }

  private adopt(record: BackupRecord, pair: CandidatePair, now: number) {
    record.pair = pair;
    record.nextAt = now;
    record.sentAt = undefined;
    record.inFlight = 0;
    this.pruned.delete(pair);
    this.track(pair, now);
    // The monitor checks it now: the ordinary schedule and the checks of
    // pairs that outrank the selection (Waiting / Frozen) leave it alone.
    if (pair.state !== CandidatePairState.SUCCEEDED) {
      pair.updateState(CandidatePairState.IN_PROGRESS);
    }
  }

  private track(pair: CandidatePair, now = Date.now()) {
    if (this.liveness.has(pair)) return;
    this.liveness.set(pair, {
      since: now,
      lastReceived: now,
      unanswered: 0,
      responses: 0,
      consecutive: 0,
    });
  }

  /** `pair` failed as the backup of `record`; with `notify` the agent marks it Failed. */
  private fail(record: BackupRecord, pair: CandidatePair, notify: boolean) {
    record.failed.add(pair);
    record.pair = undefined;
    record.inFlight = 0;
    if (this.host.selected() !== pair) this.liveness.delete(pair);
    if (notify) this.host.dropped(pair);
  }

  /**
   * A better pair takes over as the backup of `record`: `pair` is no longer
   * monitored but did not fail. One the monitor was still validating goes
   * back to Failed-without-check, so it may become the backup again.
   */
  private replace(record: BackupRecord, pair: CandidatePair) {
    record.pair = undefined;
    record.inFlight = 0;
    if (this.host.selected() !== pair) this.liveness.delete(pair);
    if (pair.state === CandidatePairState.IN_PROGRESS) {
      pair.updateState(CandidatePairState.FAILED);
      this.pruned.add(pair);
    }
  }

  /**
   * The socket's backups all failed: start again from its best pair after
   * BACKUP_RETRY_DELAYS_MS, then every last delay (16 s) for as long as the
   * selection lasts, so a path that comes back after a long outage is found
   * again (and is there when the selected pair breaks).
   */
  private scheduleRetry(protocol: Protocol, record: BackupRecord) {
    if (record.retryTimer) return;
    const delay =
      BACKUP_RETRY_DELAYS_MS[
        Math.min(record.retries, BACKUP_RETRY_DELAYS_MS.length - 1)
      ];
    record.retryTimer = setTimeout(() => {
      record.retryTimer = undefined;
      if (this.backups.get(protocol) !== record) return;
      record.retries++;
      record.failed.clear();
      this.refresh();
    }, delay);
  }

  private dropRecord(record: BackupRecord) {
    if (record.retryTimer !== undefined) clearTimeout(record.retryTimer);
    record.retryTimer = undefined;
    record.pair = undefined;
    record.inFlight = 0;
  }

  /** One timer for every backup: the earliest check due, Ta after the last one sent. */
  private arm() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    let at = Number.POSITIVE_INFINITY;
    for (const record of this.backups.values()) {
      if (record.pair) at = Math.min(at, record.nextAt);
    }
    if (at === Number.POSITIVE_INFINITY) return;
    at = Math.max(at, this.lastSentAt + PACING_MS);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.tick();
      },
      Math.max(0, at - Date.now()),
    );
  }

  private tick() {
    const now = Date.now();
    let due: [Protocol, BackupRecord] | undefined;
    for (const entry of this.backups) {
      const [, record] = entry;
      if (!record.pair || record.nextAt > now) continue;
      // Something received since moves it later (nextPingAt).
      if (record.sentAt !== undefined) {
        const liveness = this.liveness.get(record.pair);
        if (liveness) {
          record.nextAt = nextPingAt(
            liveness,
            record.sentAt,
            record.stableInterval,
          );
          if (record.nextAt > now) continue;
        }
      }
      if (!due || record.nextAt < due[1].nextAt) due = entry;
    }
    if (due) {
      this.lastSentAt = now;
      void this.check(due[0], due[1], due[1].pair!);
    }
    this.arm();
  }

  private async check(
    protocol: Protocol,
    record: BackupRecord,
    pair: CandidatePair,
  ) {
    const signal = this.abort.signal;
    const liveness = this.liveness.get(pair)!;
    const sentAt = Date.now();
    // Checks keep their pacing: the next one does not wait for this one's
    // outcome (its response timeout may exceed the interval).
    record.inFlight++;
    record.sentAt = sentAt;
    record.stableInterval = backupPingInterval(liveness);
    record.nextAt = nextPingAt(liveness, sentAt, record.stableInterval);
    let answered = false;
    try {
      answered = await this.host.ping(pair, signal);
    } catch {
      answered = false;
    }
    if (
      signal.aborted ||
      this.backups.get(protocol) !== record ||
      record.pair !== pair
    ) {
      return;
    }
    record.inFlight = Math.max(0, record.inFlight - 1);
    const now = Date.now();
    if (answered) {
      this.responded(pair, now);
    } else {
      this.unanswered(pair);
    }
    // The outcome decides the interval (stabilizing, weak or stable).
    record.stableInterval = backupPingInterval(liveness);
    record.nextAt = Math.max(
      now,
      nextPingAt(liveness, sentAt, record.stableInterval),
    );

    if (answered && pair.state !== CandidatePairState.SUCCEEDED) {
      this.host.validated(pair);
    }
    if (
      !answered &&
      ((liveness.lastResponse === undefined && isUnwritable(liveness, now)) ||
        now - liveness.lastReceived >= DEAD_CONNECTION_RECEIVE_TIMEOUT)
    ) {
      this.fail(record, pair, true);
      this.refresh();
    }
    if (
      answered &&
      this.demoted.has(protocol) &&
      liveness.consecutive >= FAILOVER_RECOVERY_RESPONSES
    ) {
      this.demoted.delete(protocol);
      this.host.recovered();
    }
    this.host.changed();
    this.arm();
  }

  private outranks(pair: CandidatePair, other: CandidatePair) {
    return (
      compareCandidatePairPriority(
        pair.localCandidate,
        pair.remoteCandidate,
        other.localCandidate,
        other.remoteCandidate,
        this.host.iceControlling(),
      ) > 0
    );
  }
}
