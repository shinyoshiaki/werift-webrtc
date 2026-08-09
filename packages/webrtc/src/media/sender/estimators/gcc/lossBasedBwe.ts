import {
  kDefaultStartBitrateBps,
  kLossBasedCandidateFactors,
  kLossBasedHigherBwBiasFactor,
  kLossBasedHigherLogBwBiasFactor,
  kLossBasedInherentLossLowerBound,
  kLossBasedInherentLossUpperBoundBwBalanceBps,
  kLossBasedInherentLossUpperBoundOffset,
  kLossBasedInitialInherentLoss,
  kLossBasedMinNumObservations,
  kLossBasedNewtonIterations,
  kLossBasedNewtonStepSize,
  kLossBasedObservationDurationLowerBoundMs,
  kLossBasedObservationWindow,
  kLossBasedRampupUpperBoundFactor,
  kLossBasedTemporalWeightFactor,
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

interface ChannelParameters {
  inherentLoss: number;
  lossLimitedBandwidthBps: number;
}

interface Observation {
  numPackets: number;
  numLostPackets: number;
  numReceivedPackets: number;
  sendingRateBps: number;
  id: number;
}

/**
 * LossBasedBweV2-aligned controller
 * (`modules/congestion_controller/goog_cc/loss_based_bwe_v2.*`).
 *
 * - Partial observations accumulate until duration ≥ 250ms (lower bound)
 * - Estimates require ≥ 3 committed observations
 * - Loss probability: inherent + (1−inherent)×excess/sending (libwebrtc)
 * - Constants match Chromium field-trial defaults (lkgr)
 */
export class LossBasedBwe {
  private current: ChannelParameters = {
    inherentLoss: kLossBasedInitialInherentLoss,
    lossLimitedBandwidthBps: kDefaultStartBitrateBps,
  };
  private state: LossBasedState = "increasing";
  private observations: Observation[] = [];
  private numObservations = 0;
  private acknowledgedBps = 0;
  private partial = {
    numPackets: 0,
    numLost: 0,
    bytes: 0,
    firstSendMs: 0,
    lastSendMs: 0,
  };
  private temporalWeights: number[] = [];

  constructor() {
    this.recomputeTemporalWeights();
  }

  reset(startBps = kDefaultStartBitrateBps) {
    this.current = {
      inherentLoss: kLossBasedInitialInherentLoss,
      lossLimitedBandwidthBps: clamp(startBps),
    };
    this.state = "increasing";
    this.observations = [];
    this.numObservations = 0;
    this.acknowledgedBps = 0;
    this.partial = {
      numPackets: 0,
      numLost: 0,
      bytes: 0,
      firstSendMs: 0,
      lastSendMs: 0,
    };
    this.recomputeTemporalWeights();
  }

  get targetBitrateBps() {
    return this.current.lossLimitedBandwidthBps;
  }

  get lossState(): LossBasedState {
    return this.state;
  }

  get averageLossRatio(): number {
    return this.getAverageReportedLossRatio();
  }

  get inherentLossEstimate(): number {
    return this.current.inherentLoss;
  }

  /** Number of committed observations (for readiness tests). */
  get observationCount(): number {
    return this.numObservations;
  }

  setBitrateIfHigher(bps: number) {
    if (bps > this.current.lossLimitedBandwidthBps) {
      this.current.lossLimitedBandwidthBps = clamp(bps);
    }
  }

  /**
   * @param lossFraction fallback when packet counts are 0
   * @param delayBasedBps delay-based A_hat
   * @param acknowledgedBps recent acked bitrate (TWCC-relative throughput)
   * @param packetCount known packets in batch
   * @param lostCount lost among known
   * @param nowMs send-timeline reference (used for partial window start)
   * @param batchBytes total sent bytes in batch
   * @param sendDurationMs duration of this batch on the send timeline
   */
  update(
    lossFraction: number,
    delayBasedBps: number,
    acknowledgedBps = 0,
    packetCount = 0,
    lostCount = 0,
    nowMs = 0,
    batchBytes = 0,
    sendDurationMs = 0,
  ): number {
    if (acknowledgedBps > 0) {
      this.acknowledgedBps = acknowledgedBps;
    }

    const n = packetCount > 0 ? packetCount : 0;
    const lost =
      packetCount > 0
        ? lostCount
        : Math.round(Math.min(Math.max(lossFraction, 0), 1) * Math.max(n, 1));

    if (n > 0) {
      this.accumulatePartial(n, lost, batchBytes, sendDurationMs, nowMs);
    }

    // Not ready: keep last estimate (libwebrtc waits for min observations).
    if (this.numObservations < kLossBasedMinNumObservations) {
      return this.current.lossLimitedBandwidthBps;
    }

    const prev = this.current.lossLimitedBandwidthBps;
    let best = { ...this.current };
    let bestObjective = Number.NEGATIVE_INFINITY;

    for (const candidate of this.getCandidates(delayBasedBps)) {
      this.newtonsMethodUpdate(candidate);
      const obj = this.getObjective(candidate);
      if (obj > bestObjective) {
        bestObjective = obj;
        best = candidate;
      }
    }

    this.current = best;
    this.current.lossLimitedBandwidthBps = clamp(
      this.current.lossLimitedBandwidthBps,
    );

    if (this.current.lossLimitedBandwidthBps < prev * 0.95) {
      this.state = "decreasing";
    } else if (
      delayBasedBps > 0 &&
      Math.abs(this.current.lossLimitedBandwidthBps - delayBasedBps) /
        delayBasedBps <
        0.05
    ) {
      this.state = "delay_based";
    } else if (this.current.lossLimitedBandwidthBps > prev * 1.02) {
      this.state = "increasing";
    } else {
      this.state = "hold";
    }

    return this.current.lossLimitedBandwidthBps;
  }

  private accumulatePartial(
    numPackets: number,
    numLost: number,
    batchBytes: number,
    sendDurationMs: number,
    nowMs: number,
  ) {
    if (this.partial.numPackets === 0) {
      this.partial.firstSendMs = nowMs > 0 ? nowMs - sendDurationMs : 0;
    }
    this.partial.numPackets += numPackets;
    this.partial.numLost += numLost;
    this.partial.bytes += batchBytes;
    this.partial.lastSendMs =
      nowMs > 0 ? nowMs : this.partial.lastSendMs + sendDurationMs;

    const durationMs = Math.max(
      this.partial.lastSendMs - this.partial.firstSendMs,
      sendDurationMs,
      0,
    );
    if (durationMs < kLossBasedObservationDurationLowerBoundMs) {
      return;
    }

    const sendingRateBps =
      this.partial.bytes > 0 && durationMs > 0
        ? (this.partial.bytes * 8 * 1000) / durationMs
        : this.acknowledgedBps > 0
          ? this.acknowledgedBps
          : this.current.lossLimitedBandwidthBps;

    this.commitObservation(
      this.partial.numPackets,
      this.partial.numLost,
      sendingRateBps,
    );
    this.partial = {
      numPackets: 0,
      numLost: 0,
      bytes: 0,
      firstSendMs: 0,
      lastSendMs: 0,
    };
  }

  private commitObservation(
    numPackets: number,
    numLost: number,
    sendingRateBps: number,
  ) {
    const obs: Observation = {
      numPackets,
      numLostPackets: numLost,
      numReceivedPackets: Math.max(0, numPackets - numLost),
      sendingRateBps,
      id: this.numObservations++,
    };
    this.observations.push(obs);
    while (this.observations.length > kLossBasedObservationWindow) {
      this.observations.shift();
    }
  }

  private recomputeTemporalWeights() {
    this.temporalWeights = [];
    for (let i = 0; i < kLossBasedObservationWindow; i++) {
      this.temporalWeights.push(kLossBasedTemporalWeightFactor ** i);
    }
  }

  private temporalWeightFor(observation: Observation): number {
    const age = this.numObservations - 1 - observation.id;
    if (age < 0 || age >= this.temporalWeights.length) {
      return kLossBasedTemporalWeightFactor ** Math.max(age, 0);
    }
    return this.temporalWeights[age];
  }

  private getAverageReportedLossRatio(): number {
    if (this.observations.length === 0) return 0;
    let lost = 0;
    let total = 0;
    for (const o of this.observations) {
      const w = this.temporalWeightFor(o);
      lost += w * o.numLostPackets;
      total += w * o.numPackets;
    }
    return total > 0 ? lost / total : 0;
  }

  private getCandidates(delayBasedBps: number): ChannelParameters[] {
    const bandwidths: number[] = [];
    for (const f of kLossBasedCandidateFactors) {
      bandwidths.push(this.current.lossLimitedBandwidthBps * f);
    }
    if (this.acknowledgedBps > 0) {
      bandwidths.push(this.acknowledgedBps);
    }
    if (delayBasedBps > 0) {
      bandwidths.push(delayBasedBps);
    }

    const rampupCap =
      this.acknowledgedBps > 0
        ? this.acknowledgedBps * kLossBasedRampupUpperBoundFactor
        : kMaxBitrateBps;

    return bandwidths.map((bw) => {
      let lossLimited = bw;
      if (bw > this.current.lossLimitedBandwidthBps) {
        lossLimited = Math.min(
          bw,
          Math.max(this.current.lossLimitedBandwidthBps, rampupCap),
        );
      }
      const candidate: ChannelParameters = {
        inherentLoss: this.current.inherentLoss,
        lossLimitedBandwidthBps: lossLimited,
      };
      candidate.inherentLoss = this.getFeasibleInherentLoss(candidate);
      return candidate;
    });
  }

  /**
   * libwebrtc loss probability:
   * inherent + (1 - inherent) * max(0, sending - bw) / sending
   */
  private getLossProbability(
    inherentLoss: number,
    lossLimitedBw: number,
    sendingRate: number,
  ): number {
    let inherent = Math.min(Math.max(inherentLoss, 0), 1);
    let p = inherent;
    if (sendingRate > 0 && sendingRate > lossLimitedBw) {
      p += (1 - inherent) * ((sendingRate - lossLimitedBw) / sendingRate);
    }
    return Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  }

  private getInherentLossUpperBound(bandwidthBps: number): number {
    if (bandwidthBps <= 0) return 1;
    const ub =
      kLossBasedInherentLossUpperBoundOffset +
      kLossBasedInherentLossUpperBoundBwBalanceBps / bandwidthBps;
    return Math.min(ub, 1);
  }

  private getFeasibleInherentLoss(c: ChannelParameters): number {
    return Math.min(
      Math.max(c.inherentLoss, kLossBasedInherentLossLowerBound),
      this.getInherentLossUpperBound(c.lossLimitedBandwidthBps),
    );
  }

  private getDerivatives(c: ChannelParameters): {
    first: number;
    second: number;
  } {
    let first = 0;
    let second = 0;
    for (const o of this.observations) {
      const lp = this.getLossProbability(
        c.inherentLoss,
        c.lossLimitedBandwidthBps,
        o.sendingRateBps,
      );
      const w = this.temporalWeightFor(o);
      first += w * (o.numLostPackets / lp - o.numReceivedPackets / (1 - lp));
      second -=
        w * (o.numLostPackets / lp ** 2 + o.numReceivedPackets / (1 - lp) ** 2);
    }
    if (second >= 0) second = -1e-6;
    return { first, second };
  }

  private newtonsMethodUpdate(c: ChannelParameters) {
    if (this.observations.length === 0) return;
    for (let i = 0; i < kLossBasedNewtonIterations; i++) {
      const d = this.getDerivatives(c);
      c.inherentLoss -= (kLossBasedNewtonStepSize * d.first) / d.second;
      c.inherentLoss = this.getFeasibleInherentLoss(c);
    }
  }

  private getHighBandwidthBias(bandwidthBps: number): number {
    const kbps = bandwidthBps / 1000;
    return (
      kLossBasedHigherBwBiasFactor * kbps +
      kLossBasedHigherLogBwBiasFactor * Math.log(1 + kbps)
    );
  }

  private getObjective(c: ChannelParameters): number {
    let objective = 0;
    const bias = this.getHighBandwidthBias(c.lossLimitedBandwidthBps);
    for (const o of this.observations) {
      const lp = this.getLossProbability(
        c.inherentLoss,
        c.lossLimitedBandwidthBps,
        o.sendingRateBps,
      );
      const w = this.temporalWeightFor(o);
      objective +=
        w *
        (o.numLostPackets * Math.log(lp) +
          o.numReceivedPackets * Math.log(1 - lp));
      objective += w * bias;
    }
    return objective;
  }
}

function clamp(bps: number) {
  return Math.min(Math.max(Math.round(bps), kMinBitrateBps), kMaxBitrateBps);
}
