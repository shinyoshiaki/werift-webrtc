import { Event } from "../../imports/common";
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
  /**
   * pin `PacedPacketInfo.probe_cluster_id` reserved **before** send.
   * ProbeController must attribute this packet to this cluster, not
   * whatever is current when the async send completes.
   */
  probeClusterId?: number;
  /**
   * pin `SentPacket.prior_unacked_data` — untracked bytes attributed to
   * the next TWCC-tracked packet (RobustThroughputEstimator).
   */
  priorUnackedBytes?: number;
  /** True when this packet is an RTX / retransmission. */
  isRetransmission?: boolean;
  /** Wall-clock send time in milliseconds. */
  sendingAtMs: number;
  /** Wall-clock time when the send completed in milliseconds. */
  sentAtMs: number;
}

/**
 * Probe cluster the sender should temporarily aim for (padding / encoder ramp).
 * GCC fires {@link BandwidthEstimator.onProbeClusterConfig} with this payload;
 * legacy / disabled estimators never emit it.
 */
export interface ProbeClusterConfig {
  id: number;
  /** Target bitrate the pacer / sender should temporarily aim for (bps). */
  targetBps: number;
  minPackets: number;
  minDurationMs: number;
  /** Minimum bytes expected for the cluster (for receive-ratio checks). */
  minBytes: number;
  /**
   * pin `ProbeClusterConfig.min_probe_delta` (ms). Used for
   * RecommendedMinProbeSize and stored on the BitrateProber cluster.
   */
  minProbeDeltaMs: number;
  /** pin `requested_at` — queue age for the 5s queued-cluster timeout. */
  requestedAtMs: number;
}

/** Reservation taken **before** the async send (pin `CurrentCluster`). */
export interface ProbeReservation {
  clusterId: number;
  /** Next allowed send time (MinusInfinity → send immediately). */
  nextSendTimeMs: number;
}

/**
 * Common contract for send-side bandwidth estimators driven by TWCC feedback.
 *
 * TWCC I/O and recommended bitrate (`rtpPacketSent` / `receiveTWCC` /
 * `availableBitrate` / `onAvailableBitrate`) are required. GCC also needs
 * probe / pacing / RTT / process-interval hooks; those live on this same
 * interface so {@link RTCRtpSender} does not import GCC. Legacy and disabled
 * estimators implement them as no-ops (`processIntervalMs === 0`, padding
 * sizes 0, methods return false / 0 / undefined).
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

  /**
   * Fires when a probe cluster is activated. Legacy / disabled never fire.
   */
  readonly onProbeClusterConfig: Event<[ProbeClusterConfig]>;

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

  /**
   * Sender-clock process interval in milliseconds (pin GoogCc 25ms).
   * `0` — do not run a process timer (legacy / disabled).
   */
  readonly processIntervalMs: number;

  /**
   * RTP padding size used when the sender injects probe / loss padding.
   * `0` — do not inject padding (legacy / disabled).
   */
  readonly probePaddingPacketBytes: number;

  /**
   * Max padding packets per inner send burst. `0` when padding is disabled.
   */
  readonly probePaddingMaxBurst: number;

  /** Tag the next outgoing packet as a probe (`SentInfo.isProbation`). */
  shouldTagProbePacket(): boolean;

  /**
   * Pacing target (bps) for the send engine.
   * pin GetPacingRates: estimate × 2.5 before first TWCC, × 1.1 after,
   * raised to the active probe target while probing.
   * `0` — do not token-bucket pace (legacy / disabled).
   */
  getPacingBitrateBps(): number;

  /**
   * pin `BitrateProber::CurrentCluster` — reserve the active probe cluster
   * **before** the packet is sent (not at send-complete callback).
   */
  reserveOutgoingProbe(nowMs: number): ProbeReservation | undefined;

  /**
   * Number of padding packets the sender should inject to fill the active
   * probe cluster when media alone is insufficient.
   */
  pendingProbePaddingPackets(packetBytes?: number): number;

  /**
   * pin `GetPacingRates` padding_rate while loss-limited
   * `kIncreaseUsingPadding`. 0 when not in that state.
   */
  getPaddingBitrateBps(): number;

  /**
   * Padding packets to send to approach {@link getPaddingBitrateBps} when
   * media is sparse. Not probe/probation packets.
   */
  pendingLossPaddingPackets(packetBytes?: number): number;

  /**
   * Raw round-trip time in **milliseconds** (not TWCC propagation RTT).
   * Pin GoogCc ignores smoothed RTT and only applies unsmoothed updates.
   */
  setRoundTripTime(rttMs: number): void;

  /** True when ICE/DTLS (or equivalent) can emit RTP. */
  setNetworkAvailable(available: boolean): void;

  /**
   * Advance sender-clock estimator state at `nowMs` (milliseconds).
   * Does not count as a sent packet — CorrectedRtt timeout only grows on
   * `rtpPacketSent`.
   */
  process(nowMs: number): void;
}

