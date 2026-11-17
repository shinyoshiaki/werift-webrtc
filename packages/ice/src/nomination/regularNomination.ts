import { type CandidatePair, CandidatePairState } from "../iceBase";
import { debug } from "../imports/common";
import type { Protocol } from "../types/model";

const log = debug(
  "werift-ice : packages/ice/src/nomination/regularNomination.ts : log",
);

/** Default of `IceOptions.nominationDelayMs`. */
export const DEFAULT_NOMINATION_DELAY_MS = 300;
/**
 * USE-CANDIDATE transactions sent for one pair before an unanswered
 * nomination gives up (each one retransmits as a check does).
 */
export const NOMINATION_ATTEMPTS = 3;
/**
 * Check-list result: an unanswered nomination was abandoned. Unlike
 * ICE_FAILED (which connect() keeps waiting past, as more candidates may
 * still pair), it ends connect() with an error.
 */
export const ICE_NOMINATION_ABANDONED = 3;
/**
 * How long, from the start of its checks, the live checklist waits for the pair
 * a provisional nomination may have selected (`NominationHint`) to appear.
 * It can appear after end-of-candidates: a peer-reflexive or passive TCP
 * pair forms only when the peer's check arrives. Covers the peer's check
 * pacing and a TCP check's response timeout (`TCP_CHECK_RESPONSE_TIMEOUT_MS`).
 */
export const PREFERRED_PAIR_WAIT_MS = 3000;

export type NominationDecision =
  | { action: "nominate"; pair: CandidatePair }
  | { action: "wait"; deadline: number }
  /** The pair the peer may have selected cannot be nominated: nominate nothing else. */
  | { action: "abandon"; pair?: CandidatePair }
  | { action: "none" };

/**
 * RFC 8445 §8.1.1 regular nomination: when the controlling agent stops
 * checking and nominates, shared by the live and the provisional checklist.
 *
 * - With a `preferred` rule (the peer may have selected that path already,
 *   see `NominationHint`), only the matching pair may be nominated: as soon
 *   as it is valid, waited for while its check runs. When it fails, or is not
 *   in the checklist `PREFERRED_PAIR_WAIT_MS` (at least the delay) after the
 *   checklist began, even after end-of-candidates or with no other valid
 *   pair, the nomination is
 *   abandoned (as an unanswered one is):
 *   nominating another pair could leave the agents on different paths.
 * - The candidate is the first valid (Succeeded) pair of `pairs` (priority
 *   order, highest first), so the choice is deterministic.
 * - Nominate at once when both sides signalled end-of-candidates and no
 *   higher-priority pair can still succeed.
 * - Otherwise wait until `quietSince + delayMs`, then nominate anyway: a
 *   higher-priority pair still in progress (an unreachable host pair takes
 *   seconds to fail) or a peer that never signals end-of-candidates must not
 *   hold the selection back longer than that.
 */
export const decideNomination = ({
  pairs,
  remoteCandidatesEnd,
  localCandidatesEnd,
  quietSince,
  delayMs,
  now,
  unchecked,
  preferred,
  preferredSince,
}: {
  pairs: readonly CandidatePair[];
  remoteCandidatesEnd: boolean;
  localCandidatesEnd: boolean;
  quietSince: number | undefined;
  delayMs: number;
  now: number;
  /** Pairs never checked locally, which cannot be waited for. */
  unchecked: (pair: CandidatePair) => boolean;
  preferred: ((pair: CandidatePair) => boolean) | undefined;
  /** When the checklist began waiting for the `preferred` pair. */
  preferredSince: number | undefined;
}): NominationDecision => {
  if (preferred) {
    const hinted = pairs.find(preferred);
    if (hinted?.state === CandidatePairState.SUCCEEDED) {
      return { action: "nominate", pair: hinted };
    }
    if (hinted) {
      if (hinted.state === CandidatePairState.FAILED || unchecked(hinted)) {
        return { action: "abandon", pair: hinted };
      }
      // Its check finishing re-evaluates the nomination.
      return { action: "none" };
    }
    // Not (yet) in the checklist. End-of-candidates does not settle it, nor
    // does an empty checklist: a peer-reflexive pair (or a passive TCP one) is
    // only formed when the peer's check arrives, so wait for it a bounded time
    // from when the checklist began.
    const deadline =
      (preferredSince ?? now) + Math.max(delayMs, PREFERRED_PAIR_WAIT_MS);
    if (now >= deadline) return { action: "abandon" };
    return { action: "wait", deadline };
  }
  const index = pairs.findIndex(
    (pair) => pair.state === CandidatePairState.SUCCEEDED,
  );
  if (index === -1) return { action: "none" };
  const pair = pairs[index];
  const pendingAbove = pairs
    .slice(0, index)
    .some(
      (above) => above.state !== CandidatePairState.FAILED && !unchecked(above),
    );
  if (remoteCandidatesEnd && localCandidatesEnd && !pendingAbove) {
    return { action: "nominate", pair };
  }
  const deadline = (quietSince ?? now) + delayMs;
  if (now >= deadline) return { action: "nominate", pair };
  return { action: "wait", deadline };
};

