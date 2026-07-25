import {
  kDefaultStartBitrateBps,
  kLossBasedCandidateFactors,
  kLossBasedInherentLossLowerBound,
  kLossBasedObservationWindow,
  kLossBasedRampupUpperBoundFactor,
  kMaxBitrateBps,
  kMinBitrateBps,
} from "./constants";

/**
 * Loss-based BWE states (libwebrtc LossBasedBweV2 naming).
 */
export type LossBasedState =
  | "increasing"
  | "decreasing"
  | "delay_based"
  | "hold";

interface Observation {
  numPackets: number;
  numLost: number;
  sendingRateBps: number;
  id: number;
}

/**
 * LossBasedBweV2-style controller (libwebrtc goog_cc structure).
 *
 * Implements:
 * - Observation window of recent (sent, lost, sending_rate) samples
 * - Candidate generation: current × factors, acknowledged rate, delay-based
 * - Objective preferring lower inherent loss + higher bandwidth (simplified)
 * - State transitions: increasing / decreasing / delay_based / hold
 *
 * Not a bit-identical port of Newton's method iterations; objective ranking
 * and observation-window averaging match the operational V2 control shape.
 */
export class LossBasedBwe {
  private bitrateBps = kDefaultStartBitrateBps;
  private state: LossBasedState = "increasing";
  private inherentLoss = kLossBasedInherentLossLowerBound;
  private observations: Observation[] = [];
  private nextObsId = 0;
  private partial = { numPackets: 0, numLost: 0, bytes: 0, startMs: 0 };
  private acknowledgedBps = 0;

  reset(startBps = kDefaultStartBitrateBps) {
    this.bitrateBps = clamp(startBps);
    this.state = "increasing";
    this.inherentLoss = kLossBasedInherentLossLowerBound;
    this.observations = [];
    this.nextObsId = 0;
    this.partial = { numPackets: 0, numLost: 0, bytes: 0, startMs: 0 };
    this.acknowledgedBps = 0;
  }

  get targetBitrateBps() {
    return this.bitrateBps;
  }

  get lossState(): LossBasedState {
    return this.state;
  }

  get averageLossRatio(): number {
    return this.getAverageReportedLossRatio();
  }

  setBitrateIfHigher(bps: number) {
    if (bps > this.bitrateBps) {
      this.bitrateBps = clamp(bps);
    }
  }

  /**
   * Push a TWCC observation sample into the window and recompute the estimate.
   *
   * @param lossFraction loss in this feedback batch [0,1]
   * @param delayBasedBps delay-based A_hat
   * @param acknowledgedBps recent acked bitrate
   * @param packetCount packets in this batch (known sequences only)
   * @param lostCount lost among known sequences
   * @param nowMs wall clock for observation duration
   * @param batchBytes total sent bytes represented in the batch
   */
  update(
    lossFraction: number,
    delayBasedBps: number,
    acknowledgedBps = 0,
    packetCount = 0,
    lostCount = 0,
    nowMs = 0,
    batchBytes = 0,
  ): number {
    if (acknowledgedBps > 0) {
      this.acknowledgedBps = acknowledgedBps;
    }

    if (packetCount > 0) {
      this.pushObservation(
        packetCount,
        lostCount,
        batchBytes,
        nowMs,
        acknowledgedBps > 0 ? acknowledgedBps : this.bitrateBps,
      );
    } else {
      // Compatibility path: single instantaneous sample from fraction alone.
      const n = 20;
      const lost = Math.round(Math.min(Math.max(lossFraction, 0), 1) * n);
      this.pushObservation(
        n,
        lost,
        0,
        nowMs,
        acknowledgedBps > 0 ? acknowledgedBps : this.bitrateBps,
      );
    }

    const avgLoss = this.getAverageReportedLossRatio();
    const candidates = this.getCandidates(delayBasedBps);
    const best = this.pickBestCandidate(candidates, avgLoss, delayBasedBps);

    const prev = this.bitrateBps;
    this.bitrateBps = clamp(best.bandwidthBps);
    this.inherentLoss = best.inherentLoss;

    // State machine (V2-style labels).
    if (this.bitrateBps < prev * 0.95) {
      this.state = "decreasing";
    } else if (
      delayBasedBps > 0 &&
      Math.abs(this.bitrateBps - delayBasedBps) / delayBasedBps < 0.05
    ) {
      this.state = "delay_based";
    } else if (this.bitrateBps > prev * 1.02) {
      this.state = "increasing";
    } else {
      this.state = "hold";
    }

    // Ramp-up cap vs acknowledged (V2 bandwidth_rampup_upper_bound_factor).
    if (this.acknowledgedBps > 0 && this.state === "increasing") {
      const cap = this.acknowledgedBps * kLossBasedRampupUpperBoundFactor;
      if (this.bitrateBps > cap) {
        this.bitrateBps = clamp(cap);
      }
    }

    return this.bitrateBps;
  }

