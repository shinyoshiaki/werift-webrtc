import type { PairLiveness } from "../failover";
import {
  type CandidatePair,
  RECEIVING_SWITCHING_DELAY,
  RTT_SWITCH_MIN_IMPROVEMENT,
  WEAK_CONNECTION_RECEIVE_TIMEOUT,
} from "../iceBase";
import { debug } from "../imports/common";

const log = debug(
  "werift-ice : packages/ice/src/nomination/selectionController.ts : log",
);

/** What `shouldSwitch` knows about a pair. */
export type SwitchPairState = {
  /** A response to a check came back and the pair is not unwritable (`isWritable`). */
  writable: boolean;
  /** The last response, request or application data received on the pair (ms). */
  lastReceived: number;
  /**
   * When the first of the consecutive unanswered checks of the pair was
   * counted (ms, `PairLiveness.missedSince`); undefined while its last check
   * was answered.
   */
  missedSince?: number;
  /** The smoothed RTT (seconds, `CandidatePair.smoothedRtt`); undefined: not known yet. */
  rtt?: number;
};

/**
 * Why a pair wins over the selected one (`shouldSwitch`):
 * - `writable`: the selection is not writable;
 * - `receiving`: the selection has not been receiving for
 *   `RECEIVING_SWITCHING_DELAY`, the pair is receiving;
 * - `priority`: the pair outranks the selection;
 * - `rtt`: equal otherwise, the pair's smoothed RTT is at least
 *   `RTT_SWITCH_MIN_IMPROVEMENT` lower.
 */
export type SwitchReason = "writable" | "receiving" | "priority" | "rtt";

export type SwitchDecision = {
  /** The pair wins over the selection; undefined: the selection stays. */
  reason?: SwitchReason;
  /**
   * The decision may change at this time (ms) without anything being
   * received: the selection's receiving state decided nothing yet because it
   * changed less than `RECEIVING_SWITCHING_DELAY` ago (libwebrtc's recheck
   * event).
   */
  recheckAt?: number;
};

/**
 * Since when (ms) `pair` has not been receiving, undefined while it is: it
 * received nothing for WEAK_CONNECTION_RECEIVE_TIMEOUT (as libwebrtc's
 * `Connection::receiving`) and a check sent to it went unanswered.
 *
 * libwebrtc pings a weak selection every 48 ms, so a silence that long
 * means its pings went unanswered. werift checks the selected pair only
 * when the silence begins (consent, `nextPingAt`) and 900 ms after a check
 * that went unanswered; without the unanswered check, a pair whose check
 * is merely still in flight (or not sent yet: the first consent check comes
 * at the consent interval) would count as not receiving.
 */
export const notReceivingSince = (
  pair: SwitchPairState,
  now: number,
  receivingTimeout = WEAK_CONNECTION_RECEIVE_TIMEOUT,
) => {
  const silentSince = pair.lastReceived + receivingTimeout;
  if (now < silentSince || pair.missedSince === undefined) return undefined;
  return silentSince;
};

/**
 * Whether the controlling agent moves the selection from `selected` to
 * `candidate`, as libwebrtc's `BasicIceController::ShouldSwitchConnection`
 * (`CompareConnectionStates`, then `CompareConnectionCandidates`, then RTT):
 *
 * 1. a pair that is not writable is never switched to;
 * 2. a writable pair wins over a selection that is not;
 * 3. a receiving selection wins over a pair that is not receiving
 *    (`notReceivingSince`); a pair
 *    that is receiving wins over a selection that is not only once the
 *    selection has not been receiving for `RECEIVING_SWITCHING_DELAY`
 *    (before that the decision falls through and `recheckAt` says when to
 *    decide again; a selection that received something meanwhile stays);
 * 4. the higher priority wins (`priority`: > 0 when `candidate` outranks
 *    `selected`);
 * 5. at equal priority the pair wins only when its smoothed RTT is at least
 *    `RTT_SWITCH_MIN_IMPROVEMENT` lower.
 *
 * The network cost libwebrtc compares before the priority is unknown in
 * Node.js and is left out.
 */
export function shouldSwitch({
  selected,
  candidate,
  priority,
  now,
  receivingSwitchingDelay = RECEIVING_SWITCHING_DELAY,
  receivingTimeout = WEAK_CONNECTION_RECEIVE_TIMEOUT,
  minRttImprovement = RTT_SWITCH_MIN_IMPROVEMENT,
}: {
  selected: SwitchPairState;
  candidate: SwitchPairState;
  priority: number;
  now: number;
  receivingSwitchingDelay?: number;
  receivingTimeout?: number;
  minRttImprovement?: number;
}): SwitchDecision {
  if (!candidate.writable) return {};
  if (!selected.writable) return { reason: "writable" };

  let recheckAt: number | undefined;
  const selectedSince = notReceivingSince(selected, now, receivingTimeout);
  const candidateSince = notReceivingSince(candidate, now, receivingTimeout);
  if (selectedSince === undefined && candidateSince !== undefined) return {};
  if (selectedSince !== undefined && candidateSince === undefined) {
    if (now - selectedSince >= receivingSwitchingDelay) {
      return { reason: "receiving" };
    }
    recheckAt = selectedSince + receivingSwitchingDelay;
  }

  if (priority > 0) return { reason: "priority", recheckAt };
  if (priority < 0) return { recheckAt };

  if (
    candidate.rtt !== undefined &&
    selected.rtt !== undefined &&
    candidate.rtt * 1000 <= selected.rtt * 1000 - minRttImprovement
  ) {
    return { reason: "rtt", recheckAt };
  }
  return { recheckAt };
}

