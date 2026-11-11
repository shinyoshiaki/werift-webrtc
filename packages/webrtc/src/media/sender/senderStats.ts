import { uint32Add } from "../../imports/common";
import { RtcpSenderInfo, RtcpSrPacket } from "../../imports/rtp";
import type { Kind } from "../../types/domain";
import { compactNtp, ntpTime } from "../../utils";
import type { RTCRtpCodecParameters } from "../parameters";
import {
  generateCodecStatsId,
  generateStatsId,
  type RTCCodecStats,
  type RTCMediaSourceStats,
  type RTCOutboundRtpStreamStats,
  type RTCRemoteInboundRtpStreamStats,
  type RTCStats,
} from "../stats";
import { SenderReportHistory } from "./senderReportHistory";

/** EWMA weight of the previous RTT for `roundTripTime` in stats. */
const RTT_ALPHA = 0.85;
/**
 * A sent RTP timestamp at most this far behind the SR clock anchor is treated
 * as reordering (relay jitter, B-frames) and does not move the anchor. A larger
 * backward step is a source timestamp discontinuity without continuity rewrite.
 */
const RTP_CLOCK_ANCHOR_MAX_REORDER_SEC = 3;

/** The part of an RTCP reception report block this sender reads. */
export type ReceptionReport = {
  packetsLost: number;
  fractionLost: number;
  lsr: number;
  dlsr: number;
};

/** Sender identity / negotiation state the stats entries are built from. */
export type SenderStatsContext = {
  trackId: string;
  ssrc: number;
  kind: Kind;
  mid?: string;
  /** The DTLS transport, when one is set. */
  dtlsTransport?: { id: string };
  codec?: RTCRtpCodecParameters;
  /** RTX SSRC, only when RTX is negotiated. */
  rtxSsrc?: number;
  /** `trackIdentifier` of the attached track, when there is one. */
  trackIdentifier?: string;
};

/**
 * Send-side statistics of one {@link RTCRtpSender}: packet / byte counters,
 * remote reception reports (loss, RTT), and the RTCP Sender Report built from
 * them.
 */
export class SenderStatistics {
  packetCount = 0;
  octetCount = 0;
  headerBytesSent = 0;
  retransmittedPacketsSent = 0;
  retransmittedBytesSent = 0;
  nackCount = 0;
  pliCount = 0;
  firCount = 0;

  /** EWMA of the raw RR RTT samples (seconds). */
  private rtt?: number;
  private totalRoundTripTime = 0;
  private roundTripTimeMeasurements = 0;
  private remotePacketsLost?: number;
  private remoteFractionLost?: number;

  /** Sent SRs by LSR, so a report that references an older SR still gives an RTT. */
  private readonly senderReports = new SenderReportHistory();
  /**
   * NTP<->RTP clock anchor for RTCP Sender Reports (RFC 3550 §6.4.1).
   * The send time of the first packet of the newest RTP timestamp (output
   * timeline, after continuity rewrite) approximates that frame's sampling
   * instant; werift does not know the capture time, so for relayed RTP the
   * send jitter becomes SR mapping error. Later packets with the same or a
   * slightly older timestamp (frame fragments, reordered relay packets) and RTX
   * retransmissions do not move it. A continuity rewrite, a clock rate change
   * or a backward timestamp step beyond `RTP_CLOCK_ANCHOR_MAX_REORDER_SEC`
   * resets it (libwebrtc follows the last frame unconditionally).
   */
  private rtpClockAnchor?: {
    /** `performance.now()` when the anchor packet was sent */
    monotonicMs: number;
    rtpTimestamp: number;
    clockRate: number;
  };
  private rtpClockAnchorReset = false;

  /** A media packet left (counted in the SR). */
  recordMediaSent(headerBytes: number, payloadOctets: number) {
    this.headerBytesSent += headerBytes;
    this.packetCount = uint32Add(this.packetCount, 1);
    this.octetCount += payloadOctets;
  }

  /** A retransmission left (not counted in the SR packet / octet counts). */
  recordRetransmissionSent(headerBytes: number, payloadBytes: number) {
    this.retransmittedPacketsSent++;
    this.retransmittedBytesSent += payloadBytes;
    this.headerBytesSent += headerBytes;
  }

  /**
   * Record a reception report about this sender's SSRC.
   * @returns the raw RTT (seconds) when the report's LSR matches a recent SR.
   */
  recordReceptionReport(
    report: ReceptionReport,
    nowMonotonicMs = performance.now(),
  ): number | undefined {
    this.remotePacketsLost = report.packetsLost;
    this.remoteFractionLost = report.fractionLost / 256;
    const rawRttSeconds = this.senderReports.roundTripTime(
      report.lsr,
      report.dlsr,
      nowMonotonicMs / 1000,
    );
    if (rawRttSeconds === undefined) return;
    this.totalRoundTripTime += rawRttSeconds;
    this.roundTripTimeMeasurements++;
    // Stats / getStats keep an EWMA; the raw sample is returned for AIMD.
    if (this.rtt === undefined) {
      this.rtt = rawRttSeconds;
    } else {
      this.rtt = RTT_ALPHA * this.rtt + (1 - RTT_ALPHA) * rawRttSeconds;
    }
    return rawRttSeconds;
  }

  /** Forget the sent SRs (the sender stopped). */
  clearSenderReports() {
    this.senderReports.clear();
  }

  /** The output RTP timeline restarted (continuity rewrite). */
  resetClockAnchor() {
    this.rtpClockAnchorReset = true;
  }