  private pushObservation(
    numPackets: number,
    numLost: number,
    bytes: number,
    nowMs: number,
    sendingRateBps: number,
  ) {
    this.observations.push({
      numPackets,
      numLost,
      sendingRateBps,
      id: this.nextObsId++,
    });
    while (this.observations.length > kLossBasedObservationWindow) {
      this.observations.shift();
    }
    void bytes;
    void nowMs;
  }

  private getAverageReportedLossRatio(): number {
    if (this.observations.length === 0) return 0;
    let lost = 0;
    let total = 0;
    // Newer observations weigh more (temporal weight factor ≈ 0.9^age).
    const n = this.observations.length;
    for (let i = 0; i < n; i++) {
      const w = 0.9 ** (n - 1 - i);
      const o = this.observations[i];
      lost += o.numLost * w;
      total += o.numPackets * w;
    }
    return total > 0 ? lost / total : 0;
  }

  private getCandidates(delayBasedBps: number): {
    bandwidthBps: number;
    inherentLoss: number;
  }[] {
    const candidates: { bandwidthBps: number; inherentLoss: number }[] = [];
    for (const f of kLossBasedCandidateFactors) {
      candidates.push({
        bandwidthBps: this.bitrateBps * f,
        inherentLoss: this.inherentLoss,
      });
    }
    if (this.acknowledgedBps > 0) {
      candidates.push({
        bandwidthBps: this.acknowledgedBps,
        inherentLoss: Math.max(
          this.inherentLoss,
          this.getAverageReportedLossRatio(),
        ),
      });
    }
    if (delayBasedBps > 0) {
      candidates.push({
        bandwidthBps: delayBasedBps,
        inherentLoss: this.inherentLoss,
      });
    }
    return candidates;
  }

  /**
   * Rank candidates: penalize bandwidths that cannot explain observed loss
   * without high inherent loss; prefer higher bandwidth when loss is similar.
   */
  private pickBestCandidate(
    candidates: { bandwidthBps: number; inherentLoss: number }[],
    avgLoss: number,
    delayBasedBps: number,
  ): { bandwidthBps: number; inherentLoss: number } {
    let best = candidates[0] ?? {
      bandwidthBps: this.bitrateBps,
      inherentLoss: this.inherentLoss,
    };
    let bestScore = -Infinity;

    for (const c of candidates) {
      // Inherent loss must be at least the residual after congestion loss model.
      // If candidate rate is far above what loss allows, penalize heavily.
      const inherent = Math.max(
        kLossBasedInherentLossLowerBound,
        Math.min(avgLoss, 0.5),
      );
      // Objective ≈ -|avgLoss - inherent| + bias * log(bandwidth)
      const lossFit = -Math.abs(avgLoss - inherent) * 10;
      const bwBias = Math.log(Math.max(c.bandwidthBps, kMinBitrateBps)) * 0.15;
      // Prefer not exceeding delay-based by too much when loss is elevated.
      let delayPenalty = 0;
      if (delayBasedBps > 0 && avgLoss > 0.05 && c.bandwidthBps > delayBasedBps) {
        delayPenalty = -((c.bandwidthBps - delayBasedBps) / delayBasedBps);
      }
      // High loss → strongly prefer lower bandwidth candidates.
      let lossBackoff = 0;
      if (avgLoss > 0.1) {
        lossBackoff = -avgLoss * (c.bandwidthBps / Math.max(this.bitrateBps, 1));
      }
      const score = lossFit + bwBias + delayPenalty + lossBackoff;
      if (score > bestScore) {
        bestScore = score;
        best = { bandwidthBps: c.bandwidthBps, inherentLoss: inherent };
      }
    }

    // Explicit high-loss decrease: never increase when avgLoss is severe.
    if (avgLoss > 0.1 && best.bandwidthBps > this.bitrateBps) {
      best = {
        bandwidthBps: this.bitrateBps * (1 - 0.5 * avgLoss),
        inherentLoss: avgLoss,
      };
    }
    // Low loss: allow growth toward delay-based.
    if (avgLoss < 0.02 && delayBasedBps > best.bandwidthBps) {
      best = {
        bandwidthBps: Math.max(best.bandwidthBps, delayBasedBps),
        inherentLoss: best.inherentLoss,
      };
    }

    return best;
  }
}

function clamp(bps: number) {
  return Math.min(Math.max(Math.round(bps), kMinBitrateBps), kMaxBitrateBps);
}
