import * as timers from "node:timers/promises";
import { type CandidatePair, CandidatePairState } from "../iceBase";
import { type Address, debug } from "../imports/common";
import type { Protocol } from "../types/model";
import type { NominationOutcome } from "./regularNomination";

const log = debug(
  "werift-ice : packages/ice/src/nomination/selectionReplacement.ts : log",
);

/**
 * Semi-aggressive nomination and renomination: delays before a failed pair
 * that outranks the selection is checked again (`retryOutrankingPair`), one
 * per retry. As libwebrtc keeps pinging a connection until it has heard
 * nothing for 30 s, the retries end about 31 s after the failure.
 */
export const OUTRANKING_RETRY_DELAYS_MS = [
  1000, 2000, 4000, 8000, 16000,
] as const;

/** What the agent supplies to its `SelectionReplacement`. */
export type SelectionHost = {
  /** The live checklist, highest priority first. */
  checkList: () => readonly CandidatePair[];
  /** The selected pair (`Connection.nominated`). */
  selected: () => CandidatePair | undefined;
  controlling: () => boolean;
  closed: () => boolean;
  remoteGeneration: () => number;
  usesRenomination: () => boolean;
  usesSemiAggressiveNomination: () => boolean;
  /** The controlling agent may move the selection to a higher-priority pair. */
  replacesSelection: () => boolean;
  /** A pair semi-aggressive nomination and renomination may select (not ICE-TCP, checked locally). */
  replacesWith: (pair: CandidatePair) => boolean;
  outranks: (pair: CandidatePair, other: CandidatePair) => boolean;
  bestValidPair: (pairs: CandidatePair[]) => CandidatePair | undefined;
  isTcpPair: (pair: CandidatePair) => boolean;
  /** Start the ordinary check of `pair` (its handle is kept on the pair). */
  check: (pair: CandidatePair) => void;
  /** Apply the outcome of `pair` (`Connection.checkComplete`). */
  complete: (pair: CandidatePair) => void;
  /** Send the nominating check (USE-CANDIDATE, or NOMINATION `value`); never rejects. */
  sendNomination: (
    pair: CandidatePair,
    signal: AbortSignal,
    value?: number,
  ) => Promise<NominationOutcome>;
  /** A nomination of `pair` sent in remote `generation` no longer applies. */
  isStaleNomination: (pair: CandidatePair, generation: number) => boolean;
  /** 487: the peer is controlling and wins; the agent becomes controlled. */
  roleConflict: () => void;
  /**
   * Failover: `pair` may be nominated to move the selection up (its socket
   * is not one the agent failed over from and has not recovered yet, and it
   * is not known to be unwritable). Unset: every pair.
   */
  allows?: (pair: CandidatePair) => boolean;
  /**
   * Failover (controlling): the nominated `pair` replaces the selection
   * whatever its priority (the selection stopped answering, or it is the
   * failover nomination's pair).
   */
  failoverReplaces?: (pair: CandidatePair) => boolean;
  /** The nominating check of `pair` ended (any outcome, or aborted). */
  nominationEnded?: (pair: CandidatePair) => void;
};

/**
 * Semi-aggressive nomination and renomination (as libwebrtc): how a selection
 * is replaced after the first one.
 *
 * - Controlling: the pairs that outrank the selection go on being checked
 *   (`checkOutrankingPairs`), a failed one again after
 *   `OUTRANKING_RETRY_DELAYS_MS` (`scheduleRetries`), and the best valid pair
 *   is nominated with a separate check when no check of it did
 *   (`evaluate`; renomination sends increasing NOMINATION values).
 * - Controlled: between equal nominations the pair the peer sends data on
 *   wins (`controlledDataReceived`, `replaces`).
 */
export class SelectionReplacement {
  /**
   * Semi-aggressive nomination or renomination: the separate check that
   * nominates a valid pair which outranks the selection (see
   * `evaluate`). One at a time.
   */
  private inFlight?: {
    pair: CandidatePair;
    abort: AbortController;
  };
  /** The last NOMINATION value sent (renomination); it only increases. */
  private nominationValue = 0;
  /** `checkOutrankingPairs` is running. */
  private outrankingChecks = false;
  /**
   * Controlled agent: when each live pair last received application data
   * (an increasing sequence, larger is more recent). Between nominated pairs
   * of equal nomination, the one the peer sends on wins (`replaces`).
   */
  private readonly lastData = new WeakMap<CandidatePair, number>();
  private dataSequence = 0;
  /**
   * Retries of failed pairs that outrank the selection
   * (`scheduleRetries`): how many ran, and the pending timer.
   */
  private readonly retries = new Map<
    CandidatePair,
    { retries: number; timer?: ReturnType<typeof setTimeout> }
  >();
  /**
   * Semi-aggressive nomination and renomination (controlling): a pair that
   * outranks the selection but failed (a check or nomination that went
   * unanswered, e.g. while the path was briefly down) is checked again after
   * `OUTRANKING_RETRY_DELAYS_MS`, as libwebrtc keeps pinging its
   * connections. Without it the agents stay on the lower path when the
   * peer does not trigger a check on that pair either (e.g. its own check
   * failed too). Each pair waits for one retry at a time.
   */
  scheduleRetries() {
    const selected = this.host.selected();
    if (
      !selected ||
      this.host.closed() ||
      !this.host.controlling() ||
      !this.host.replacesSelection()
    ) {
      return;
    }
    for (const pair of this.host.checkList()) {
      if (!this.retriesOutranking(pair, selected)) continue;
      let entry = this.retries.get(pair);
      if (!entry) {
        entry = { retries: 0 };
        this.retries.set(pair, entry);
      }
      if (
        entry.timer !== undefined ||
        entry.retries >= OUTRANKING_RETRY_DELAYS_MS.length
      ) {
        continue;
      }
      const current = entry;
      const remoteGeneration = this.host.remoteGeneration();
      current.timer = setTimeout(() => {
        current.timer = undefined;
        current.retries++;
        this.retryOutrankingPair(pair, remoteGeneration);
      }, OUTRANKING_RETRY_DELAYS_MS[current.retries]);
    }
  }

