/**
 * libwebrtc-aligned acknowledged throughput estimator.
 *
 * Default path matches pin `0fda1615…` where
 * `RobustThroughputEstimatorSettings.enabled = true`
 * (`modules/congestion_controller/goog_cc/robust_throughput_estimator.*`).
 *
 * Bayesian {@link BitrateEstimator} remains available for tests / field-trial
 * parity when robust mode is disabled.
 */

import {
  kRobustMaxWindowDurationMs,
  kRobustMaxWindowPackets,
  kRobustMinWindowDurationMs,
  kRobustRequiredPackets,
  kRobustWindowPackets,
} from "./constants";

/** One ACKed packet sample (TWCC receive timeline + sender send time). */
export interface AckedPacketSample {
  /** TWCC-relative receive time (ms). */
  receiveTimeMs: number;
  /** Sender send time (ms), same clock as SentInfo.sendingAtMs. */
  sendTimeMs: number;
  /** Packet size in bytes (payload + headers counted by BWE). */
  sizeBytes: number;
}

/**
 * Sliding-window robust throughput (libwebrtc RobustThroughputEstimator).
 *
 * - Window: ≥ {@link kRobustWindowPackets} and ≥ {@link kRobustMinWindowDurationMs},
 *   capped by max packets / max duration
 * - Replaces the largest receive gap with the second-largest (delay-spike guard)
 * - Returns min(send_rate, recv_rate); send side drops reordered-old packets
 */
export class AcknowledgedBitrateEstimator {
  private window: AckedPacketSample[] = [];
  private latestDiscardedSendTimeMs = Number.NEGATIVE_INFINITY;

  reset() {
    this.window = [];
    this.latestDiscardedSendTimeMs = Number.NEGATIVE_INFINITY;
  }

  /**
   * Ingest ACKed packets. Prefer **receive-time order** (libwebrtc
   * `SortedByReceiveTime`); out-of-order samples are insertion-sorted.
   */
  incomingPacketFeedbackVector(packets: AckedPacketSample[]) {
    for (const packet of packets) {
      if (
        !Number.isFinite(packet.receiveTimeMs) ||
        !Number.isFinite(packet.sendTimeMs) ||
        packet.sizeBytes <= 0
      ) {
        continue;
      }
      this.window.push({ ...packet });
      // Keep window sorted by receive time (feedback reorder).
      for (let i = this.window.length - 1; i > 0; i--) {
        if (this.window[i].receiveTimeMs >= this.window[i - 1].receiveTimeMs) {
          break;
        }
        const tmp = this.window[i];
        this.window[i] = this.window[i - 1];
        this.window[i - 1] = tmp;
      }
      // Severe reordering / timeline jump → clear (libwebrtc 1s guard).
      const newest = this.window[this.window.length - 1];
      if (newest.receiveTimeMs - packet.receiveTimeMs > 1000) {
        this.window = [];
        this.latestDiscardedSendTimeMs = Number.NEGATIVE_INFINITY;
      }
      while (this.firstPacketOutsideWindow()) {
        const front = this.window.shift()!;
        this.latestDiscardedSendTimeMs = Math.max(
          this.latestDiscardedSendTimeMs,
          front.sendTimeMs,
        );
      }
    }
  }

  /** @returns estimated acked bitrate in bps, or 0 if not ready. */
  bitrate(): number {
    if (this.window.length < kRobustRequiredPackets) return 0;

    let largestGap = 0;
    let secondLargestGap = 0;
    for (let i = 1; i < this.window.length; i++) {
      const gap =
        this.window[i].receiveTimeMs - this.window[i - 1].receiveTimeMs;
      if (gap > largestGap) {
        secondLargestGap = largestGap;
        largestGap = gap;
      } else if (gap > secondLargestGap) {
        secondLargestGap = gap;
      }
    }

    let firstSend = Number.POSITIVE_INFINITY;
    let lastSend = Number.NEGATIVE_INFINITY;
    let firstRecv = Number.POSITIVE_INFINITY;
    let lastRecv = Number.NEGATIVE_INFINITY;
    let recvSize = 0;
    let sendSize = 0;
    let firstRecvSize = 0;
    let lastSendSize = 0;
    let numSentInWindow = 0;

    for (const p of this.window) {
      if (p.receiveTimeMs < firstRecv) {
        firstRecv = p.receiveTimeMs;
        firstRecvSize = p.sizeBytes;
      }
      lastRecv = Math.max(lastRecv, p.receiveTimeMs);
      recvSize += p.sizeBytes;

      if (p.sendTimeMs < this.latestDiscardedSendTimeMs) {
        // Reordered relative to discarded packets — skip for send rate.
        continue;
      }
      if (p.sendTimeMs > lastSend) {
        lastSend = p.sendTimeMs;
        lastSendSize = p.sizeBytes;
      }
      firstSend = Math.min(firstSend, p.sendTimeMs);
      sendSize += p.sizeBytes;
      numSentInWindow++;
    }

    // Exclude one edge packet (libwebrtc recv first / send last).
    recvSize = Math.max(0, recvSize - firstRecvSize);
    sendSize = Math.max(0, sendSize - lastSendSize);

    let recvDurationMs = lastRecv - firstRecv - largestGap + secondLargestGap;
    recvDurationMs = Math.max(recvDurationMs, 1);

    if (numSentInWindow < kRobustRequiredPackets) {
      return (recvSize * 8 * 1000) / recvDurationMs;
    }

    let sendDurationMs = lastSend - firstSend;
    sendDurationMs = Math.max(sendDurationMs, 1);

    const recvBps = (recvSize * 8 * 1000) / recvDurationMs;
    const sendBps = (sendSize * 8 * 1000) / sendDurationMs;
    return Math.min(sendBps, recvBps);
  }