/** What the agent supplies to its `SelectionController`. */
export type SelectionControllerHost = {
  /**
   * The controller applies now: a controlling full agent with
   * semi-aggressive nomination or renomination within the failover scope,
   * a selection that is up (failover handles one that stopped answering)
   * and no nominating check in flight.
   */
  active: () => boolean;
  selected: () => CandidatePair | undefined;
  /** The pairs the selection may move to (the monitored backups). */
  candidates: () => readonly CandidatePair[];
  /** The liveness the failover monitor keeps for `pair`. */
  liveness: (pair: CandidatePair) => PairLiveness | undefined;
  writable: (pair: CandidatePair, now: number) => boolean;
  /** `IceOptions.failover` thresholds (`receivingTimeout`, `receivingSwitchingDelay`). */
  thresholds?: () => {
    receivingTimeout: number;
    receivingSwitchingDelay: number;
  };
  /** `pair` may be nominated (not on a path the agent failed over from). */
  allows: (pair: CandidatePair) => boolean;
  /** > 0 when `pair` outranks `other` (pair priority). */
  comparePriority: (pair: CandidatePair, other: CandidatePair) => number;
  /** Nominate `pair` to replace the selection for `reason`. */
  switchTo: (pair: CandidatePair, reason: "receiving" | "rtt") => void;
};

/**
 * The controlling agent's choice of the selected pair after the first one
 * (semi-aggressive nomination, renomination), as libwebrtc's ICE controller:
 * besides the moves to a higher-priority pair (`SelectionReplacement`) and
 * the failover from a pair that stopped answering (`FailoverMonitor`), the
 * selection moves to a monitored backup that is receiving while it is not
 * (after `RECEIVING_SWITCHING_DELAY`), or to one of equal priority whose
 * smoothed RTT is `RTT_SWITCH_MIN_IMPROVEMENT` lower (`shouldSwitch`).
 *
 * `evaluate()` runs whenever the outcome may change: a check, consent check
 * or backup check answered or went unanswered (RTT, receiving), and at the
 * recheck time of a decision held back by `RECEIVING_SWITCHING_DELAY`.
 */
export class SelectionController {
  private recheck?: { at: number; timer: ReturnType<typeof setTimeout> };
  private readonly host: SelectionControllerHost;

  constructor(host: SelectionControllerHost) {
    this.host = host;
  }

  /** Decide whether the selection moves, and nominate the pair it moves to. */
  evaluate() {
    this.clearRecheck();
    if (!this.host.active()) return;
    const selected = this.host.selected();
    if (!selected) return;
    const selectedLiveness = this.host.liveness(selected);
    if (!selectedLiveness) return;
    const now = Date.now();
    const thresholds = this.host.thresholds?.();
    const selectedState: SwitchPairState = {
      writable: this.host.writable(selected, now),
      lastReceived: selectedLiveness.lastReceived,
      missedSince: selectedLiveness.missedSince,
      rtt: selected.smoothedRtt,
    };

    let best: { pair: CandidatePair; reason: "receiving" | "rtt" } | undefined;
    let recheckAt: number | undefined;
    for (const pair of this.host.candidates()) {
      if (pair === selected || !this.host.allows(pair)) continue;
      const liveness = this.host.liveness(pair);
      if (!liveness) continue;
      const decision = shouldSwitch({
        selected: selectedState,
        candidate: {
          writable: this.host.writable(pair, now),
          lastReceived: liveness.lastReceived,
          missedSince: liveness.missedSince,
          rtt: pair.smoothedRtt,
        },
        priority: this.host.comparePriority(pair, selected),
        now,
        receivingTimeout: thresholds?.receivingTimeout,
        receivingSwitchingDelay: thresholds?.receivingSwitchingDelay,
      });
      if (decision.recheckAt !== undefined) {
        recheckAt = Math.min(recheckAt ?? Infinity, decision.recheckAt);
      }
      // A writable pair over an unwritable selection is the failover's, a
      // higher-priority one `SelectionReplacement`'s.
      const reason = decision.reason;
      if (reason !== "receiving" && reason !== "rtt") continue;
      if (!best || this.betterTarget(pair, best.pair)) {
        best = { pair, reason };
      }
    }
    if (best) {
      log("switch selection", best.reason, best.pair.toJSON(), {
        selected: selected.toJSON(),
        rtt: best.pair.smoothedRtt,
        selectedRtt: selected.smoothedRtt,
      });
      this.host.switchTo(best.pair, best.reason);
      return;
    }
    if (recheckAt !== undefined) this.scheduleRecheck(recheckAt);
  }

  /** Stop the pending recheck (restart, close, the failover monitor reset). */
  stop() {
    this.clearRecheck();
  }

  /** Between two pairs the selection may move to: the higher priority, then the lower RTT. */
  private betterTarget(pair: CandidatePair, other: CandidatePair) {
    const priority = this.host.comparePriority(pair, other);
    if (priority !== 0) return priority > 0;
    return (pair.smoothedRtt ?? Infinity) < (other.smoothedRtt ?? Infinity);
  }

  private scheduleRecheck(at: number) {
    this.recheck = {
      at,
      timer: setTimeout(
        () => {
          this.recheck = undefined;
          this.evaluate();
        },
        Math.max(0, at - Date.now()),
      ),
    };
  }

  private clearRecheck() {
    if (this.recheck) clearTimeout(this.recheck.timer);
    this.recheck = undefined;
  }
}