/** What a USE-CANDIDATE check came back with. */
export type NominationOutcome =
  /** Answered with success. */
  | "nominated"
  /** Timed out: the request may have reached the peer, which may have selected the pair. */
  | "unanswered"
  /** An error response, or the request never left (e.g. a refused TCP connect). */
  | "rejected"
  /** 487: the peer is controlling too and wins (RFC 8445 §7.2.5.1). */
  | "role-conflict";

/** What a checklist (live or provisional) supplies to its `RegularNomination`. */
export type NominationHost = {
  /** The controlling agent nominates in this checklist now (full ICE on both sides, nothing nominated yet, the checklist still current). */
  active: () => boolean;
  /** The checklist's checks began (connect(), startProvisionalChecks()). */
  checking: () => boolean;
  /** The checklist, highest priority first. */
  pairs: () => readonly CandidatePair[];
  remoteCandidatesEnd: () => boolean;
  localCandidatesEnd: () => boolean;
  delayMs: () => number;
  /** Pairs never checked locally (forceTurn), which cannot be waited for. */
  unchecked: (pair: CandidatePair) => boolean;
  outranks: (pair: CandidatePair, other: CandidatePair) => boolean;
  /** Matches the only pair that may be nominated: the peer may have selected it already (see `NominationHint`). */
  preferred: () => ((pair: CandidatePair) => boolean) | undefined;
  /** A result for `pair` still applies: the pair is in the checklist and the agent open. */
  owns: (pair: CandidatePair) => boolean;
  /** Send the USE-CANDIDATE check; never rejects. */
  send: (
    pair: CandidatePair,
    signal: AbortSignal,
  ) => Promise<NominationOutcome>;
  nominated: (pair: CandidatePair) => void;
  /** The peer refused the pair: fail it, so the next valid pair is nominated. */
  rejected: (pair: CandidatePair) => void;
  roleConflict: (pair: CandidatePair) => void;
  /**
   * No attempt on a pair the peer may have selected was answered, or that
   * pair (the hint) failed or never appeared (`pair` undefined).
   */
  abandoned: (pair?: CandidatePair) => void;
  /** The delay ended (after the re-evaluation it triggers). */
  deadlinePassed?: () => void;
};

/**
 * The regular nomination (RFC 8445 §8.1.1) of one checklist: the single
 * state and rule set the live checklist and the provisional (ICE-restart)
 * checklist share. It holds the delay, the USE-CANDIDATE attempt in flight,
 * its repeats and the abandoned state; the checklist supplies the pairs and
 * applies the outcome (`NominationHost`).
 *
 * - Delay: `quietSince` is the first valid pair, moved forward by every pair
 *   added later that outranks the best valid pair and is checked locally
 *   (a forceTurn-excluded pair cannot replace it and does not count).
 * - One attempt at a time; a result whose attempt is no longer current (a
 *   restart, a replacement pranswer, close or a role change replaced it) is
 *   ignored and its transaction aborted.
 * - An unanswered attempt may have been accepted: it is repeated on the same
 *   pair (never another), also when a repeat is answered with an error. When
 *   all `NOMINATION_ATTEMPTS` go unanswered nothing else is nominated.
 * - An error answering the first attempt: only that pair fails.
 */
export class RegularNomination {
  private quietSince?: number;
  /** The checklist began waiting for the preferred pair (see `decideNomination`). */
  private preferredSince?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private attempt?: { pair: CandidatePair; abort: AbortController };
  /** Every attempt went unanswered: no other pair is nominated until reset. */
  abandoned = false;
  /**
   * The pair a USE-CANDIDATE was sent to and the peer did not refuse: the
   * peer may have selected it (the provisional checklist hands it to the
   * live one at the final answer, see `NominationHint`).
   */
  maybeSelected?: CandidatePair;

  private readonly host: NominationHost;

  constructor(host: NominationHost) {
    this.host = host;
  }

  /** A USE-CANDIDATE transaction is in flight. */
  get inFlight() {
    return this.attempt !== undefined;
  }

  /** Waiting for the delay to end. */
  get waiting() {
    return this.timer !== undefined;
  }

  /** `pair` joined the checklist; `best` was its best valid pair before. */
  pairAdded(pair: CandidatePair, best: CandidatePair | undefined) {
    // A pair that may replace the best valid pair restarts the delay; a
    // lower-priority one, or one the agent never checks, cannot change the
    // choice and does not.
    if (best && !this.host.unchecked(pair) && this.host.outranks(pair, best)) {
      this.quietSince = Date.now();
      this.evaluate();
    }
  }

