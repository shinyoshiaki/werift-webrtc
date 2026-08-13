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
 * Limited to TWCC I/O + recommended bitrate (`rtpPacketSent` / `receiveTWCC` /
 * `availableBitrate` / `onAvailableBitrate`). Algorithm-specific inputs such as
 * probe pacing or RTCP RTT live on separate capability interfaces so the shared
 * surface stays thin.
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

  /**
   * pin `GetPacingRates` padding_rate while loss-limited
   * `kIncreaseUsingPadding`. 0 when not in that state.
   */
  getPaddingBitrateBps?(): number;

  /**
   * Padding packets to send to approach {@link getPaddingBitrateBps} when
   * media is sparse. Not probe/probation packets.
   */
  pendingLossPaddingPackets?(packetBytes?: number): number;
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
 * Optional RTCP / network RTT consumer (pin OnRoundTripTimeUpdate).
 *
 * Not part of the common {@link BandwidthEstimator} contract. Pin discards
 * **smoothed** RTT updates and feeds **raw** RTT into AIMD — callers must pass
 * the per-report raw sample, not a stats-smoothed value.
 */
export interface RoundTripTimeConsumer {
  /**
   * Raw round-trip time in **milliseconds** (not TWCC propagation RTT).
   * Pin GoogCc ignores smoothed RTT and only applies unsmoothed updates.
   */
  setRoundTripTime(rttMs: number): void;
}

/** Type guard for estimators that consume RTCP RTT (e.g. GCC AIMD). */
export function isRoundTripTimeConsumer(
  e: BandwidthEstimator,
): e is BandwidthEstimator & RoundTripTimeConsumer {
  const c = e as BandwidthEstimator & Partial<RoundTripTimeConsumer>;
  return typeof c.setRoundTripTime === "function";
}

/**
 * Optional pin `OnNetworkAvailability` consumer.
 *
 * Not part of the common {@link BandwidthEstimator} contract. Initial
 * exponential probing must not start until the transport can actually send.
 */
export interface NetworkAvailabilityConsumer {
  /** True when ICE/DTLS (or equivalent) can emit RTP. */
  setNetworkAvailable(available: boolean): void;
}

export function isNetworkAvailabilityConsumer(
  e: BandwidthEstimator,
): e is BandwidthEstimator & NetworkAvailabilityConsumer {
  const c = e as BandwidthEstimator & Partial<NetworkAvailabilityConsumer>;
  return typeof c.setNetworkAvailable === "function";
}

/**
 * Optional periodic process surface (pin GoogCc `OnProcessInterval`).
 *
 * Not part of the common {@link BandwidthEstimator} contract. Callers (e.g.
 * {@link RTCRtpSender} RTCP loop) advance sender-clock work such as RTT-based
 * target backoff while media may be idle.
 */
export interface BandwidthEstimatorProcessor {
  /**
   * Advance sender-clock estimator state at `nowMs` (milliseconds).
   * Does not count as a sent packet — CorrectedRtt timeout only grows on
   * `rtpPacketSent`.
   */
  process(nowMs: number): void;
}

/** Type guard for estimators that expose pin ProcessInterval-style process. */
export function isBandwidthEstimatorProcessor(
  e: BandwidthEstimator,
): e is BandwidthEstimator & BandwidthEstimatorProcessor {
  const c = e as BandwidthEstimator & Partial<BandwidthEstimatorProcessor>;
  return typeof c.process === "function";
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
