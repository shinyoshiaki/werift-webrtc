import {
  kDefaultStartBitrateBps,
  kLossBasedBandwidthPreferenceSmoothingFactor,
  kLossBasedBoundBestCandidate,
  kLossBasedCandidateFactors,
  kLossBasedDelayedIncreaseWindowMs,
  kLossBasedHigherBwBiasFactor,
  kLossBasedHigherLogBwBiasFactor,
  kLossBasedHoldDurationFactor,
  kLossBasedInherentLossLowerBound,
  kLossBasedInherentLossUpperBoundBwBalanceBps,
  kLossBasedInherentLossUpperBoundOffset,
  kLossBasedInitHoldDurationMs,
  kLossBasedInitialInherentLoss,
  kLossBasedInstantUpperBoundBwBalanceBps,
  kLossBasedInstantUpperBoundLossOffset,
  kLossBasedLossThresholdOfHighBandwidthPreference,
  kLossBasedLowerBoundByAckedRateFactor,
  kLossBasedMaxHoldDurationMs,
  kLossBasedMaxIncreaseFactor,
  kLossBasedMinNumObservations,
  kLossBasedNewtonIterations,
  kLossBasedNewtonStepSize,
  kLossBasedNotIncreaseIfInherentLessThanAverage,
  kLossBasedObservationDurationLowerBoundMs,
  kLossBasedObservationWindow,
  kLossBasedRampupUpperBoundFactor,
  kLossBasedTemporalWeightFactor,
  kLossBasedUseByteLossRate,
  kMaxBitrateBps,
  kMinBitrateBps,
} from "./constants";

/**
 * Loss-based BWE states (libwebrtc LossBasedBweV2 naming).
 * `increase_using_padding` is folded into `increasing` (no separate padding
 * duration controller on this lightweight pacer path).
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
  /** Total observation size in bytes. */
  size: number;
  /** Lost bytes within the observation. */
  lostSize: number;
  sendingRateBps: number;
  id: number;
}

/** Optional per-packet feedback for soft loss tracking (seq map). */
export interface LossPacketFeedback {
  seq: number;
  size: number;
  received: boolean;
  sendMs: number;
}

