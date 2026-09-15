import { randomUUID } from "crypto";
import { setTimeout } from "timers/promises";
import { Event, int } from "../imports/common";

import {
  type Extensions,
  PictureLossIndication,
  RTP_EXTENSION_URI,
  Red,
  RedHandler,
  type RtcpPacket,
  RtcpPayloadSpecificFeedback,
  RtcpReceiverInfo,
  RtcpRrPacket,
  RtcpSrPacket,
  type RtpPacket,
  type TransportWideCCPayload,
  debug,
  isPaddingOnlyRtpPacket,
  unwrapRtx,
} from "../imports/rtp";
import type { PeerConfig } from "../peerConnection";
import type { RTCDtlsTransport } from "../transport/dtls";
import type { Kind } from "../types/domain";
import { compactNtp, ntpTimeToEpochMs, timestampSeconds } from "../utils";
import type {
  RTCRtpCodecParameters,
  RTCRtpReceiveParameters,
} from "./parameters";
import { NackHandler } from "./receiver/nack";
import {
  type ReceiverTWCC,
  acquireTransportReceiverTWCC,
  releaseTransportReceiverTWCC,
} from "./receiver/receiverTwcc";
import { StreamStatistics } from "./receiver/statistics";

import { codecParametersFromString } from "../sdp";
import { usePLI, useTWCC } from "./extension/rtcpFeedback";
import {
  type RTCCodecStats,
  type RTCInboundRtpStreamStats,
  type RTCRemoteOutboundRtpStreamStats,
  type RTCStats,
  type RTCStatsReport,
  buildStatsReport,
  generateCodecStatsId,
  generateStatsId,
  getStatsTimestamp,
} from "./stats";
import {
  MediaStreamTrack,
  type RtpReceiveInfo,
  RtpReceivePacketType,
} from "./track";

const log = debug("werift:packages/webrtc/src/media/rtpReceiver.ts");

export class RTCRtpReceiver {
  private readonly codecs: { [pt: number]: RTCRtpCodecParameters } = {};
  private readonly defaultTrack: MediaStreamTrack;
  private get codecArray() {
    return Object.values(this.codecs).sort(
      (a, b) => a.payloadType - b.payloadType,
    );
  }
  private readonly ssrcByRtx: { [rtxSsrc: number]: number } = {};
  private readonly nack = new NackHandler(this);
  private readonly audioRedHandler = new RedHandler();

  readonly type = "receiver";
  readonly uuid = randomUUID().toString();
  readonly tracks: MediaStreamTrack[] = [];
  readonly trackBySSRC: { [ssrc: string]: MediaStreamTrack } = {};
  readonly trackByRID: { [rid: string]: MediaStreamTrack } = {};
  /**last sender Report Timestamp
   * compactNtp
   */
  readonly lastSRtimestamp: { [ssrc: number]: number } = {};
  /**seconds */
  readonly receiveLastSRTimestamp: { [ssrc: number]: number } = {};
  readonly onPacketLost = this.nack.onPacketLost;
  readonly onRtcp = new Event<[RtcpPacket]>();

  dtlsTransport!: RTCDtlsTransport;
  sdesMid?: string;
  latestRid?: string;
  latestRepairedRid?: string;

  receiverTWCC?: ReceiverTWCC;
  stopped = false;
  remoteStreamId?: string;
  remoteStreamIds: string[] = [];
  remoteTrackId?: string;

  rtcpRunning = false;
  private rtcpCancel = new AbortController();
  private remoteStreams: { [ssrc: number]: StreamStatistics } = {};
  private senderReportsReceivedBySsrc: { [ssrc: number]: number } = {};
  private remoteTimestampsBySsrc: { [ssrc: number]: number } = {};
  private remotePacketCountBySsrc: { [ssrc: number]: number } = {};
  private remoteOctetCountBySsrc: { [ssrc: number]: number } = {};
  private nackCountBySsrc: { [ssrc: number]: number } = {};
  private pliCountBySsrc: { [ssrc: number]: number } = {};
  /**
   * Per-SSRC compaction of {@link MediaStreamTrack.onReceiveRtp} sequence
   * numbers when probe padding is filtered. Uses extended sequence numbers so
   * late padding cannot rewrite packets already delivered past that seq.
   */
  private probePaddingCompactBySsrc: {
    [ssrc: number]: ProbePaddingCompactState;
  } = {};

