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
  kThroughputLowerFraction,
} from "./constants";
import type { BandwidthUsage } from "./overuseDetector";

type RateControlState = "hold" | "increase" | "decrease";

/**
 * AIMD rate controller for the delay-based estimate A_hat.
 *
 * Aligns with libwebrtc `AimdRateControl` control points:
 * - Decrease at most once per RTT (`TimeToReduceFurther`), then hold
 * - Multiplicative increase in slow-start / far from max; additive near max
 * - Soft upper bound vs acknowledged throughput
 *
 * @see modules/congestion_controller/goog_cc/aimd_rate_control.cc
 */
export class AimdRateControl {
  private bitrateBps = kDefaultStartBitrateBps;
  private state: RateControlState = "increase";
  private lastUpdateMs = 0;
  private lastDecreaseMs = 0;
  private rttMs = kDefaultRttMs;
  private avgMaxBitrateKbps = -1;
  private varMaxBitrateKbps = 0.4;
  private inSlowStart = true;

  reset(startBps = kDefaultStartBitrateBps) {
    this.bitrateBps = clamp(startBps);
    this.state = "increase";
    this.lastUpdateMs = 0;
    this.lastDecreaseMs = 0;
    this.rttMs = kDefaultRttMs;
    this.avgMaxBitrateKbps = -1;
    this.varMaxBitrateKbps = 0.4;
    this.inSlowStart = true;
  }

  /**
   * State-preserving estimate update (libwebrtc `AimdRateControl::SetEstimate`).
   * Used when applying a valid probe result — does **not** wipe RTT, max-bitrate
   * variance, or slow-start bookkeeping the way {@link reset} does.
   */
  setEstimate(bitrateBps: number, atTimeMs: number) {
    const prev = this.bitrateBps;
    this.bitrateBps = clamp(bitrateBps);
    this.lastUpdateMs = atTimeMs;
    if (this.bitrateBps < prev) {
      this.lastDecreaseMs = atTimeMs;
      this.inSlowStart = false;
    }
  }

  setRtt(rttMs: number) {
    if (rttMs > 0) {
      // Clamp to a practical range (10 ms .. 2000 ms).
      this.rttMs = Math.min(2000, Math.max(10, rttMs));
    }
  }

  get rtt(): number {
    return this.rttMs;
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
   * @param nowMs wall clock (or feedback timeline)
   */
  update(
    usage: BandwidthUsage,
    acknowledgedBitrateBps: number,
    nowMs: number,
  ): number {
    if (this.lastUpdateMs === 0) {
      this.lastUpdateMs = nowMs;
    }
    const timeSinceUpdateMs = Math.max(nowMs - this.lastUpdateMs, 0);

    if (usage === "overuse") {
      // libwebrtc: decrease only when TimeToReduceFurther, then hold so we do
      // not multiply-apply beta on every TWCC batch (~100 ms).
      if (this.timeToReduceFurther(nowMs, acknowledgedBitrateBps)) {
        const input =
          acknowledgedBitrateBps > 0 ? acknowledgedBitrateBps : this.bitrateBps;
        const decreased = Math.max(input * kBeta, kMinBitrateBps);
        if (decreased < this.bitrateBps) {
          this.bitrateBps = decreased;
        }
        this.lastDecreaseMs = nowMs;
        this.inSlowStart = false;
        if (acknowledgedBitrateBps > 0) {
          this.updateMaxBitrateEstimate(acknowledgedBitrateBps / 1000);
        }
      }
      this.state = "hold";
    } else if (usage === "normal") {
      if (this.state === "hold" || this.state === "increase") {
        this.state = "increase";
        this.bitrateBps = this.increase(
          this.bitrateBps,
          acknowledgedBitrateBps,
          timeSinceUpdateMs,
        );
      }
    } else {
      // underuse: hold to let queues drain (libwebrtc stay on hold)
      this.state = "hold";
    }

    // Bound estimate near actual throughput (draft A_hat < 1.5 * R_hat).
    // Skip when acked is vanishingly small (queue drain / sparse feedback)
    // so we do not cascade the estimate to kMinBitrateBps.
    if (
      acknowledgedBitrateBps > 0 &&
      acknowledgedBitrateBps > this.bitrateBps * 0.05
    ) {
      this.bitrateBps = Math.min(this.bitrateBps, 1.5 * acknowledgedBitrateBps);
    }

    this.bitrateBps = clamp(this.bitrateBps);
    this.lastUpdateMs = nowMs;
    return this.bitrateBps;
  }

  /**
   * libwebrtc `TimeToReduceFurther`: allow another decrease after ≥ RTT, or
   * when measured throughput falls well below the current estimate.
   */
  timeToReduceFurther(nowMs: number, acknowledgedBitrateBps: number): boolean {
    if (this.lastDecreaseMs === 0) return true;
    const sinceMs = nowMs - this.lastDecreaseMs;
    if (sinceMs >= Math.max(this.rttMs, kReactionTimeMs)) return true;
    if (
      acknowledgedBitrateBps > 0 &&
      acknowledgedBitrateBps < this.bitrateBps * kThroughputLowerFraction
    ) {
      return true;
    }
    return false;
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
      // eta = 1.08 ^ min(Δt_sec, 1)
      const eta =
        kMultiplicativeIncreaseFactor **
        Math.min(timeSinceUpdateMs / 1000, 1.0);
      return currentBps * eta;
    }

    // Additive: ~1 packet per RTT-scale response time
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