/**
 * LossBasedBweV2-aligned controller
 * (`modules/congestion_controller/goog_cc/loss_based_bwe_v2.*`).
 *
 * - Partial observations accumulate until send-timeline duration ≥ 250ms
 * - Soft loss: not-received seqs live in a map and can be unmarked if later
 *   reported as received before the observation commits
 * - Byte-loss objective/derivative when `UseByteLossRate` (default true)
 * - High-bandwidth bias adjusted by average loss ratio
 * - Instant upper/lower bounds + delayed-increase window + HOLD rate
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
  private delayBasedBps = 0;
  private averageReportedLossRatio = 0;
  private cachedInstantUpperBoundBps = kMaxBitrateBps;
  private cachedInstantLowerBoundBps = 0;
  private lastSendTimeMostRecentObservation = Number.NaN;
  private recoveringAfterLossMs = Number.NaN;
  private bandwidthLimitInCurrentWindow = kMaxBitrateBps;
  private holdUntilMs = Number.NEGATIVE_INFINITY;
  private holdDurationMs = kLossBasedInitHoldDurationMs;
  private holdRateBps = kMaxBitrateBps;
  private partial = {
    numPackets: 0,
    /** seq → lost size (soft loss map). */
    lostPackets: new Map<number, number>(),
    size: 0,
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
    this.delayBasedBps = 0;
    this.averageReportedLossRatio = 0;
    this.cachedInstantUpperBoundBps = kMaxBitrateBps;
    this.cachedInstantLowerBoundBps = 0;
    this.lastSendTimeMostRecentObservation = Number.NaN;
    this.recoveringAfterLossMs = Number.NaN;
    this.bandwidthLimitInCurrentWindow = kMaxBitrateBps;
    this.holdUntilMs = Number.NEGATIVE_INFINITY;
    this.holdDurationMs = kLossBasedInitHoldDurationMs;
    this.holdRateBps = kMaxBitrateBps;
    this.partial = {
      numPackets: 0,
      lostPackets: new Map(),
      size: 0,
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
    return this.averageReportedLossRatio;
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
   * @param firstSendMs actual first send time of this batch (send timeline)
   * @param batchBytes total sent bytes in batch
   * @param lastSendMs actual last send time of this batch (send timeline)
   * @param lostBytes lost bytes in batch (byte-loss mode); if 0 with losses,
   *   approximated from average packet size
   * @param packets optional per-packet feedback for soft-loss map
   */
  update(
    lossFraction: number,
    delayBasedBps: number,
    acknowledgedBps = 0,
    packetCount = 0,
    lostCount = 0,
    firstSendMs = 0,
    batchBytes = 0,
    lastSendMs = 0,
    lostBytes = 0,
    packets?: LossPacketFeedback[],
  ): number {
    if (acknowledgedBps > 0) {
      this.acknowledgedBps = acknowledgedBps;
      this.calculateInstantLowerBound();
    }
    if (delayBasedBps > 0) {
      this.delayBasedBps = delayBasedBps;
    }

    const n = packetCount > 0 ? packetCount : 0;
    const lost =
      packetCount > 0
        ? lostCount
        : Math.round(Math.min(Math.max(lossFraction, 0), 1) * Math.max(n, 1));

    // Resolve send timeline: prefer explicit first/last; fall back to duration
    // style when lastSendMs < firstSendMs (legacy test: last arg was duration).
    let batchFirst = firstSendMs;
    let batchLast = lastSendMs;
    if (batchLast > 0 && batchFirst > 0 && batchLast < batchFirst) {
      // Interpreted as (nowMs, sendDurationMs) legacy — do not use for real path.
      batchLast = batchFirst;
      batchFirst = batchFirst - lastSendMs;
    }
    if (batchLast <= 0 && batchFirst > 0) {
      batchLast = batchFirst;
    }

    if (n > 0 || (packets && packets.length > 0)) {
      this.accumulatePartial(
        n,
        lost,
        batchBytes,
        lostBytes,
        batchFirst,
        batchLast,
        packets,
      );
    }

    // Not ready: libwebrtc LossBasedBweV2::IsReady() false → return the
    // delay-based estimate (state kDelayBasedEstimate). Do **not** cap delay
    // with the start/current loss-limited value during cold start or after
    // probe reset clears observations.
    if (this.numObservations < kLossBasedMinNumObservations) {
      if (this.delayBasedBps > 0) {
        this.state = "delay_based";
        return this.delayBasedBps;
      }
      return this.current.lossLimitedBandwidthBps;
    }

    this.updateAverageReportedLossRatio();
    this.calculateInstantUpperBound();
    this.calculateInstantLowerBound();

    const prev = this.current.lossLimitedBandwidthBps;
    let best = { ...this.current };
    let bestObjective = Number.NEGATIVE_INFINITY;

    for (const candidate of this.getCandidates()) {
      this.newtonsMethodUpdate(candidate);
      const obj = this.getObjective(candidate);
      if (
        obj > bestObjective ||
        (obj === bestObjective &&
          candidate.lossLimitedBandwidthBps > best.lossLimitedBandwidthBps)
      ) {
        bestObjective = obj;
        best = candidate;
      }
    }

    // Do not increase if average loss exceeds inherent loss estimate.
    if (
      kLossBasedNotIncreaseIfInherentLessThanAverage &&
      this.averageReportedLossRatio > best.inherentLoss &&
      this.current.lossLimitedBandwidthBps < best.lossLimitedBandwidthBps
    ) {
      best.lossLimitedBandwidthBps = this.current.lossLimitedBandwidthBps;
    }

    // Delayed increase window after a loss reduction.
    if (this.isInLossLimitedState()) {
      if (
        Number.isFinite(this.recoveringAfterLossMs) &&
        this.recoveringAfterLossMs + kLossBasedDelayedIncreaseWindowMs >
          this.lastSendTimeMostRecentObservation &&
        best.lossLimitedBandwidthBps > this.bandwidthLimitInCurrentWindow
      ) {
        best.lossLimitedBandwidthBps = this.bandwidthLimitInCurrentWindow;
      }

      if (
        best.lossLimitedBandwidthBps > this.current.lossLimitedBandwidthBps &&
        this.acknowledgedBps > 0
      ) {
        const rampupCap =
          this.acknowledgedBps * kLossBasedRampupUpperBoundFactor;
        best.lossLimitedBandwidthBps = Math.max(
          this.current.lossLimitedBandwidthBps,
          Math.min(best.lossLimitedBandwidthBps, rampupCap),
        );
      }
    }

    // Bound best candidate by instant bounds (+ delay-based when available).
    let bounded = best.lossLimitedBandwidthBps;
    const upper = this.cachedInstantUpperBoundBps;
    const lower = this.cachedInstantLowerBoundBps;
    if (this.delayBasedBps > 0) {
      bounded = Math.max(lower, Math.min(bounded, upper, this.delayBasedBps));
    } else {
      bounded = Math.max(lower, Math.min(bounded, upper));
    }

    if (
      kLossBasedBoundBestCandidate &&
      bounded < best.lossLimitedBandwidthBps
    ) {
      this.current.lossLimitedBandwidthBps = clamp(bounded);
      this.current.inherentLoss = 0;
    } else {
      this.current = best;
      this.current.lossLimitedBandwidthBps = clamp(
        Math.max(this.current.lossLimitedBandwidthBps, lower),
      );
    }

    // HOLD: after a decrease, do not ramp above hold rate until hold expires.
    const lastSend = this.lastSendTimeMostRecentObservation;
    if (
      this.state === "decreasing" &&
      this.holdUntilMs > lastSend &&
      this.current.lossLimitedBandwidthBps < this.delayBasedBps
    ) {
      this.holdRateBps = Math.max(lower, this.holdRateBps);
      this.current.lossLimitedBandwidthBps = clamp(
        Math.min(this.holdRateBps, this.current.lossLimitedBandwidthBps),
      );
      this.state = "hold";
      return this.current.lossLimitedBandwidthBps;
    }

    this.updateState(prev, this.current.lossLimitedBandwidthBps, lastSend);

    if (this.isInLossLimitedState()) {
      if (
        !Number.isFinite(this.recoveringAfterLossMs) ||
        this.recoveringAfterLossMs + kLossBasedDelayedIncreaseWindowMs <
          lastSend
      ) {
        this.bandwidthLimitInCurrentWindow = Math.max(
          kMinBitrateBps,
          this.current.lossLimitedBandwidthBps * kLossBasedMaxIncreaseFactor,
        );
        this.recoveringAfterLossMs = lastSend;
      }
    }

    if (this.current.lossLimitedBandwidthBps < prev) {
      this.lastSendTimeMostRecentObservation = lastSend;
    }

    return this.current.lossLimitedBandwidthBps;
  }

  private updateState(prev: number, next: number, lastSendMs: number) {
    if (next < this.delayBasedBps && next < kMaxBitrateBps) {
      if (next < prev * 0.99 || next < prev) {
        // Enter decreasing + arm HOLD (libwebrtc order):
        // 1) hold_until = now + *current* duration (first time = 300 ms)
        // 2) then duration *= factor for the *next* HOLD (600 ms, …)
        this.holdUntilMs = lastSendMs + this.holdDurationMs;
        this.holdRateBps = next;
        this.holdDurationMs = Math.min(
          kLossBasedMaxHoldDurationMs,
          Math.max(
            kLossBasedInitHoldDurationMs,
            this.holdDurationMs * kLossBasedHoldDurationFactor,
          ),
        );
        this.state = "decreasing";
        return;
      }
      if (next > prev) {
        this.state = "increasing";
        return;
      }
      this.state = "hold";
      return;
    }
    // Delay-based is lower or equal → delay path wins.
    this.holdUntilMs = Number.NEGATIVE_INFINITY;
    this.holdDurationMs = kLossBasedInitHoldDurationMs;
    this.holdRateBps = kMaxBitrateBps;
    if (
      this.delayBasedBps > 0 &&
      Math.abs(next - this.delayBasedBps) / this.delayBasedBps < 0.05
    ) {
      this.state = "delay_based";
    } else if (next > prev * 1.02) {
      this.state = "increasing";
    } else if (next < prev * 0.95) {
      this.state = "decreasing";
    } else {
      this.state = "hold";
    }
  }

  private isInLossLimitedState(): boolean {
    return (
      this.state === "decreasing" ||
      this.state === "increasing" ||
      this.state === "hold"
    );
  }

  private accumulatePartial(
    numPackets: number,
    numLost: number,
    batchBytes: number,
    lostBytes: number,
    firstSendMs: number,
    lastSendMs: number,
    packets?: LossPacketFeedback[],
  ) {
    if (packets && packets.length > 0) {
      this.partial.numPackets += packets.length;
      for (const p of packets) {
        if (p.received) {
          this.partial.lostPackets.delete(p.seq & 0xffff);
        } else {
          this.partial.lostPackets.set(p.seq & 0xffff, p.size);
        }
        this.partial.size += p.size;
      }
      firstSendMs = Math.min(...packets.map((p) => p.sendMs));
      lastSendMs = Math.max(...packets.map((p) => p.sendMs));
    } else {
      this.partial.numPackets += numPackets;
      this.partial.size += batchBytes;
      // Aggregate soft-loss: synthetic seqs so later aggregate "received" cannot
      // unmark — tests without seq still work; real path should pass packets.
      const avgSize =
        numPackets > 0 ? Math.max(1, Math.round(batchBytes / numPackets)) : 1;
      const lostSize =
        lostBytes > 0 ? lostBytes : numLost > 0 ? avgSize * numLost : 0;
      // Represent lost packets as unique synthetic keys for this batch.
      const baseKey =
        (this.numObservations + 1) * 1_000_000 + this.partial.numPackets;
      for (let i = 0; i < numLost; i++) {
        const per =
          i === numLost - 1
            ? Math.max(1, lostSize - avgSize * (numLost - 1))
            : avgSize;
        this.partial.lostPackets.set(baseKey + i, per);
      }
    }

    if (!Number.isFinite(this.lastSendTimeMostRecentObservation)) {
      this.lastSendTimeMostRecentObservation = firstSendMs;
    }

    const observationDuration =
      lastSendMs - this.lastSendTimeMostRecentObservation;
    if (
      observationDuration <= 0 ||
      observationDuration < kLossBasedObservationDurationLowerBoundMs
    ) {
      return;
    }

    this.lastSendTimeMostRecentObservation = lastSendMs;

    let lostSize = 0;
    for (const s of this.partial.lostPackets.values()) {
      lostSize += s;
    }
    const numLostPackets = this.partial.lostPackets.size;
    const numPkts = this.partial.numPackets;
    const sendingRateBps =
      this.partial.size > 0 && observationDuration > 0
        ? (this.partial.size * 8 * 1000) / observationDuration
        : this.acknowledgedBps > 0
          ? this.acknowledgedBps
          : this.current.lossLimitedBandwidthBps;

    this.commitObservation({
      numPackets: numPkts,
      numLostPackets: numLostPackets,
      numReceivedPackets: Math.max(0, numPkts - numLostPackets),
      size: this.partial.size,
      lostSize,
      sendingRateBps,
    });

    this.partial = {
      numPackets: 0,
      lostPackets: new Map(),
      size: 0,
    };
  }

  private commitObservation(o: Omit<Observation, "id">) {
    const obs: Observation = {
      ...o,
      id: this.numObservations++,
    };
    this.observations.push(obs);
    while (this.observations.length > kLossBasedObservationWindow) {
      this.observations.shift();
    }
    this.updateAverageReportedLossRatio();
    this.calculateInstantUpperBound();
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

  private updateAverageReportedLossRatio() {
    if (this.observations.length === 0) {
      this.averageReportedLossRatio = 0;
      return;
    }
    if (kLossBasedUseByteLossRate) {
      let lost = 0;
      let total = 0;
      for (const o of this.observations) {
        const w = this.temporalWeightFor(o);
        lost += w * o.lostSize;
        total += w * o.size;
      }
      this.averageReportedLossRatio = total > 0 ? lost / total : 0;
    } else {
      let lost = 0;
      let total = 0;
      for (const o of this.observations) {
        const w = this.temporalWeightFor(o);
        lost += w * o.numLostPackets;
        total += w * o.numPackets;
      }
      this.averageReportedLossRatio = total > 0 ? lost / total : 0;
    }
  }

  private calculateInstantUpperBound() {
    let instant = kMaxBitrateBps;
    if (this.averageReportedLossRatio > kLossBasedInstantUpperBoundLossOffset) {
      instant =
        kLossBasedInstantUpperBoundBwBalanceBps /
        (this.averageReportedLossRatio - kLossBasedInstantUpperBoundLossOffset);
    }
    this.cachedInstantUpperBoundBps = instant;
  }

  private calculateInstantLowerBound() {
    let lower = 0;
    if (this.acknowledgedBps > 0 && kLossBasedLowerBoundByAckedRateFactor > 0) {
      lower = kLossBasedLowerBoundByAckedRateFactor * this.acknowledgedBps;
    }
    lower = Math.max(lower, kMinBitrateBps);
    this.cachedInstantLowerBoundBps = lower;
  }

  private getCandidates(): ChannelParameters[] {
    const bandwidths: number[] = [];
    for (const f of kLossBasedCandidateFactors) {
      bandwidths.push(this.current.lossLimitedBandwidthBps * f);
    }
    if (this.acknowledgedBps > 0) {
      bandwidths.push(this.acknowledgedBps);
    }
    if (this.delayBasedBps > this.current.lossLimitedBandwidthBps) {
      bandwidths.push(this.delayBasedBps);
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
    const inherent = Math.min(Math.max(inherentLoss, 0), 1);
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

  private toKiloBytes(bytes: number): number {
    return bytes / 1000;
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
      if (kLossBasedUseByteLossRate) {
        const lostKb = this.toKiloBytes(o.lostSize);
        const receivedKb = this.toKiloBytes(o.size - o.lostSize);
        first += w * (lostKb / lp - receivedKb / (1 - lp));
        second -= w * (lostKb / lp ** 2 + receivedKb / (1 - lp) ** 2);
      } else {
        first += w * (o.numLostPackets / lp - o.numReceivedPackets / (1 - lp));
        second -=
          w *
          (o.numLostPackets / lp ** 2 + o.numReceivedPackets / (1 - lp) ** 2);
      }
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

  /**
   * Adjust bias factor by current average loss
   * (libwebrtc `AdjustBiasFactor`).
   */
  private adjustBiasFactor(lossRate: number, biasFactor: number): number {
    return (
      (biasFactor *
        (kLossBasedLossThresholdOfHighBandwidthPreference - lossRate)) /
      (kLossBasedBandwidthPreferenceSmoothingFactor +
        Math.abs(kLossBasedLossThresholdOfHighBandwidthPreference - lossRate))
    );
  }

  private getHighBandwidthBias(bandwidthBps: number): number {
    if (!(bandwidthBps > 0)) return 0;
    const kbps = bandwidthBps / 1000;
    const loss = this.averageReportedLossRatio;
    return (
      this.adjustBiasFactor(loss, kLossBasedHigherBwBiasFactor) * kbps +
      this.adjustBiasFactor(loss, kLossBasedHigherLogBwBiasFactor) *
        Math.log(1 + kbps)
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
      if (kLossBasedUseByteLossRate) {
        const lostKb = this.toKiloBytes(o.lostSize);
        const receivedKb = this.toKiloBytes(o.size - o.lostSize);
        objective +=
          w * (lostKb * Math.log(lp) + receivedKb * Math.log(1 - lp));
        objective += w * bias * this.toKiloBytes(o.size);
      } else {
        objective +=
          w *
          (o.numLostPackets * Math.log(lp) +
            o.numReceivedPackets * Math.log(1 - lp));
        objective += w * bias * o.numPackets;
      }
    }
    return objective;
  }
}

function clamp(bps: number) {
  return Math.min(Math.max(Math.round(bps), kMinBitrateBps), kMaxBitrateBps);
}