  constructor(
    readonly config: PeerConfig,
    public kind: Kind,
    public rtcpSsrc: number,
  ) {
    this.defaultTrack = new MediaStreamTrack({ kind, remote: true });
    this.onPacketLost.subscribe((nack) => {
      this.nackCountBySsrc[nack.mediaSourceSsrc] =
        (this.nackCountBySsrc[nack.mediaSourceSsrc] ?? 0) + 1;
    });
  }

  get transport() {
    return this.dtlsTransport ?? null;
  }

  setDtlsTransport(dtls: RTCDtlsTransport) {
    this.dtlsTransport = dtls;
  }

  // todo fix
  get track() {
    return this.tracks[0] ?? this.defaultTrack;
  }

  get nackEnabled() {
    return this.codecArray[0]?.rtcpFeedback.find((f) => f.type === "nack");
  }

  get twccEnabled() {
    return this.codecArray[0]?.rtcpFeedback.find(
      (f) => f.type === useTWCC().type,
    );
  }

  get pliEnabled() {
    return this.codecArray[0]?.rtcpFeedback.find(
      (f) => f.type === usePLI().type,
    );
  }

  prepareReceive(params: RTCRtpReceiveParameters) {
    params.codecs.forEach((c) => {
      this.codecs[c.payloadType] = c;
    });
    params.encodings.forEach((e) => {
      if (e.rtx) {
        this.ssrcByRtx[e.rtx.ssrc] = e.ssrc;
      }
    });
  }

  /**
   * Attach this receiver to the DTLS-transport-scoped TWCC generator.
   * BUNDLE audio/video share one {@link ReceiverTWCC} so interleaved
   * transport-wide sequences are not reported as loss.
   */
  setupTWCC(mediaSourceSsrc: number) {
    if (!this.twccEnabled || !this.dtlsTransport) {
      return;
    }
    if (!this.receiverTWCC) {
      this.receiverTWCC = acquireTransportReceiverTWCC(
        this.dtlsTransport,
        this.rtcpSsrc,
        mediaSourceSsrc,
      );
      return;
    }
    this.receiverTWCC.setMediaSourceSsrc(mediaSourceSsrc);
  }

  addTrack(track: MediaStreamTrack) {
    const exist = this.tracks.find((t) => {
      if (t.rid) {
        return t.rid === track.rid;
      }
      if (t.ssrc) {
        return t.ssrc === track.ssrc;
      }
    });
    if (exist) {
      return false;
    }
    this.tracks.push(track);
    if (track.ssrc) {
      this.trackBySSRC[track.ssrc] = track;
    }
    if (track.rid) {
      this.trackByRID[track.rid] = track;
    }
    return true;
  }

  stop() {
    this.stopped = true;
    this.rtcpRunning = false;
    this.rtcpCancel.abort();

    if (this.receiverTWCC && this.dtlsTransport) {
      releaseTransportReceiverTWCC(this.dtlsTransport, this.receiverTWCC);
    }
    this.receiverTWCC = undefined;
    this.nack.close();
  }

  async runRtcp() {
    if (this.rtcpRunning || this.stopped) return;
    this.rtcpRunning = true;

    try {
      while (this.rtcpRunning) {
        await setTimeout(500 + Math.random() * 1000, undefined, {
          signal: this.rtcpCancel.signal,
        });

        const reports = Object.entries(this.remoteStreams).map(
          ([ssrc, stream]) => {
            let lastSRtimestamp = 0,
              delaySinceLastSR = 0;
            if (this.lastSRtimestamp[ssrc]) {
              lastSRtimestamp = this.lastSRtimestamp[ssrc];
              const delaySeconds =
                timestampSeconds() - this.receiveLastSRTimestamp[ssrc];
              if (delaySeconds > 0 && delaySeconds < 65536) {
                delaySinceLastSR = int(delaySeconds * 65536);
              }
            }

            return new RtcpReceiverInfo({
              ssrc: Number(ssrc),
              fractionLost: stream.fraction_lost,
              packetsLost: stream.packets_lost,
              highestSequence: stream.max_seq,
              jitter: stream.jitter,
              lsr: lastSRtimestamp,
              dlsr: delaySinceLastSR,
            });
          },
        );

        const packet = new RtcpRrPacket({ ssrc: this.rtcpSsrc, reports });

        try {
          if (this.config.debug.receiverReportDelay) {
            await setTimeout(this.config.debug.receiverReportDelay);
          }
          await this.dtlsTransport.sendRtcp([packet]);
        } catch (error) {
          log("sendRtcp failed", error);
          await setTimeout(500 + Math.random() * 1000);
        }
      }
    } catch (error) {}
  }

