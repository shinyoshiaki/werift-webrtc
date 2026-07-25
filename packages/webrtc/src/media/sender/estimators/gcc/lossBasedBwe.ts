import {
  kDefaultStartBitrateBps,
  kLossBasedBackoffFactor,
  kLossBasedIncreaseFactor,
  kLossDecreaseThreshold,
  kLossIncreaseThreshold,
  kMaxBitrateBps,
  kMinBitrateBps,
} from "./constants";

/**
 * Loss-based BWE state (libwebrtc goog_cc loss path intent).
 *
 * Aligns with the operational thresholds used in Chromium send-side BWE:
 * - low loss → increase toward / with delay-based estimate
 * - medium loss → hold (balance inherent loss vs congestion)
 * - high loss → decrease from acknowledged throughput
 *
 * Not a full port of LossBasedBweV2 candidate enumeration; update rules and
 * constants follow the practical libwebrtc control response used with TWCC.
 */
export type LossBasedState =
  | "increasing"
  | "decreasing"
  | "delay_based"
  | "hold";

export class LossBasedBwe {
  private bitrateBps = kDefaultStartBitrateBps;
  private state: LossBasedState = "increasing";

  reset(startBps = kDefaultStartBitrateBps) {
    this.bitrateBps = clamp(startBps);
    this.state = "increasing";
  }

  get targetBitrateBps() {
    return this.bitrateBps;
  }

  get lossState(): LossBasedState {
    return this.state;
  }

  setBitrateIfHigher(bps: number) {
    if (bps > this.bitrateBps) {
      this.bitrateBps = clamp(bps);
    }
  }

  /**
   * @param lossFraction loss ratio over known sent sequences in [0, 1]
   * @param delayBasedBps delay-based A_hat
   * @param acknowledgedBps recent acked bitrate (TWCC-derived)
   */
  update(
    lossFraction: number,
    delayBasedBps: number,
    acknowledgedBps = 0,
  ): number {
    const p = Math.min(Math.max(lossFraction, 0), 1);
    const ack = acknowledgedBps > 0 ? acknowledgedBps : this.bitrateBps;

    if (p < kLossIncreaseThreshold) {
      // Low loss: push toward delay-based (or modest multiplicative growth).
      this.state = "increasing";
      const increased = Math.max(
        this.bitrateBps * kLossBasedIncreaseFactor,
        delayBasedBps > 0 ? delayBasedBps : this.bitrateBps,
      );
      this.bitrateBps = increased;
    } else if (p > kLossDecreaseThreshold) {
      // High loss: pull down from acknowledged rate (libwebrtc-style backoff).
      this.state = "decreasing";
      const decreased = ack * (1 - kLossBasedBackoffFactor * p);
      this.bitrateBps = Math.min(this.bitrateBps, decreased);
    } else {
      // Inherent / moderate loss band: hold estimate, prefer delay-based cap.
      this.state = "hold";
      if (delayBasedBps > 0) {
        this.bitrateBps = Math.min(this.bitrateBps, delayBasedBps * 1.05);
      }
    }

    if (
      delayBasedBps > 0 &&
      this.state !== "decreasing" &&
      Math.abs(this.bitrateBps - delayBasedBps) / delayBasedBps < 0.05
    ) {
      this.state = "delay_based";
    }

    this.bitrateBps = clamp(this.bitrateBps);
    return this.bitrateBps;
  }
}

function clamp(bps: number) {
  return Math.min(Math.max(Math.round(bps), kMinBitrateBps), kMaxBitrateBps);
}
