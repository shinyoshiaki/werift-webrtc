import { setTimeout } from "timers/promises";

import { milliTime } from "../../utils";

/** Longest single sleep of a send wait, so cancellation and rate changes are seen. */
const kSendWaitSliceMs = 100;

/**
 * Token bucket that paces **media** against the estimator's pacing rate
 * (pin `GetPacingRates`). Probe packets wait on
 * {@link waitForProbeSendTime} instead.
 */
export class MediaPacer {
  private budgetBytes = 0;
  private lastMs = 0;

  /** Forget leftover credit (estimator swap, new transport). */
  reset() {
    this.budgetBytes = 0;
    this.lastMs = 0;
  }

  /**
   * Wait until the bucket covers `packetBytes` at `rateBps`, then consume it.
   * Returns false (without consuming) when `alive()` turns false or
   * `signal()` aborts while waiting. A non-positive rate does not pace.
   *
   * @param signal Called for every sleep so a replaced abort controller is seen.
   */
  async acquire(
    packetBytes: number,
    rateBps: number,
    alive: () => boolean,
    signal: () => AbortSignal,
  ): Promise<boolean> {
    if (rateBps <= 0) {
      return true;
    }

    const now = milliTime();
    if (this.lastMs === 0) {
      this.lastMs = now;
      this.budgetBytes = 0;
    } else {
      this.refill(rateBps, now);
    }

    // Wait in a loop until the token bucket can cover this packet.
    // Cap accumulation so a single large packet is still eventually sendable.
    const maxBudget = Math.max((rateBps / 8) * 0.1, packetBytes);
    while (this.budgetBytes < packetBytes) {
      if (!alive()) return false;
      const need = packetBytes - this.budgetBytes;
      const waitMs = Math.max(1, Math.ceil((need * 8 * 1000) / rateBps));
      try {
        await setTimeout(Math.min(waitMs, kSendWaitSliceMs), undefined, {
          signal: signal(),
        });
      } catch {
        return false;
      }
      if (!alive()) return false;
      this.refill(rateBps, milliTime(), maxBudget);
    }

    this.budgetBytes -= packetBytes;
    return true;
  }

  private refill(
    rateBps: number,
    nowMs: number,
    maxBudget = (rateBps / 8) * 0.1,
  ) {
    const elapsedSec = Math.max(0, (nowMs - this.lastMs) / 1000);
    this.budgetBytes += elapsedSec * (rateBps / 8);
    if (this.budgetBytes > maxBudget) {
      this.budgetBytes = maxBudget;
    }
    this.lastMs = nowMs;
  }
}

/**
 * pin BitrateProber `next_probe_time` wait. MinusInfinity / past → send now.
 * Sleeps in ≤100ms slices until `nextSendTimeMs` (same cap as
 * {@link MediaPacer.acquire}), so a 5–15 kbps recovery probe is not
 * released 100ms early. Returns `alive()` when the wait ends.
 */
export async function waitForProbeSendTime(
  nextSendTimeMs: number,
  alive: () => boolean,
  signal: () => AbortSignal,
): Promise<boolean> {
  if (!Number.isFinite(nextSendTimeMs)) return alive();
  while (alive()) {
    const waitMs = nextSendTimeMs - milliTime();
    if (waitMs <= 0) return true;
    try {
      await setTimeout(Math.min(waitMs, kSendWaitSliceMs), undefined, {
        signal: signal(),
      });
    } catch {
      return alive();
    }
  }
  return alive();
}