  /**
   * Move the SR clock anchor to a sent packet with a newer timestamp, or to a
   * packet that steps back further than reordering can explain.
   */
  updateClockAnchor(rtpTimestamp: number, clockRate: number) {
    const anchor = this.rtpClockAnchor;
    if (anchor && !this.rtpClockAnchorReset && anchor.clockRate === clockRate) {
      // 32bit signed difference: handles timestamp wraparound
      const delta = (rtpTimestamp - anchor.rtpTimestamp) | 0;
      if (
        delta <= 0 &&
        -delta <= clockRate * RTP_CLOCK_ANCHOR_MAX_REORDER_SEC
      ) {
        return;
      }
    }
    this.rtpClockAnchorReset = false;
    this.rtpClockAnchor = {
      monotonicMs: performance.now(),
      rtpTimestamp,
      clockRate,
    };
  }

  /**
   * Build a Sender Report for the instant `nowMonotonicMs` (`performance.now()`).
   * The NTP timestamp is the wall-clock time of that instant and the RTP
   * timestamp is extrapolated from the clock anchor to the same instant with
   * the send clock rate, so an SR sent long after the last RTP packet (idle,
   * silence suppression) still maps the current time (as libwebrtc does).
   * Records the LSR of the NTP timestamp actually sent.
   */
  buildSenderReport(ssrc: number, nowMonotonicMs: number) {
    const ntpTimestamp = ntpTime(performance.timeOrigin + nowMonotonicMs);
    let rtpTimestamp = 0;
    const anchor = this.rtpClockAnchor;
    if (anchor) {
      const elapsedMs = Math.max(0, nowMonotonicMs - anchor.monotonicMs);
      rtpTimestamp = uint32Add(
        anchor.rtpTimestamp,
        Math.round((elapsedMs * anchor.clockRate) / 1000) % 0x1_0000_0000,
      );
    }

    this.senderReports.record(compactNtp(ntpTimestamp), nowMonotonicMs / 1000);

    return new RtcpSrPacket({
      ssrc,
      senderInfo: new RtcpSenderInfo({
        ntpTimestamp,
        rtpTimestamp,
        packetCount: this.packetCount,
        octetCount: this.octetCount,
      }),
    });
  }

  /**
   * outbound-rtp, media-source (with a track), codec (with a codec and a
   * transport), and remote-inbound-rtp (once a report arrived) entries.
   */
  collect(context: SenderStatsContext, timestamp: number): RTCStats[] {
    const stats: RTCStats[] = [];
    const transportId = context.dtlsTransport
      ? generateStatsId("transport", context.dtlsTransport.id)
      : undefined;
    const codec = context.codec;
    const codecId =
      codec && transportId
        ? generateCodecStatsId(transportId, codec.payloadType, context.trackId)
        : undefined;
    const hasRemote =
      this.remotePacketsLost !== undefined ||
      this.remoteFractionLost !== undefined;
    const mediaSourceId = senderStatsIds(context.trackId).mediaSource;
    const remoteInboundId = senderStatsIds(context.trackId).remoteInboundRtp;

    const outboundRtpStats: RTCOutboundRtpStreamStats = {
      type: "outbound-rtp",
      id: senderStatsIds(context.trackId).outboundRtp,
      timestamp,
      ssrc: context.ssrc,
      kind: context.kind,
      transportId,
      codecId,
      mid: context.mid,
      packetsSent: this.packetCount,
      bytesSent: this.octetCount,
      headerBytesSent: this.headerBytesSent,
      retransmittedPacketsSent: this.retransmittedPacketsSent || undefined,
      retransmittedBytesSent: this.retransmittedBytesSent || undefined,
      rtxSsrc: context.rtxSsrc,
      mediaSourceId:
        context.trackIdentifier !== undefined ? mediaSourceId : undefined,
      remoteId: hasRemote ? remoteInboundId : undefined,
      nackCount: this.nackCount || undefined,
      pliCount: this.pliCount || undefined,
      firCount: this.firCount || undefined,
    };
    stats.push(outboundRtpStats);

    if (context.trackIdentifier !== undefined) {
      const mediaSourceStats: RTCMediaSourceStats = {
        type: "media-source",
        id: mediaSourceId,
        timestamp,
        trackIdentifier: context.trackIdentifier,
        kind: context.kind,
      };
      stats.push(mediaSourceStats);
    }

    if (codec && transportId) {
      const codecStats: RTCCodecStats = {
        type: "codec",
        id: codecId!,
        timestamp,
        payloadType: codec.payloadType,
        transportId,
        mimeType: codec.mimeType,
        clockRate: codec.clockRate,
        channels: codec.channels,
        sdpFmtpLine: codec.parameters,
      };
      stats.push(codecStats);
    }

    if (hasRemote) {
      const remoteInboundStats: RTCRemoteInboundRtpStreamStats = {
        type: "remote-inbound-rtp",
        id: remoteInboundId,
        timestamp,
        ssrc: context.ssrc,
        kind: context.kind,
        transportId,
        codecId: outboundRtpStats.codecId,
        localId: outboundRtpStats.id,
        roundTripTime: this.rtt,
        totalRoundTripTime: this.totalRoundTripTime,
        roundTripTimeMeasurements: this.roundTripTimeMeasurements,
        packetsLost: this.remotePacketsLost,
        fractionLost: this.remoteFractionLost,
      };
      stats.push(remoteInboundStats);
    }

    return stats;
  }
}

/** Stats ids of the entries a sender reports, keyed by its track id. */
export function senderStatsIds(trackId: string) {
  return {
    outboundRtp: generateStatsId("outbound-rtp", trackId),
    mediaSource: generateStatsId("media-source", trackId),
    remoteInboundRtp: generateStatsId("remote-inbound-rtp", trackId),
  };
}
