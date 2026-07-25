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
 * Limited to TWCC I/O + recommended bitrate. Probe / pacing hooks live on
 * {@link ProbePacingController} so the shared surface stays thin.
 */
export interface BandwidthEstimator {
  /**
   * Recommended / estimated available send bitrate in **bps**.
   * May remain `0` until TWCC is negotiated and enough samples are collected.
   */
  readonly availableBitrate: number;

  /**
   * Fires when the recommended send bitrate (**bps**) **changes**.
   * Unit is always bits per second (bps). Change-only (not every recompute).
   */
  readonly onAvailableBitrate: Event<[number]>;

  /** Record an outgoing RTP packet for later matching against TWCC feedback. */
  rtpPacketSent(info: SentInfo): void;

  /** Process a Transport-Wide CC RTCP feedback packet and update the estimate. */
  receiveTWCC(feedback: TransportWideCC): void;

  /** Clear internal history / estimates. */
  reset?(): void;

  /**
   * Release listeners / timers when the sender replaces the estimator.
   * {@link RTCRtpSender} rebinds its stable `onAvailableBitrate` bridge after dispose.
   */
  dispose?(): void;
}

/**
 * Optional probe / pacing control surface used by {@link RTCRtpSender}.
 *
 * Not part of the common {@link BandwidthEstimator} contract — only estimators
 * that implement probing (e.g. GCC) need this. Use {@link isProbePacingController}.
 */
export interface ProbePacingController {
  /** Tag the next outgoing packet as a probe (`SentInfo.isProbation`). */
  shouldTagProbePacket(): boolean;

  /**
   * Pacing target (bps) for the send engine.
   * Typically `max(availableBitrate, activeProbeTarget)`.
   */
  getPacingBitrateBps(): number;

  /**
   * Number of padding packets the sender should inject to fill the active
   * probe cluster when media alone is insufficient.
   */
  pendingProbePaddingPackets(packetBytes?: number): number;
}

/** Type guard for estimators that drive probe padding / pacing. */
export function isProbePacingController(
  e: BandwidthEstimator,
): e is BandwidthEstimator & ProbePacingController {
  const c = e as BandwidthEstimator & Partial<ProbePacingController>;
  return (
    typeof c.shouldTagProbePacket === "function" &&
    typeof c.getPacingBitrateBps === "function" &&
    typeof c.pendingProbePaddingPackets === "function"
  );
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