  private getInboundRtpStatsId(track: MediaStreamTrack) {
    return generateStatsId("inbound-rtp", track.id ?? track.uuid);
  }

  private getRemoteOutboundRtpStatsId(track: MediaStreamTrack) {
    return generateStatsId("remote-outbound-rtp", track.id ?? track.uuid);
  }

  getStatsRootIds(selector?: MediaStreamTrack) {
    return this.tracks
      .filter((track) => (!selector ? true : track === selector))
      .filter((track) => track.ssrc)
      .map((track) => this.getInboundRtpStatsId(track));
  }

  collectStats(timestamp: number): RTCStats[] {
    const stats: RTCStats[] = [];
    const transportId = this.dtlsTransport
      ? generateStatsId("transport", this.dtlsTransport.id)
      : undefined;
    const activeCodec = this.codecArray[0];
    const emittedCodecIds = new Set<string>();

    // Collect stats for each track
    for (const track of this.tracks) {
      if (!track.ssrc) continue;

      const streamStats = this.remoteStreams[track.ssrc];

      // Inbound RTP stats
      const hasRemoteTimestamp =
        this.remoteTimestampsBySsrc[track.ssrc] !== undefined;
      const remoteId =
        this.lastSRtimestamp[track.ssrc] !== undefined || hasRemoteTimestamp
          ? this.getRemoteOutboundRtpStatsId(track)
          : undefined;
      const codecId =
        activeCodec && transportId
          ? generateCodecStatsId(
              transportId,
              activeCodec.payloadType,
              track.id ?? track.uuid,
            )
          : undefined;

      if (
        activeCodec &&
        transportId &&
        codecId &&
        !emittedCodecIds.has(codecId)
      ) {
        emittedCodecIds.add(codecId);
        const codecStats: RTCCodecStats = {
          type: "codec",
          id: codecId,
          timestamp,
          payloadType: activeCodec.payloadType,
          transportId,
          mimeType: activeCodec.mimeType,
          clockRate: activeCodec.clockRate,
          channels: activeCodec.channels,
          sdpFmtpLine: activeCodec.parameters,
        };
        stats.push(codecStats);
      }

      const inboundRtpStats: RTCInboundRtpStreamStats = {
        type: "inbound-rtp",
        id: this.getInboundRtpStatsId(track),
        timestamp,
        ssrc: track.ssrc,
        kind: this.kind,
        transportId,
        codecId,
        mid: this.sdesMid,
        trackIdentifier: track.id ?? track.uuid,
        packetsReceived: streamStats?.packets_received ?? 0,
        bytesReceived: streamStats?.bytesReceived ?? 0,
        headerBytesReceived: streamStats?.headerBytesReceived ?? 0,
        packetsLost: streamStats?.packets_lost ?? 0,
        jitter: streamStats?.clockRate
          ? streamStats.jitter / streamStats.clockRate
          : undefined,
        lastPacketReceivedTimestamp: streamStats?.lastPacketReceivedTimestamp,
        remoteId,
        nackCount: this.nackCountBySsrc[track.ssrc] || undefined,
        pliCount: this.pliCountBySsrc[track.ssrc] || undefined,
      };
      stats.push(inboundRtpStats);

      // Remote outbound RTP stats (if we have SR info)
      if (remoteId) {
        const remoteOutboundStats: RTCRemoteOutboundRtpStreamStats = {
          type: "remote-outbound-rtp",
          id: this.getRemoteOutboundRtpStatsId(track),
          timestamp,
          ssrc: track.ssrc,
          kind: this.kind,
          transportId,
          codecId: inboundRtpStats.codecId,
          localId: inboundRtpStats.id,
          remoteTimestamp: this.remoteTimestampsBySsrc[track.ssrc],
          reportsSent: this.senderReportsReceivedBySsrc[track.ssrc] ?? 0,
          packetsSent: this.remotePacketCountBySsrc[track.ssrc],
          bytesSent: this.remoteOctetCountBySsrc[track.ssrc],
        };
        stats.push(remoteOutboundStats);
      }
    }

    return stats;
  }

  async getStats(): Promise<RTCStatsReport> {
    const timestamp = getStatsTimestamp();
    const stats = this.collectStats(timestamp);

    if (this.dtlsTransport) {
      stats.push(...(await this.dtlsTransport.getStats(timestamp)));
    }

    return buildStatsReport(stats, this.getStatsRootIds());
  }