/**
 * GCC-oriented probe / pacing subset of {@link BandwidthEstimator}.
 * Legacy implements these as no-ops; use {@link isProbePacingController} to
 * detect an estimator that actually injects probe padding.
 */
export type ProbePacingController = Pick<
  BandwidthEstimator,
  | "shouldTagProbePacket"
  | "getPacingBitrateBps"
  | "reserveOutgoingProbe"
  | "pendingProbePaddingPackets"
  | "getPaddingBitrateBps"
  | "pendingLossPaddingPackets"
>;

/**
 * True when the estimator actually drives probe padding (non-zero padding size).
 * Legacy / disabled no-ops return false.
 */
export function isProbePacingController(
  e: BandwidthEstimator,
): e is BandwidthEstimator & ProbePacingController {
  return e.probePaddingPacketBytes > 0;
}

/** RTCP / network RTT consumer (pin OnRoundTripTimeUpdate). */
export type RoundTripTimeConsumer = Pick<
  BandwidthEstimator,
  "setRoundTripTime"
>;

/**
 * True when the estimator consumes RTCP RTT for AIMD (non-zero process interval).
 * Legacy / disabled `setRoundTripTime` is a no-op.
 */
export function isRoundTripTimeConsumer(
  e: BandwidthEstimator,
): e is BandwidthEstimator & RoundTripTimeConsumer {
  return e.processIntervalMs > 0;
}

/** pin `OnNetworkAvailability` consumer. */
export type NetworkAvailabilityConsumer = Pick<
  BandwidthEstimator,
  "setNetworkAvailable"
>;

export function isNetworkAvailabilityConsumer(
  e: BandwidthEstimator,
): e is BandwidthEstimator & NetworkAvailabilityConsumer {
  return e.processIntervalMs > 0;
}

/** pin GoogCc `OnProcessInterval` surface. */
export type BandwidthEstimatorProcessor = Pick<BandwidthEstimator, "process">;

/** True when the sender should run a process timer (`processIntervalMs > 0`). */
export function isBandwidthEstimatorProcessor(
  e: BandwidthEstimator,
): e is BandwidthEstimator & BandwidthEstimatorProcessor {
  return e.processIntervalMs > 0;
}

/**
 * Shared no-op implementations of GCC send-path hooks.
 * {@link SenderBandwidthEstimator} and {@link DisabledBandwidthEstimator} extend this.
 */
export abstract class BandwidthEstimatorNoopHooks {
  readonly processIntervalMs = 0;
  readonly probePaddingPacketBytes = 0;
  readonly probePaddingMaxBurst = 0;
  readonly onProbeClusterConfig = new Event<[ProbeClusterConfig]>();

  shouldTagProbePacket(): boolean {
    return false;
  }

  getPacingBitrateBps(): number {
    return 0;
  }

  reserveOutgoingProbe(_nowMs: number): ProbeReservation | undefined {
    return undefined;
  }

  pendingProbePaddingPackets(_packetBytes?: number): number {
    return 0;
  }

  getPaddingBitrateBps(): number {
    return 0;
  }

  pendingLossPaddingPackets(_packetBytes?: number): number {
    return 0;
  }

  setRoundTripTime(_rttMs: number): void {}

  setNetworkAvailable(_available: boolean): void {}

  process(_nowMs: number): void {}

  protected disposeNoopHooks(): void {
    this.onProbeClusterConfig.allUnsubscribe();
  }
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
