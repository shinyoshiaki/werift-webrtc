import {
  kDefaultStartBitrateBps,
  kLossDecreaseThreshold,
  kLossIncreaseFactor,
  kLossIncreaseThreshold,
  kMaxBitrateBps,
  kMinBitrateBps,
} from "./constants";

/**
 * Loss-based bandwidth estimate As_hat (draft-ietf-rmcat-gcc-02 §6).
 *
 * - loss < 2%: As *= 1.05
 * - 2% ≤ loss ≤ 10%: hold
 * - loss > 10%: As *= (1 - 0.5 * p)
 */
export class LossBasedBwe {
  private bitrateBps = kDefaultStartBitrateBps;

  reset(startBps = kDefaultStartBitrateBps) {
    this.bitrateBps = clamp(startBps);
  }

  get targetBitrateBps() {
    return this.bitrateBps;
  }

  /**
   * Seed / raise floor from delay-based estimate when loss controller is cold.
   */
  setBitrateIfHigher(bps: number) {
    if (bps > this.bitrateBps) {
      this.bitrateBps = clamp(bps);
    }
  }

  /**
   * @param lossFraction fraction of packets lost in the feedback window [0, 1]
   * @param delayBasedBps latest delay-based A_hat (used as a soft upper reference)
   */
  update(lossFraction: number, delayBasedBps: number): number {
    const p = Math.min(Math.max(lossFraction, 0), 1);

    if (p < kLossIncreaseThreshold) {
      this.bitrateBps = this.bitrateBps * kLossIncreaseFactor;
      // When increasing with low loss, track at least the delay-based floor so
      // As_hat is not stuck far below A_hat after a previous decrease.
      if (delayBasedBps > this.bitrateBps) {
        this.bitrateBps = delayBasedBps;
      }
    } else if (p > kLossDecreaseThreshold) {
      this.bitrateBps = this.bitrateBps * (1 - 0.5 * p);
    }
    // else hold (2%–10% loss)

    this.bitrateBps = clamp(this.bitrateBps);
    return this.bitrateBps;
  }
}

function clamp(bps: number) {
  return Math.min(Math.max(Math.round(bps), kMinBitrateBps), kMaxBitrateBps);
}