  /** `pair` failed, outranks `selected` and may replace it. */
  private retriesOutranking(pair: CandidatePair, selected: CandidatePair) {
    return (
      pair.state === CandidatePairState.FAILED &&
      this.host.replacesWith(pair) &&
      this.host.outranks(pair, selected) &&
      this.allows(pair)
    );
  }

  /** A retry of `scheduleRetries` is due: check `pair` again. */
  private retryOutrankingPair(pair: CandidatePair, remoteGeneration: number) {
    const selected = this.host.selected();
    if (
      !selected ||
      this.host.closed() ||
      this.host.remoteGeneration() !== remoteGeneration ||
      !this.host.controlling() ||
      !this.host.replacesSelection() ||
      !this.host.checkList().includes(pair) ||
      !this.retriesOutranking(pair, selected)
    ) {
      return;
    }
    log("retry outranking pair", pair.toJSON());
    // One check per due retry (each pair has its own timer), so it starts
    // at once instead of waiting for the paced `checkOutrankingPairs`.
    this.host.check(pair);
  }

  /** `pair` succeeded: its retries of `scheduleRetries` are over. */
  forgetRetry(pair: CandidatePair) {
    const entry = this.retries.get(pair);
    if (!entry) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.retries.delete(pair);
  }

  /** Stop the retries of `scheduleRetries` (restart, close, role change). */
  clearRetries() {
    for (const entry of this.retries.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
    }
    this.retries.clear();
  }

  /**
   * Whether the nominated `pair` replaces the selected pair:
   * - controlled: the peer's larger nomination (the NOMINATION value;
   *   USE-CANDIDATE counts as 1, as in libwebrtc), the higher-priority pair
   *   between equal ones (RFC 5245 §8.1.1.2: the highest-priority nominated
   *   pair is used). A controlling peer nominating once (regular nomination)
   *   never causes a switch.
   * - controlling with renomination: the pair renominated last.
   * - controlling, semi-aggressive: a higher-priority pair.
   * - controlling, regular nomination or toward ICE-lite: never.
   */
  replaces(pair: CandidatePair) {
    const selected = this.host.selected();
    if (!selected || selected === pair) return false;
    if (!this.host.controlling()) {
      if (pair.remoteNomination !== selected.remoteNomination) {
        return pair.remoteNomination > selected.remoteNomination;
      }
      // Equal nominations: the pair the peer last sent data on, as libwebrtc
      // (the peer's own selection may move to a lower-priority pair, e.g.
      // when the selected one stopped working).
      const received = this.lastData.get(pair) ?? 0;
      const selectedReceived = this.lastData.get(selected) ?? 0;
      if (received !== selectedReceived) return received > selectedReceived;
      return this.host.outranks(pair, selected);
    }
    if (!this.host.replacesWith(pair)) return false;
    if (this.host.failoverReplaces?.(pair)) return true;
    if (this.host.usesRenomination())
      return pair.nomination > selected.nomination;
    if (this.host.usesSemiAggressiveNomination()) {
      return this.host.outranks(pair, selected);
    }
    return false;
  }

  /**
   * Controlled agent: application data arrived on the live pair of
   * `protocol` and `addr`. Record it (`lastData`) and, when the pair is
   * nominated but not selected, let it replace the selection if the peer
   * now sends on it (`replaces`). ICE-TCP pairs only record:
   * selecting one prunes the other TCP connections.
   */
  controlledDataReceived(protocol: Protocol, addr: Address) {
    const selected = this.host.selected();
    const sameAddress = (pair: CandidatePair) =>
      pair.protocol === protocol &&
      pair.remoteAddr[0] === addr[0] &&
      pair.remoteAddr[1] === addr[1];
    const pair =
      selected && sameAddress(selected)
        ? selected
        : this.host.checkList().find(sameAddress);
    if (!pair) return;
    this.lastData.set(pair, ++this.dataSequence);
    if (
      pair !== selected &&
      pair.nominated &&
      pair.state === CandidatePairState.SUCCEEDED &&
      !this.host.isTcpPair(pair) &&
      this.replaces(pair)
    ) {
      this.host.complete(pair);
    }
  }

