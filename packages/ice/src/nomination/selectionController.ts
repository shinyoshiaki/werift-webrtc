import { notReceivingSince, type PairLiveness } from "../failover";
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
   * When (ms) to decide again while a receiving switch is held back
   * (libwebrtc's recheck event).
   * @see tests/ice/selection-controller.test.ts "a pair that wins only by receiving waits RECEIVING_SWITCHING_DELAY and asks for a recheck"
   */
  recheckAt?: number;
};

export { notReceivingSince };

/**
 * Whether the controlling agent moves the selection from `selected` to
 * `candidate` (`priority` > 0: `candidate` outranks it), as libwebrtc's
 * `BasicIceController::ShouldSwitchConnection`: writable, receiving (held for
 * `RECEIVING_SWITCHING_DELAY`), priority, then the smoothed RTT. The network
 * cost libwebrtc compares before the priority is unknown in Node.js.
 * @see tests/ice/selection-controller.test.ts "state comes before priority and priority before RTT"
 * @see tests/ice/selection-controller.test.ts "a pair that wins only by receiving waits RECEIVING_SWITCHING_DELAY and asks for a recheck"
 * @see tests/ice/selection-controller.test.ts "silence alone (no unanswered check) is not 'not receiving'; a receiving selection beats a pair that is not"
 * @see tests/ice/selection-controller.test.ts "a late unanswered check starts the hold at the check, and a recovery in the hold keeps the selection"
 * @see tests/ice/selection-controller.test.ts "equal priority: moves only to a pair whose smoothed RTT is at least 10 ms lower"
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
 * The controlling agent's moves of the selected pair by receiving state and
 * RTT (`shouldSwitch`), as libwebrtc's ICE controller.
 * @see tests/ice/selection-controller.test.ts "equal priority: the selection moves to the pair whose RTT is 11 ms lower, nominating it"
 * @see tests/ice/selection-controller.test.ts "receiving: a selection that recovers within RECEIVING_SWITCHING_DELAY stays; one that does not moves after it"
 * @see tests/ice/selection-controller.test.ts "the hold is counted from the unanswered check: no switch right after it, the recheck at its end switches"
 * @see tests/ice/selection-controller.test.ts "controlled: the agent does not switch by RTT itself (it follows the peer's nominations)"
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

    let best:
      | { pair: CandidatePair; reason: "receiving" | "rtt"; receiving: boolean }
      | undefined;
    let recheckAt: number | undefined;
    for (const pair of this.host.candidates()) {
      if (pair === selected || !this.host.allows(pair)) continue;
      const liveness = this.host.liveness(pair);
      if (!liveness) continue;
      const candidateState: SwitchPairState = {
        writable: this.host.writable(pair, now),
        lastReceived: liveness.lastReceived,
        missedSince: liveness.missedSince,
        rtt: pair.smoothedRtt,
      };
      const decision = shouldSwitch({
        selected: selectedState,
        candidate: candidateState,
        priority: this.host.comparePriority(pair, selected),
        now,
        receivingTimeout: thresholds?.receivingTimeout,
        receivingSwitchingDelay: thresholds?.receivingSwitchingDelay,
      });
      if (decision.recheckAt !== undefined) {
        recheckAt = Math.min(recheckAt ?? Infinity, decision.recheckAt);
      }
      // Test: tests/ice/selection-controller.test.ts "a backup that wins by priority or over an unwritable selection is left to SelectionReplacement and the failover"
      const reason = decision.reason;
      if (reason !== "receiving" && reason !== "rtt") continue;
      const receiving =
        notReceivingSince(candidateState, now, thresholds?.receivingTimeout) ===
        undefined;
      if (!best || this.betterTarget({ pair, receiving }, best)) {
        best = { pair, reason, receiving };
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

  /**
   * Whether `a` is a better target than `b`: receiving, priority, then RTT.
   * @see tests/ice/selection-controller.test.ts "a receiving backup of lower priority wins over a silent one of equal priority and lower RTT"
   * @see tests/ice/selection-controller.test.ts "among receiving backups the higher priority wins, then the lower RTT"
   */
  private betterTarget(
    a: { pair: CandidatePair; receiving: boolean },
    b: { pair: CandidatePair; receiving: boolean },
  ) {
    if (a.receiving !== b.receiving) return a.receiving;
    const priority = this.host.comparePriority(a.pair, b.pair);
    if (priority !== 0) return priority > 0;
    return (a.pair.smoothedRtt ?? Infinity) < (b.pair.smoothedRtt ?? Infinity);
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
