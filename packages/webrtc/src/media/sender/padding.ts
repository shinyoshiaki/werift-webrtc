import { RtpHeader, RtpPacket } from "../../imports/rtp";
import type { BandwidthEstimator } from "./bandwidthEstimator";

/** Upper bound on bursts per drain, so a misbehaving estimator cannot spin forever. */
const kMaxPaddingBursts = 64;

/**
 * Append RFC 3550 padding to an RTP payload.
 * The last octet is the padding length (including itself); preceding pad bytes are zero.
 * @param paddingSize total padding octets in [1, 255]
 */
export function appendRfc3550Padding(
  payload: Buffer,
  paddingSize: number,
): Buffer {
  if (paddingSize < 1 || paddingSize > 255) {
    throw new Error(`invalid RTP padding size: ${paddingSize}`);
  }
  const pad = Buffer.alloc(paddingSize);
  pad.writeUInt8(paddingSize, paddingSize - 1);
  return payload.length === 0 ? pad : Buffer.concat([payload, pad]);
}

/**
 * Padding-only RTP on the **RTX** SSRC / payload type (pin libwebrtc
 * `GeneratePadding` with RTX). The sequence is assigned at send time.
 */
export function createRtxPaddingPacket({
  paddingSize,
  timestamp,
  payloadType,
  ssrc,
}: {
  paddingSize: number;
  timestamp: number;
  payloadType: number;
  ssrc: number;
}): RtpPacket {
  return new RtpPacket(
    new RtpHeader({
      sequenceNumber: 0,
      timestamp,
      payloadType,
      ssrc,
      extension: true,
      extensions: [],
      marker: false,
      padding: true,
      paddingSize,
      payloadOffset: 12,
    }),
    Buffer.alloc(0),
  );
}

/** What {@link PaddingInjector} needs from its sender. */
export interface PaddingHost {
  /** Active estimator (captured once per drain). */
  readonly estimator: BandwidthEstimator;
  /** Current estimator generation (captured once per drain). */
  readonly generation: number;
  /**
   * Padding may be sent now: not stopped, DTLS connected with a codec, and
   * an estimator that asks for padding plus negotiated TWCC and RTX.
   */
  canDrain(): boolean;
  /** Stopped, send-suppressed, or the estimator changed since `generation`. */
  isCancelled(generation: number): boolean;
  /** Media / RTX is waiting in the send FIFO; padding yields to it. */
  hasQueuedRealtimeMedia(): boolean;
  /**
   * Send one padding-only packet of `packetBytes` on the RTX stream.
   * `probe` tags it for the active probe cluster.
   */
  sendPadding(packetBytes: number, probe: boolean): Promise<void>;
}

/**
 * Drains the padding the estimator asks for: probe padding to fill a GCC
 * probe cluster that media alone did not fill, and loss padding while
 * LossBased is `kIncreaseUsingPadding`.
 *
 * Responsibility split: the estimator decides how much is needed
 * (`pendingProbePaddingPackets` / `pendingLossPaddingPackets`); the host
 * builds, paces and sends the packets. Only one drain runs per estimator
 * generation; a newer generation may start while an older loop unwinds.
 */
export class PaddingInjector {
  /** Generation that currently owns the drain, or `undefined`. */
  private flightGeneration: number | undefined;

  constructor(private readonly host: PaddingHost) {}

  /** Fill the active probe cluster, across bursts. Returns packets sent. */
  async drainProbe(): Promise<number> {
    const host = this.host;
    if (!host.canDrain()) {
      return 0;
    }
    // Capture estimator + generation for the whole async drain. On swap,
    // generation bumps and we stop — never call dispose()'d controllers.
    const generation = host.generation;
    if (this.flightGeneration === generation) {
      return 0;
    }
    const e = host.estimator;
    const packetBytes = e.probePaddingPacketBytes;
    const maxBurst = e.probePaddingMaxBurst;
    if (!(packetBytes > 0) || !(maxBurst > 0)) {
      return 0;
    }
    this.flightGeneration = generation;
    let totalSent = 0;
    try {
      // Drain the full probe cluster across multiple bursts if needed.
      // Without this, large clusters stall when only maxBurst packets are sent.
      for (let burst = 0; burst < kMaxPaddingBursts; burst++) {
        // stop() / setBandwidthEstimator cancelled this injection.
        if (host.isCancelled(generation)) break;
        const pending = e.pendingProbePaddingPackets(packetBytes);
        if (pending <= 0) break;
        if (host.hasQueuedRealtimeMedia()) break;
        const n = Math.min(pending, maxBurst);
        for (let i = 0; i < n; i++) {
          if (host.isCancelled(generation)) break;
          if (host.hasQueuedRealtimeMedia()) break;
          await host.sendPadding(packetBytes, true);
          if (host.isCancelled(generation)) break;
          totalSent++;
          if (host.hasQueuedRealtimeMedia()) break;
        }
      }
      return totalSent;
    } finally {
      if (this.flightGeneration === generation) {
        this.flightGeneration = undefined;
      }
    }
  }

  /**
   * One burst of regular (non-probe) padding while LossBased asks for it.
   * Probe padding takes priority. Returns packets sent.
   */
  async drainLoss(): Promise<number> {
    const host = this.host;
    if (!host.canDrain()) {
      return 0;
    }
    const generation = host.generation;
    if (this.flightGeneration === generation) return 0;
    const e = host.estimator;
    const packetBytes = e.probePaddingPacketBytes;
    const maxBurst = e.probePaddingMaxBurst;
    if (!(packetBytes > 0) || !(maxBurst > 0)) {
      return 0;
    }
    if (e.shouldTagProbePacket()) return 0;
    this.flightGeneration = generation;
    let totalSent = 0;
    try {
      const pending = e.pendingLossPaddingPackets(packetBytes);
      if (pending <= 0) return 0;
      const n = Math.min(pending, maxBurst);
      for (let i = 0; i < n; i++) {
        if (host.isCancelled(generation)) break;
        if (host.hasQueuedRealtimeMedia()) break;
        await host.sendPadding(packetBytes, false);
        if (host.isCancelled(generation)) break;
        totalSent++;
      }
      return totalSent;
    } finally {
      if (this.flightGeneration === generation) {
        this.flightGeneration = undefined;
      }
    }
  }
}
