import type { Event } from "../../imports/common";
import type { TransportWideCC } from "../../imports/rtp";

/**
 * Sent RTP packet observation used as input to send-side BWE algorithms.
 * Transport-wide sequence numbers come from the shared DTLS transport clock.
 */
export interface SentInfo {
  wideSeq: number;
  /** Packet size in bytes (on-wire after SRTP when measured by the sender). */
  size: number;
  /** Optional flag for probe / probation packets used by some estimators (e.g. GCC). */
  isProbation?: boolean;
  /** Wall-clock send time in milliseconds. */
  sendingAtMs: number;
  /** Wall-clock time when the send completed in milliseconds. */
  sentAtMs: number;
}

/**
 * Common contract for send-side bandwidth estimators driven by TWCC feedback.
 *
 * TWCC ({@link https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01})
 * only defines the feedback transport; the estimation algorithm is pluggable.
 *
 * The shared output is limited to the recommended send bitrate (`availableBitrate`)
 * and its change notifications. Algorithm-specific signals (congestion score,
 * overuse, probe state, …) stay on concrete implementations.
 */
export interface BandwidthEstimator {
  /**
   * Recommended / estimated available send bitrate in **bps**.
   * May remain `0` until TWCC is negotiated and enough samples are collected.
   */
  readonly availableBitrate: number;

  /**
   * Fires when the recommended send bitrate (**bps**) **changes**.
   *
   * - Fired on the first valid estimate and whenever the value differs from the previous notification.
   * - Not fired when the estimator re-computes the same bitrate.
   * - Unit is always bits per second (bps).
   *
   * Application bitrate adaptation should subscribe to this event. Algorithm-specific
   * events (legacy congestion score, GCC overuse, …) are only available on concrete types.
   */
  readonly onAvailableBitrate: Event<[number]>;

  /** Record an outgoing RTP packet for later matching against TWCC feedback. */
  rtpPacketSent(info: SentInfo): void;

  /** Process a Transport-Wide CC RTCP feedback packet and update the estimate. */
  receiveTWCC(feedback: TransportWideCC): void;

  /**
   * When true, the next outgoing RTP packet should be tagged as a probe
   * (`SentInfo.isProbation`) so the estimator can attribute probe clusters.
   * Optional; only estimators that implement bandwidth probing need this.
   */
  shouldTagProbePacket?(): boolean;

  /**
   * Optional pacing target (bps) for the send engine.
   * While probing this is typically `max(availableBitrate, probeTarget)`.
   * {@link RTCRtpSender} uses this for its lightweight token-bucket pacer.
   */
  getPacingBitrateBps?(): number;

  /**
   * Clear internal history / estimates (e.g. after estimator swap or transport restart).
   * Optional for lightweight implementations.
   */
  reset?(): void;

  /**
   * Release listeners / timers. Optional; called when the sender replaces the estimator.
   *
   * Implementations that clear `onAvailableBitrate` subscribers should be aware
   * that {@link RTCRtpSender} rebinds its stable `onAvailableBitrate` bridge after
   * dispose — callers of the sender event do not need to re-subscribe on swap.
   */
  dispose?(): void;
}

/**
 * Helper for concrete estimators: assign `availableBitrate` only when it changes
 * and notify `onAvailableBitrate` with the new value in bps.
 */
export function setAvailableBitrateIfChanged(
  target: {
    _availableBitrate: number;
    onAvailableBitrate: Event<[number]>;
  },
  nextBps: number,
): boolean {
  const v = Math.max(0, Math.round(nextBps));
  if (v === target._availableBitrate) {
    return false;
  }
  target._availableBitrate = v;
  target.onAvailableBitrate.execute(v);
  return true;
}