  /**
   * Semi-aggressive nomination and renomination: nominate the best valid
   * pair with a separate check when it outranks the selection (or nothing is
   * selected yet) and no check of it nominated it already. With renomination
   * ordinary checks never nominate; with semi-aggressive nomination a pair
   * whose check went without USE-CANDIDATE (sent while controlled) still
   * needs one. One such check at a time; its outcome re-evaluates.
   */
  evaluate() {
    if (!this.host.replacesSelection() || this.inFlight || this.host.closed()) {
      return;
    }
    const renomination = this.host.usesRenomination();
    const best = this.host.bestValidPair(
      this.host
        .checkList()
        .filter((pair) => this.host.replacesWith(pair) && this.allows(pair)),
    );
    const selected = this.host.selected();
    if (!best || best === selected) return;
    if (selected && !this.host.outranks(best, selected)) return;
    // Semi-aggressive: the USE-CANDIDATE check that succeeded selected it.
    if (!renomination && best.nominated) return;
    void this.nominateSelection(best, renomination);
  }

  /**
   * Failover (controlling): nominate `pair` now (USE-CANDIDATE, or the next
   * NOMINATION value), whatever its priority; its success moves the
   * selection (`replaces` with `failoverReplaces`).
   */
  nominate(pair: CandidatePair) {
    if (this.inFlight || this.host.closed()) return;
    void this.nominateSelection(pair, this.host.usesRenomination());
  }

  private allows(pair: CandidatePair) {
    return this.host.allows?.(pair) ?? true;
  }

  private async nominateSelection(pair: CandidatePair, renomination: boolean) {
    const current = { pair, abort: new AbortController() };
    this.inFlight = current;
    const value = renomination ? ++this.nominationValue : undefined;
    const remoteGeneration = this.host.remoteGeneration();
    log("nominate selection", pair.toJSON(), { nomination: value });
    const outcome = await this.host.sendNomination(
      pair,
      current.abort.signal,
      value,
    );
    // A role change, restart or close replaced it.
    if (this.inFlight !== current) return;
    this.inFlight = undefined;
    if (this.host.isStaleNomination(pair, remoteGeneration)) {
      this.host.nominationEnded?.(pair);
      return;
    }
    if (outcome === "nominated") {
      if (value !== undefined) pair.nomination = value;
      pair.nominated = true;
      this.host.complete(pair);
      this.host.nominationEnded?.(pair);
      return;
    }
    this.host.nominationEnded?.(pair);
    if (outcome === "role-conflict") {
      // 487: the peer is controlling and wins; it nominates.
      this.host.roleConflict();
      return;
    }
    // Not taken (an error, or no answer): the pair is not used and the next
    // best valid pair is considered (checkComplete re-evaluates).
    log("selection nomination failed", pair.toJSON(), outcome);
    pair.updateState(CandidatePairState.FAILED);
    this.host.complete(pair);
  }

  abort() {
    const inFlight = this.inFlight;
    inFlight?.abort.abort();
    this.inFlight = undefined;
    if (inFlight) this.host.nominationEnded?.(inFlight.pair);
  }

  /**
   * After the first selection (semi-aggressive nomination, renomination):
   * check the pairs that outrank the selected one, paced like the ordinary
   * schedule. A pair added later that outranks it (a trickled candidate, a
   * late relay allocation) restarts it (`addPair`).
   */
  async checkOutrankingPairs() {
    if (this.outrankingChecks) return;
    this.outrankingChecks = true;
    const remoteGeneration = this.host.remoteGeneration();
    try {
      for (;;) {
        const selected = this.host.selected();
        if (
          !selected ||
          this.host.closed() ||
          this.host.remoteGeneration() !== remoteGeneration ||
          !this.host.controlling() ||
          !this.host.replacesSelection()
        ) {
          return;
        }
        const pair = this.host
          .checkList()
          .find(
            (pair) =>
              (pair.state === CandidatePairState.WAITING ||
                pair.state === CandidatePairState.FROZEN) &&
              this.host.replacesWith(pair) &&
              this.host.outranks(pair, selected) &&
              this.allows(pair),
          );
        if (!pair) return;
        this.host.check(pair);
        await timers.setTimeout(20);
      }
    } finally {
      this.outrankingChecks = false;
    }
  }

  private readonly host: SelectionHost;

  constructor(host: SelectionHost) {
    this.host = host;
  }

  /** A nominating check of `evaluate` is in flight. */
  get nominating() {
    return this.inFlight !== undefined;
  }

  /** The next NOMINATION value (renomination); it only increases. */
  nextNominationValue() {
    return ++this.nominationValue;
  }
}