  async sendRtcpPLI(mediaSsrc: number) {
    if (!this.pliEnabled) {
      log("pli not supported", { mediaSsrc });
      return;
    }

    if (this.stopped) {
      return;
    }

    log("sendRtcpPLI", { mediaSsrc });

    const packet = new RtcpPayloadSpecificFeedback({
      feedback: new PictureLossIndication({
        senderSsrc: this.rtcpSsrc,
        mediaSsrc,
      }),
    });
    try {
      this.pliCountBySsrc[mediaSsrc] =
        (this.pliCountBySsrc[mediaSsrc] ?? 0) + 1;
      await this.dtlsTransport.sendRtcp([packet]);
    } catch (error) {
      log(error);
    }
  }

  handleRtcpPacket(packet: RtcpPacket) {
    switch (packet.type) {
      case RtcpSrPacket.type:
        {
          const sr = packet as RtcpSrPacket;
          this.lastSRtimestamp[sr.ssrc] = compactNtp(
            sr.senderInfo.ntpTimestamp,
          );
          this.receiveLastSRTimestamp[sr.ssrc] = timestampSeconds();
          this.senderReportsReceivedBySsrc[sr.ssrc] =
            (this.senderReportsReceivedBySsrc[sr.ssrc] ?? 0) + 1;
          this.remoteTimestampsBySsrc[sr.ssrc] = ntpTimeToEpochMs(
            sr.senderInfo.ntpTimestamp,
          );
          this.remotePacketCountBySsrc[sr.ssrc] = sr.senderInfo.packetCount;
          this.remoteOctetCountBySsrc[sr.ssrc] = sr.senderInfo.octetCount;

          const track = this.trackBySSRC[packet.ssrc];
          if (track) {
            track.onReceiveRtcp.execute(packet);
          }
        }
        break;
    }
    this.onRtcp.execute(packet);
  }

  handleRtpBySsrc = (packet: RtpPacket, extensions: Extensions) => {
    const track = this.trackBySSRC[packet.header.ssrc];

    this.handleRTP(packet, extensions, track);
  };

  handleRtpByRid = (packet: RtpPacket, rid: string, extensions: Extensions) => {
    const track = this.trackByRID[rid];
    if (!this.trackBySSRC[packet.header.ssrc]) {
      this.trackBySSRC[packet.header.ssrc] = track;
    }

    this.handleRTP(packet, extensions, track);
  };

  private handleRTP(
    packet: RtpPacket,
    extensions: Extensions,
    track?: MediaStreamTrack,
  ) {
    if (this.stopped) {
      return;
    }

    const codec = this.codecs[packet.header.payloadType];
    if (!codec) {
      // log("unknown codec " + packet.header.payloadType);
      return;
    }

    this.remoteStreams[packet.header.ssrc] =
      this.remoteStreams[packet.header.ssrc] ??
      new StreamStatistics(codec.clockRate);
    this.remoteStreams[packet.header.ssrc].add(packet);

    if (!this.receiverTWCC && this.twccEnabled) {
      this.setupTWCC(packet.header.ssrc);
    }
    if (this.receiverTWCC) {
      const transportSequenceNumber = extensions[
        RTP_EXTENSION_URI.transportWideCC
      ] as TransportWideCCPayload;

      if (transportSequenceNumber !== undefined) {
        this.receiverTWCC.setMediaSourceSsrc?.(packet.header.ssrc);
        this.receiverTWCC.handleTWCC(transportSequenceNumber);
      }
    }

    const paddingOnly = isPaddingOnlyRtpPacket(packet);
    let receiveType: RtpReceivePacketType = paddingOnly
      ? RtpReceivePacketType.padding
      : RtpReceivePacketType.media;

    if (!paddingOnly && codec.name.toLowerCase() === "rtx") {
      const originalSsrc = this.ssrcByRtx[packet.header.ssrc];
      const codecParams = codecParametersFromString(codec.parameters ?? "");
      const rtxCodec = this.codecs[codecParams["apt"]];
      if (packet.payload.length < 2) return;

      packet = unwrapRtx(packet, rtxCodec.payloadType, originalSsrc);
      track = this.trackBySSRC[originalSsrc];
      receiveType = RtpReceivePacketType.retransmission;
    }

    let red: Red | undefined;
    if (!paddingOnly && codec.name.toLowerCase() === "red") {
      red = Red.deSerialize(packet.payload);
      if (
        !Object.keys(this.codecs).includes(
          red.header.fields[0].blockPT.toString(),
        )
      ) {
        return;
      }
    }

    if (track?.kind === "video" && this.nackEnabled) {
      this.nack.addPacket(packet);
    }

    if (track) {
      const info: RtpReceiveInfo = { type: receiveType };
      if (red) {
        if (track.kind === "audio") {
          const payloads = this.audioRedHandler.push(red, packet);
          for (const recovered of payloads) {
            this.emitReceiveRtp(track, recovered, extensions, {
              type: RtpReceivePacketType.media,
            });
          }
        } else {
        }
      } else {
        this.emitReceiveRtp(track, packet, extensions, info);
      }
    }

    this.runRtcp();
  }