  private firstPacketOutsideWindow(): boolean {
    if (this.window.length === 0) return false;
    if (this.window.length > kRobustMaxWindowPackets) return true;
    const duration =
      this.window[this.window.length - 1].receiveTimeMs -
      this.window[0].receiveTimeMs;
    if (duration > kRobustMaxWindowDurationMs) return true;
    if (
      this.window.length > kRobustWindowPackets &&
      duration > kRobustMinWindowDurationMs
    ) {
      return true;
    }
    return false;
  }
}

/**
 * Bayesian bitrate estimator (libwebrtc BitrateEstimator).
 * Used when robust throughput is disabled; kept for parity / unit tests.
 */
export class BitrateEstimator {
  private sum = 0;
  private currentWindowMs = 0;
  private prevTimeMs = -1;
  private bitrateEstimateKbps = -1;
  private bitrateEstimateVar = 50;
  private readonly initialWindowMs = 500;
  private readonly nonInitialWindowMs = 150;
  private readonly uncertaintyScale = 10;

  reset() {
    this.sum = 0;
    this.currentWindowMs = 0;
    this.prevTimeMs = -1;
    this.bitrateEstimateKbps = -1;
    this.bitrateEstimateVar = 50;
  }

  update(atTimeMs: number, bytes: number) {
    const rateWindowMs =
      this.bitrateEstimateKbps < 0
        ? this.initialWindowMs
        : this.nonInitialWindowMs;
    let isSmallSample = false;
    const sampleKbps = this.updateWindow(
      atTimeMs,
      bytes,
      rateWindowMs,
      (small) => {
        isSmallSample = small;
      },
    );
    if (sampleKbps < 0) return;
    if (this.bitrateEstimateKbps < 0) {
      this.bitrateEstimateKbps = sampleKbps;
      return;
    }
    // Higher uncertainty for samples far from the estimate.
    void isSmallSample;
    const scale = this.uncertaintyScale;
    const sampleUncertainty =
      (scale * Math.abs(this.bitrateEstimateKbps - sampleKbps)) /
      (this.bitrateEstimateKbps + sampleKbps);
    const sampleVar = sampleUncertainty * sampleUncertainty;
    const predVar = this.bitrateEstimateVar + 5;
    this.bitrateEstimateKbps =
      (sampleVar * this.bitrateEstimateKbps + predVar * sampleKbps) /
      (sampleVar + predVar);
    this.bitrateEstimateVar = (sampleVar * predVar) / (sampleVar + predVar);
  }

  bitrate(): number {
    if (this.bitrateEstimateKbps < 0) return 0;
    return this.bitrateEstimateKbps * 1000;
  }

  expectFastRateChange() {
    this.bitrateEstimateVar += 200;
  }

  private updateWindow(
    nowMs: number,
    bytes: number,
    rateWindowMs: number,
    setSmall: (small: boolean) => void,
  ): number {
    if (nowMs < this.prevTimeMs) {
      this.prevTimeMs = -1;
      this.sum = 0;
      this.currentWindowMs = 0;
    }
    if (this.prevTimeMs >= 0) {
      this.currentWindowMs += nowMs - this.prevTimeMs;
      if (nowMs - this.prevTimeMs > rateWindowMs) {
        this.sum = 0;
        this.currentWindowMs %= rateWindowMs;
      }
    }
    this.prevTimeMs = nowMs;
    let bitrateSample = -1;
    if (this.currentWindowMs >= rateWindowMs) {
      setSmall(false);
      bitrateSample = (8 * this.sum) / rateWindowMs;
      this.currentWindowMs -= rateWindowMs;
      this.sum = 0;
    }
    this.sum += bytes;
    return bitrateSample;
  }
}
