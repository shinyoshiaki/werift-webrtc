import { randomUUID } from "crypto";
import { setTimeout } from "timers/promises";
import { Event, int } from "../imports/common";

import type { PeerConfig } from "../api/peerConfig";
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
  unwrapRtx,
} from "../imports/rtp";
import type { ReceiverNegotiationState } from "../negotiation/internalState";
import type { RTCDtlsTransport } from "../transport/dtls";
import type { Kind } from "../types/domain";
import { compactNtp, ntpTimeToEpochMs, timestampSeconds } from "../utils";
import { deliveredTrackCodec } from "./codecCompatibility";
import type {
  RTCRtpCodecParameters,
  RTCRtpReceiveParameters,
} from "./parameters";
import { NackHandler } from "./receiver/nack";
import { ReceiverTWCC } from "./receiver/receiverTwcc";
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
import { MediaStreamTrack } from "./track";

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
  private readonly stagedCodecs: { [pt: number]: RTCRtpCodecParameters } = {};
  private readonly stagedSsrcByRtx: { [rtxSsrc: number]: number } = {};
  /** SSRCs of `trackBySSRC` learned from RID packets rather than SDP. */
  readonly learnedTrackSsrcs = new Set<number>();
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
  /** Media payload type last received on each SSRC (RTX resolved to its media SSRC). */
  private payloadTypeBySsrc: { [ssrc: number]: number } = {};

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

  /**
   * Receive tables are keyed by payload type and RTX SSRC. With
   * `deferConflicts` (a pending offer or pranswer), a new key applies at once
   * so provisional RTP decodes, but a key the current session already uses
   * with another value is staged: current RTP keeps its codec and RTX pairing
   * until the transaction commits, and rollback drops the staged value.
   */
  prepareReceive(
    params: RTCRtpReceiveParameters,
    { deferConflicts = false }: { deferConflicts?: boolean } = {},
  ) {
    params.codecs.forEach((c) => {
      const existing = this.codecs[c.payloadType];
      if (deferConflicts && existing && !sameCodec(existing, c)) {
        this.stagedCodecs[c.payloadType] = c;
      } else {
        // The latest description decides the key: an earlier staged value
        // must not overwrite it at the commit.
        delete this.stagedCodecs[c.payloadType];
        this.codecs[c.payloadType] = c;
      }
    });
    params.encodings.forEach((e) => {
      if (!e.rtx) return;
      const existing = this.ssrcByRtx[e.rtx.ssrc];
      if (deferConflicts && existing !== undefined && existing !== e.ssrc) {
        this.stagedSsrcByRtx[e.rtx.ssrc] = e.ssrc;
      } else {
        delete this.stagedSsrcByRtx[e.rtx.ssrc];
        this.ssrcByRtx[e.rtx.ssrc] = e.ssrc;
      }
    });
  }

  /**
   * Internal: drop values staged by an earlier remote pranswer. A later
   * pranswer or the final answer replaces that proposal as a whole.
   */
  discardStagedReceive() {
    clearTable(this.stagedCodecs);
    clearTable(this.stagedSsrcByRtx);
  }

  /** Internal: the transaction committed, staged payload types and RTX pairs apply. */
  commitStagedReceive() {
    Object.assign(this.codecs, this.stagedCodecs);
    Object.assign(this.ssrcByRtx, this.stagedSsrcByRtx);
    clearTable(this.stagedCodecs);
    clearTable(this.stagedSsrcByRtx);
  }

  /** Internal: capture the decode tables for a negotiation rollback baseline. */
  snapshotReceiveTables() {
    return {
      codecs: { ...this.codecs },
      ssrcByRtx: { ...this.ssrcByRtx },
      stagedCodecs: { ...this.stagedCodecs },
      stagedSsrcByRtx: { ...this.stagedSsrcByRtx },
    };
  }

  /** Internal: replace the decode tables with a rollback baseline. */
  restoreReceiveTables(
    snapshot: ReturnType<RTCRtpReceiver["snapshotReceiveTables"]>,
  ) {
    for (const [table, saved] of [
      [this.codecs, snapshot.codecs],
      [this.ssrcByRtx, snapshot.ssrcByRtx],
      [this.stagedCodecs, snapshot.stagedCodecs],
      [this.stagedSsrcByRtx, snapshot.stagedSsrcByRtx],
    ] as [Record<number, unknown>, Record<number, unknown>][]) {
      clearTable(table);
      Object.assign(table, saved);
    }
  }

  /**
   * Internal: everything a negotiation may change on this receiver, for a
   * rollback baseline. Packet-driven runtime (statistics, NACK, RTCP) is not
   * part of it.
   */
  snapshotNegotiationState() {
    return {
      receiverTWCC: this.receiverTWCC,
      remoteStreamIds: [...this.remoteStreamIds],
      remoteStreamId: this.remoteStreamId,
      remoteTrackId: this.remoteTrackId,
      tracks: [...this.tracks],
      trackBySSRC: { ...this.trackBySSRC },
      trackByRID: { ...this.trackByRID },
      receiveTables: this.snapshotReceiveTables(),
    };
  }

  /** Internal: return to a negotiation baseline taken by `snapshotNegotiationState`. */
  restoreNegotiationState(state: ReceiverNegotiationState) {
    // Transport-cc feedback a pending description started for this receiver
    // stops; the current session's feedback (if any) remains.
    if (this.receiverTWCC !== state.receiverTWCC) {
      if (this.receiverTWCC) this.receiverTWCC.twccRunning = false;
      this.receiverTWCC = state.receiverTWCC;
    }
    this.remoteStreamIds = state.remoteStreamIds;
    this.remoteStreamId = state.remoteStreamId;
    this.remoteTrackId = state.remoteTrackId;
    this.tracks.splice(0, this.tracks.length, ...state.tracks);
    // SSRCs learned from RID packets are live state, not SDP: keep those
    // whose track survives the rollback.
    const learnedTracks = Object.entries(this.trackBySSRC).filter(
      ([ssrc, track]) =>
        this.learnedTrackSsrcs.has(Number(ssrc)) &&
        !(ssrc in state.trackBySSRC) &&
        state.tracks.includes(track),
    );
    replaceTable(this.trackBySSRC, state.trackBySSRC);
    for (const [ssrc, track] of learnedTracks) {
      this.trackBySSRC[ssrc] = track;
    }
    replaceTable(this.trackByRID, state.trackByRID);
    // Codec/RTX tables added or changed by a pending description are
    // dropped; current RTP is decoded exactly as before the transaction.
    this.restoreReceiveTables(state.receiveTables);
  }

  /**
   * Replace receiver codec state after a negotiated codec preference change.
   * Use only when the transaction commits; pending descriptions stage through
   * prepareReceive() so the current decode path remains available.
   */
  resyncCodecs(params: RTCRtpReceiveParameters, mediaSourceSsrc?: number) {
    clearTable(this.codecs);
    clearTable(this.ssrcByRtx);
    this.prepareReceive(params);
    const codec = deliveredTrackCodec(
      this.kind,
      params.codecs[0],
      params.codecs,
    );
    if (codec) {
      for (const track of this.tracks) track.codec = codec;
    }
    this.receiverTWCC = undefined;
    if (mediaSourceSsrc != undefined) this.setupTWCC(mediaSourceSsrc);
  }

  /**
   * setup TWCC if supported
   */
  setupTWCC(mediaSourceSsrc: number) {
    if (this.twccEnabled && !this.receiverTWCC) {
      this.receiverTWCC = new ReceiverTWCC(
        this.dtlsTransport,
        this.rtcpSsrc,
        mediaSourceSsrc,
      );
    }
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
      this.learnedTrackSsrcs.delete(track.ssrc);
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

    if (this.receiverTWCC) this.receiverTWCC.twccRunning = false;
    this.nack.close();
  }

  /**transceiver の停止確定時に remote track を ended にする */
  endTracks() {
    for (const track of [...this.tracks, this.defaultTrack]) {
      track.stop();
    }
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

  /**
   * Internal: whether PLI is negotiated for `mediaSsrc`, and the payload type
   * that decides it. PLI follows the negotiated receive codec of this SSRC:
   * the live codec table (current while a proposal is pending, switched at
   * commit and restored on rollback), not the codec its track was created with.
   */
  pliNegotiation(mediaSsrc: number) {
    const payloadType =
      this.payloadTypeBySsrc[mediaSsrc] ??
      this.trackBySSRC[mediaSsrc]?.codec?.payloadType;
    const codec =
      payloadType != undefined ? this.codecs[payloadType] : undefined;
    return {
      payloadType: codec ? payloadType : undefined,
      allowed: codec ? hasFeedback(codec, usePLI().type) : !!this.pliEnabled,
    };
  }

  async sendRtcpPLI(mediaSsrc: number) {
    if (!this.pliNegotiation(mediaSsrc).allowed) {
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
      this.learnedTrackSsrcs.add(packet.header.ssrc);
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

    if (this.receiverTWCC) {
      const transportSequenceNumber = extensions[
        RTP_EXTENSION_URI.transportWideCC
      ] as TransportWideCCPayload;

      if (!transportSequenceNumber == undefined) {
        throw new Error("undefined");
      }

      this.receiverTWCC.handleTWCC(transportSequenceNumber);
    } else if (hasFeedback(codec, useTWCC().type)) {
      this.setupTWCC(packet.header.ssrc);
    }

    // RTCP feedback follows the codec this packet was negotiated with, not
    // whichever payload type happens to sort first in the receive table.
    let mediaCodec = codec;
    if (codec.name.toLowerCase() === "rtx") {
      const originalSsrc = this.ssrcByRtx[packet.header.ssrc];
      const codecParams = codecParametersFromString(codec.parameters ?? "");
      const rtxCodec = this.codecs[codecParams["apt"]];
      if (packet.payload.length < 2) return;

      packet = unwrapRtx(packet, rtxCodec.payloadType, originalSsrc);
      track = this.trackBySSRC[originalSsrc];
      mediaCodec = rtxCodec;
    }

    let red: Red | undefined;
    if (codec.name.toLowerCase() === "red") {
      red = Red.deSerialize(packet.payload);
      if (
        !Object.keys(this.codecs).includes(
          red.header.fields[0].blockPT.toString(),
        )
      ) {
        return;
      }
    }

    this.payloadTypeBySsrc[packet.header.ssrc] = mediaCodec.payloadType;

    if (track?.kind === "video" && hasFeedback(mediaCodec, "nack")) {
      this.nack.addPacket(packet);
    }

    if (track) {
      if (red) {
        if (track.kind === "audio") {
          const payloads = this.audioRedHandler.push(red, packet);
          for (const packet of payloads) {
            track.onReceiveRtp.execute(packet.clone(), extensions);
          }
        } else {
        }
      } else {
        track.onReceiveRtp.execute(packet.clone(), extensions);
      }
    }

    this.runRtcp();
  }
}

function clearTable(table: Record<number, unknown>) {
  for (const key of Object.keys(table)) delete table[Number(key)];
}

/** Replace the entries of a string-keyed table in place (keys may be RIDs). */
function replaceTable<T>(table: Record<string, T>, source: Record<string, T>) {
  for (const key of Object.keys(table)) delete table[key];
  Object.assign(table, source);
}

const feedbackKey = (codec: RTCRtpCodecParameters) =>
  codec.rtcpFeedback
    .map((f) => `${f.type} ${f.parameter ?? ""}`)
    .sort()
    .join(",");

function sameCodec(a: RTCRtpCodecParameters, b: RTCRtpCodecParameters) {
  return (
    a.mimeType.toLowerCase() === b.mimeType.toLowerCase() &&
    a.clockRate === b.clockRate &&
    (a.channels ?? 1) === (b.channels ?? 1) &&
    (a.parameters ?? "") === (b.parameters ?? "") &&
    feedbackKey(a) === feedbackKey(b)
  );
}

function hasFeedback(
  codec: RTCRtpCodecParameters | undefined,
  type: string,
  parameter?: string,
) {
  return !!codec?.rtcpFeedback.some(
    (f) =>
      f.type === type && (parameter === undefined || f.parameter === parameter),
  );
}
