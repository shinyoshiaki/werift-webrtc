import { kRttBasedBackOffHighRttMs } from "./constants";

/**
 * libwebrtc `RttBasedBackoff` (send_side_bandwidth_estimation.{h,cc}).
 *
 * {@link IsRttAboveLimit} uses **propagation RTT** (CorrectedRtt), not raw max
 * feedback RTT. When above limit, pin `SendSideBandwidthEstimation::UpdateEstimate`
 * multiplies the target by drop_fraction every drop_interval down to
 * bandwidth_floor — see {@link GccBandwidthEstimator} sender-clock process.
 *
 * Field-trial default: WebRTC-Bwe-MaxRttLimit limit=3s, fraction=0.8,
 * interval=1s, floor=5kbps (Enabled).
 */
export class RttBasedBackoff {
  /** Propagation RTT from last feedback (ms). */
  private lastPropagationRttMs = 0;
  /** Sender clock when propagation RTT was last updated. */
  private lastPropagationRttUpdateMs = Number.POSITIVE_INFINITY;
  /** Sender clock of the most recent rtpPacketSent. */
  private lastPacketSentMs = Number.NEGATIVE_INFINITY;
  private readonly rttLimitMs: number;

  constructor(rttLimitMs = kRttBasedBackOffHighRttMs) {
    this.rttLimitMs = rttLimitMs;
  }

  reset() {
    this.lastPropagationRttMs = 0;
    this.lastPropagationRttUpdateMs = Number.POSITIVE_INFINITY;
    this.lastPacketSentMs = Number.NEGATIVE_INFINITY;
  }

  /** libwebrtc RttBasedBackoff::OnSentPacket (last_packet_sent_). */
  onSentPacket(sendTimeMs: number) {
    if (Number.isFinite(sendTimeMs)) {
      this.lastPacketSentMs = sendTimeMs;
    }
  }

  /**
   * libwebrtc UpdatePropagationRtt — store min_propagation_rtt from the batch.
   */
  updatePropagationRtt(atTimeMs: number, propagationRttMs: number) {
    if (!Number.isFinite(atTimeMs) || !Number.isFinite(propagationRttMs)) {
      return;
    }
    this.lastPropagationRttUpdateMs = atTimeMs;
    this.lastPropagationRttMs = Math.max(0, propagationRttMs);
  }

  /**
   * CorrectedRtt = max(last_packet_sent − last_update, 0) + last_propagation_rtt.
   * Avoids false timeout when no packets are being sent.
   */
  correctedRttMs(): number {
    if (!Number.isFinite(this.lastPropagationRttUpdateMs)) {
      return this.lastPropagationRttMs;
    }
    const timeoutCorrection = Math.max(
      0,
      this.lastPacketSentMs - this.lastPropagationRttUpdateMs,
    );
    return timeoutCorrection + this.lastPropagationRttMs;
  }

  /** True when CorrectedRtt > configured limit (default 3s). */
  isRttAboveLimit(): boolean {
    return this.correctedRttMs() > this.rttLimitMs;
  }

  /** Last stored propagation RTT (without timeout correction). */
  get lastPropagationRtt(): number {
    return this.lastPropagationRttMs;
  }
}

/**
 * Choose a feedback-arrival time on the **same clock domain as send times**
 * for RTT math (pin uses one Timestamp domain for send / recv / feedback).
 *
 * Production: `sendingAtMs` and wall `nowMs` both come from {@link milliTime},
 * so `nowMs - maxSend` is a plausible RTT window and wall time is used.
 *
 * Unit tests often use synthetic send/recv timelines with wall-clock
 * `receiveTWCC`; mixing those would inflate propagation RTT into years.
 * When wall delta is outside a sane window, fall back to the receive
 * timeline (`maxRecv`) as the feedback clock.
 */
export function feedbackTimeMsForRtt(
  packets: ReadonlyArray<{ sendMs: number; recvMs: number }>,
  wallNowMs: number,
  /** Max plausible feedback_rtt from latest send before treating clocks as divergent. */
  maxPlausibleFeedbackRttMs = 60_000,
): number {
  let maxSend = Number.NEGATIVE_INFINITY;
  let maxRecv = Number.NEGATIVE_INFINITY;
  for (const p of packets) {
    if (Number.isFinite(p.sendMs) && p.sendMs > maxSend) maxSend = p.sendMs;
    if (Number.isFinite(p.recvMs) && p.recvMs > maxRecv) maxRecv = p.recvMs;
  }
  if (!Number.isFinite(maxSend)) {
    return wallNowMs;
  }
  if (Number.isFinite(wallNowMs)) {
    const wallDelta = wallNowMs - maxSend;
    if (wallDelta >= 0 && wallDelta <= maxPlausibleFeedbackRttMs) {
      return wallNowMs;
    }
  }
  if (Number.isFinite(maxRecv)) {
    return Math.max(maxRecv, maxSend);
  }
  return maxSend;
}

/**
 * Compute max feedback RTT and min propagation RTT for a received-packet batch
 * (libwebrtc GoogCcNetworkController::OnTransportPacketsFeedback).
 *
 * For each received packet with send/recv times:
 * - feedback_rtt = feedback_time − send_time
 * - min_pending_time = max_recv_time − receive_time
 * - propagation_rtt = feedback_rtt − min_pending_time
 *
 * Returns undefined when there are no finite samples.
 * Prefer {@link feedbackTimeMsForRtt} for `feedbackTimeMs` so send/feedback
 * share a clock domain.
 */
export function computeFeedbackRttStats(
  packets: ReadonlyArray<{ sendMs: number; recvMs: number }>,
  feedbackTimeMs: number,
): { maxFeedbackRttMs: number; minPropagationRttMs: number } | undefined {
  if (!Number.isFinite(feedbackTimeMs) || packets.length === 0) {
    return undefined;
  }
  let maxRecvMs = Number.NEGATIVE_INFINITY;
  for (const p of packets) {
    if (Number.isFinite(p.recvMs) && p.recvMs > maxRecvMs) {
      maxRecvMs = p.recvMs;
    }
  }
  if (!Number.isFinite(maxRecvMs)) {
    return undefined;
  }

  let maxFeedbackRttMs = Number.NEGATIVE_INFINITY;
  let minPropagationRttMs = Number.POSITIVE_INFINITY;
  for (const p of packets) {
    if (!Number.isFinite(p.sendMs) || !Number.isFinite(p.recvMs)) {
      continue;
    }
    const feedbackRtt = feedbackTimeMs - p.sendMs;
    const minPending = maxRecvMs - p.recvMs;
    const propagationRtt = feedbackRtt - minPending;
    if (feedbackRtt > maxFeedbackRttMs) maxFeedbackRttMs = feedbackRtt;
    if (propagationRtt < minPropagationRttMs) {
      minPropagationRttMs = propagationRtt;
    }
  }
  if (
    !Number.isFinite(maxFeedbackRttMs) ||
    !Number.isFinite(minPropagationRttMs)
  ) {
    return undefined;
  }
  return {
    maxFeedbackRttMs: Math.max(0, maxFeedbackRttMs),
    minPropagationRttMs: Math.max(0, minPropagationRttMs),
  };
}