  /**
   * Nominate now, or arm the timer that re-evaluates at the deadline. Called
   * whenever the answer may change: a check finished, a pair was added,
   * end-of-candidates, the role changed, the timer fired.
   */
  evaluate() {
    if (!this.host.active() || this.attempt || this.abandoned) {
      this.stop();
      return;
    }
    const pairs = this.host.pairs();
    const now = Date.now();
    if (
      this.quietSince === undefined &&
      pairs.some((pair) => pair.state === CandidatePairState.SUCCEEDED)
    ) {
      this.quietSince = now;
    }
    const preferred = this.host.preferred();
    if (
      preferred &&
      this.preferredSince === undefined &&
      this.host.checking()
    ) {
      this.preferredSince = now;
    }
    const decision = decideNomination({
      pairs,
      remoteCandidatesEnd: this.host.remoteCandidatesEnd(),
      localCandidatesEnd: this.host.localCandidatesEnd(),
      quietSince: this.quietSince,
      delayMs: this.host.delayMs(),
      now,
      unchecked: this.host.unchecked,
      preferred,
      preferredSince: this.preferredSince,
    });
    this.stop();
    if (decision.action === "wait") {
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          this.evaluate();
          this.host.deadlinePassed?.();
        },
        Math.max(0, decision.deadline - now),
      );
    } else if (decision.action === "nominate") {
      this.nominate(decision.pair, 1, false);
    } else if (decision.action === "abandon") {
      log("preferred pair cannot be nominated, giving up");
      this.abandoned = true;
      this.host.abandoned(decision.pair);
    }
  }

  /** Stop waiting (a pair was nominated, or nomination is not possible now). */
  stop() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** The role changed: the attempt in flight was sent as the controlling agent and changes nothing after it. */
  invalidate() {
    this.attempt?.abort.abort();
    this.attempt = undefined;
    this.abandoned = false;
  }

  /** The checklist starts over (restart, replacement pranswer, renomination, close). */
  reset() {
    this.invalidate();
    this.stop();
    this.quietSince = undefined;
    this.preferredSince = undefined;
    this.maybeSelected = undefined;
  }

  /**
   * @param maybeAccepted an earlier attempt for `pair` went unanswered: the
   *   peer may have selected the pair already, so no later outcome lets the
   *   nomination move to another pair.
   */
  private nominate(
    pair: CandidatePair,
    attempt: number,
    maybeAccepted: boolean,
  ) {
    log("nominate", pair.toJSON(), { attempt, maybeAccepted });
    const current = { pair, abort: new AbortController() };
    this.attempt = current;
    this.maybeSelected = pair;
    void this.host.send(pair, current.abort.signal).then((outcome) => {
      if (this.attempt !== current) return;
      this.attempt = undefined;
      if (!this.host.owns(pair)) {
        // The pair left the checklist (another remote generation dropped).
        if (this.maybeSelected === pair) this.maybeSelected = undefined;
        this.evaluate();
        return;
      }
      if (outcome === "nominated") {
        this.stop();
        this.host.nominated(pair);
        return;
      }
      if (outcome === "role-conflict") {
        // The peer did not accept it as controlled; it nominates now.
        log("nomination role conflict", pair.toJSON());
        if (!maybeAccepted) this.maybeSelected = undefined;
        this.host.roleConflict(pair);
        return;
      }
      if (outcome === "unanswered" || maybeAccepted) {
        if (attempt < NOMINATION_ATTEMPTS) {
          log("nomination unanswered, repeating", pair.toJSON(), { attempt });
          this.nominate(pair, attempt + 1, true);
          return;
        }
        log("nomination unanswered, giving up", pair.toJSON());
        this.abandoned = true;
        this.stop();
        this.host.abandoned(pair);
        return;
      }
      log("nomination rejected", pair.toJSON());
      this.maybeSelected = undefined;
      this.host.rejected(pair);
    });
  }
}

/**
 * The pair the controlling agent may have nominated in the provisional
 * checklist when a final answer replaced it with the live one. The peer
 * may have selected that pair already: a USE-CANDIDATE retransmission can
 * reach its live checklist (same credentials) after it committed the
 * answer, and a peer that keeps the ICE session across pranswer -> answer
 * (JSEP) keeps its provisional selection. The live checklist checks from
 * scratch (`[2.7-T4a]`) but nominates only the pair with the same 5-tuple;
 * when that pair fails or never appears it nominates nothing else and the
 * agent fails (see `decideNomination`). It only applies while the live
 * checklist uses the provisional credentials and the agent keeps the pair's
 * local socket (`protocol`); otherwise the usual rules choose the pair.
 */
export type NominationHint = {
  localUsername: string;
  remoteUsername: string;
  remotePassword: string;
  key: string;
  /**
   * The local socket (or TURN allocation) of the pair. The hint holds only
   * while the agent keeps it: a commit that closes it (an ICE restart
   * allocates TURN afresh, gather options that exclude the socket) ends the
   * path for both agents, so no selection of the peer is left to match.
   */
  protocol: Protocol;
};

/** Local foundation and the 5-tuple: the same path in another checklist. */
export const pairKey = (pair: CandidatePair) =>
  [
    pair.localCandidate.foundation,
    pair.localCandidate.transport.toLowerCase(),
    pair.localCandidate.host,
    pair.localCandidate.port,
    pair.remoteCandidate.transport.toLowerCase(),
    pair.remoteCandidate.host,
    pair.remoteCandidate.port,
  ].join(" ");
