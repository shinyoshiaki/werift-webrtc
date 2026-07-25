import {
  kAdditiveIncreaseFactor,
  kBeta,
  kBitrateWindowMs,
  kDefaultRttMs,
  kDefaultStartBitrateBps,
  kMaxBitrateBps,
  kMinBitrateBps,
  kMultiplicativeIncreaseFactor,
  kReactionTimeMs,
} from "./constants";
import type { BandwidthUsage } from "./overuseDetector";

type RateControlState = "hold" | "increase" | "decrease";

/**
 * AIMD rate controller for the delay-based estimate A_hat (draft §5.5).
 */
export class AimdRateControl {
  private bitrateBps = kDefaultStartBitrateBps;
  private state: RateControlState = "increase";
  private lastUpdateMs = 0;
  private rttMs = kDefaultRttMs;
  private avgMaxBitrateKbps = -1;
  private varMaxBitrateKbps = 0.4;
  private inSlowStart = true;

  reset(startBps = kDefaultStartBitrateBps) {
    this.bitrateBps = clamp(startBps);
    this.state = "increase";
    this.lastUpdateMs = 0;
    this.rttMs = kDefaultRttMs;
    this.avgMaxBitrateKbps = -1;
    this.varMaxBitrateKbps = 0.4;
    this.inSlowStart = true;
  }

  setRtt(rttMs: number) {
    if (rttMs > 0) this.rttMs = rttMs;
  }

  get targetBitrateBps() {
    return this.bitrateBps;
  }

  get controlState(): RateControlState {
    return this.state;
  }

  /**
   * @param usage overuse detector state
   * @param acknowledgedBitrateBps measured incoming / acked bitrate R_hat
   * @param nowMs wall clock
   */
  update(
    usage: BandwidthUsage,
    acknowledgedBitrateBps: number,
    nowMs: number,
  ): number {
    if (this.lastUpdateMs === 0) {
      this.lastUpdateMs = nowMs;
    }

    this.changeState(usage);

    const timeSinceUpdateMs = Math.max(nowMs - this.lastUpdateMs, 0);
    if (this.state === "increase") {
      this.bitrateBps = this.increase(
        this.bitrateBps,
        acknowledgedBitrateBps,
        timeSinceUpdateMs,
      );
    } else if (this.state === "decrease") {
      const decreased = Math.max(
        acknowledgedBitrateBps * kBeta,
        kMinBitrateBps,
      );
      if (decreased < this.bitrateBps) {
        this.bitrateBps = decreased;
      }
      // Track near-capacity statistics for additive vs multiplicative increase.
      this.updateMaxBitrateEstimate(acknowledgedBitrateBps / 1000);
      this.inSlowStart = false;
    }
    // hold: keep bitrate

    // Bound estimate near actual throughput (draft A_hat < 1.5 * R_hat).
    if (acknowledgedBitrateBps > 0) {
      this.bitrateBps = Math.min(this.bitrateBps, 1.5 * acknowledgedBitrateBps);
    }

    this.bitrateBps = clamp(this.bitrateBps);
    this.lastUpdateMs = nowMs;
    return this.bitrateBps;
  }

  private changeState(usage: BandwidthUsage) {
    switch (this.state) {
      case "hold":
        if (usage === "overuse") this.state = "decrease";
        else if (usage === "normal") this.state = "increase";
        break;
      case "increase":
        if (usage === "overuse") this.state = "decrease";
        else if (usage === "underuse") this.state = "hold";
        break;
      case "decrease":
        if (usage === "overuse") {
          // stay in decrease
        } else if (usage === "normal" || usage === "underuse") {
          this.state = "hold";
        }
        break;
    }
  }

  private increase(
    currentBps: number,
    acknowledgedBitrateBps: number,
    timeSinceUpdateMs: number,
  ): number {
    const useMultiplicative =
      this.inSlowStart ||
      this.avgMaxBitrateKbps < 0 ||
      !this.nearMax(acknowledgedBitrateBps);

    if (useMultiplicative) {
      const eta =
        kMultiplicativeIncreaseFactor **
        Math.min(timeSinceUpdateMs / 1000, 1.0);
      return currentBps * eta;
    }

    const responseTimeMs = kReactionTimeMs + this.rttMs;
    const alpha =
      kAdditiveIncreaseFactor *
      Math.min(timeSinceUpdateMs / Math.max(responseTimeMs, 1), 1.0);
    const packetSizeBits = expectedPacketSizeBits(currentBps);
    return currentBps + Math.max(1000, alpha * packetSizeBits);
  }

  private nearMax(acknowledgedBitrateBps: number): boolean {
    if (this.avgMaxBitrateKbps < 0) return false;
    const ackKbps = acknowledgedBitrateBps / 1000;
    const sigma = Math.sqrt(Math.max(this.varMaxBitrateKbps, 0.4));
    return Math.abs(ackKbps - this.avgMaxBitrateKbps) < 3 * sigma;
  }

  private updateMaxBitrateEstimate(ackKbps: number) {
    const alpha = 0.05;
    if (this.avgMaxBitrateKbps < 0) {
      this.avgMaxBitrateKbps = ackKbps;
    } else {
      this.avgMaxBitrateKbps =
        (1 - alpha) * this.avgMaxBitrateKbps + alpha * ackKbps;
    }
    const norm = ackKbps - this.avgMaxBitrateKbps;
    this.varMaxBitrateKbps = Math.max(
      (1 - alpha) * this.varMaxBitrateKbps + alpha * norm * norm,
      0.4,
    );
  }
}

function expectedPacketSizeBits(bitrateBps: number): number {
  const bitsPerFrame = bitrateBps / 30;
  const packetsPerFrame = Math.max(1, Math.ceil(bitsPerFrame / (1200 * 8)));
  return bitsPerFrame / packetsPerFrame;
}

function clamp(bps: number) {
  return Math.min(Math.max(Math.round(bps), kMinBitrateBps), kMaxBitrateBps);
}

export { kBitrateWindowMs };