  /**
   * Deliver a packet on {@link MediaStreamTrack.onReceiveRtp}.
   * When {@link PeerConfig.filterProbePaddingOnReceiveRtp} is true (opt-in),
   * padding-only probes are omitted and media sequence numbers are compacted
   * by on-time padding strictly before that packet in extended seq space.
   * Late padding (arriving after media with a higher original seq) is ignored
   * so already-delivered mappings are not rewritten.
   * Default is false so `onReceiveRtp` matches the wire sequence.
   */
  private emitReceiveRtp(
    track: MediaStreamTrack,
    packet: RtpPacket,
    extensions: Extensions,
    info: RtpReceiveInfo,
  ) {
    if (this.config.filterProbePaddingOnReceiveRtp === true) {
      const compacted = this.compactProbePaddingSequence(packet, info);
      if (!compacted) {
        return;
      }
      track.onReceiveRtp.execute(compacted, extensions, info);
      return;
    }

    track.onReceiveRtp.execute(packet.clone(), extensions, info);
  }

  /**
   * Filter padding and compact media seq using extended sequence position.
   * Returns undefined when the packet is skipped padding.
   */
  private compactProbePaddingSequence(
    packet: RtpPacket,
    info: RtpReceiveInfo,
  ): RtpPacket | undefined {
    const ssrc = packet.header.ssrc;
    let state = this.probePaddingCompactBySsrc[ssrc];
    if (!state) {
      state = {
        onTimePaddingExt: new Set<number>(),
        prunedOnTimeCount: 0,
      };
      this.probePaddingCompactBySsrc[ssrc] = state;
    }

    const ext = extendRtpSequence(packet.header.sequenceNumber, state.lastExt);
    state.lastExt = ext;

    if (info.type === RtpReceivePacketType.padding) {
      const late =
        state.maxDeliveredMediaExt !== undefined &&
        ext <= state.maxDeliveredMediaExt;
      if (!late) {
        state.onTimePaddingExt.add(ext);
      }
      this.pruneProbePaddingCompact(state);
      return undefined;
    }

    let skip = state.prunedOnTimeCount;
    for (const paddingExt of state.onTimePaddingExt) {
      if (paddingExt < ext) {
        skip++;
      }
    }

    const delivered = packet.clone();
    delivered.header.sequenceNumber = (ext - skip) & 0xffff;
    state.maxDeliveredMediaExt =
      state.maxDeliveredMediaExt === undefined
        ? ext
        : Math.max(state.maxDeliveredMediaExt, ext);
    this.pruneProbePaddingCompact(state);
    return delivered;
  }

  private pruneProbePaddingCompact(state: ProbePaddingCompactState) {
    if (state.lastExt === undefined) {
      return;
    }
    const horizon = state.lastExt - 0x10000;
    if (horizon <= 0) {
      return;
    }
    for (const paddingExt of state.onTimePaddingExt) {
      if (paddingExt < horizon) {
        state.onTimePaddingExt.delete(paddingExt);
        state.prunedOnTimeCount++;
      }
    }
  }
}

type ProbePaddingCompactState = {
  lastExt?: number;
  maxDeliveredMediaExt?: number;
  onTimePaddingExt: Set<number>;
  prunedOnTimeCount: number;
};

/** RFC 3550-style 16-bit sequence extension from the previous packet. */
function extendRtpSequence(seq: number, lastExt: number | undefined): number {
  const seq16 = seq & 0xffff;
  if (lastExt === undefined) {
    return seq16;
  }
  const lastSeq = lastExt & 0xffff;
  let roc = (lastExt - lastSeq) / 0x10000;
  const delta = seq16 - lastSeq;
  if (delta < -0x8000) {
    roc += 1;
  } else if (delta > 0x8000) {
    roc -= 1;
  }
  return roc * 0x10000 + seq16;
}
