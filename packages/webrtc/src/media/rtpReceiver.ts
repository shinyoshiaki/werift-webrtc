import { randomUUID } from "crypto";
import { setTimeout } from "timers/promises";
import type { PeerConfig } from "../api/peerConfig";
import { Event, int } from "../imports/common";
import {
  debug,
  type Extensions,
  isPaddingOnlyRtpPacket,
  PictureLossIndication,
  Red,
  RedHandler,
  RTP_EXTENSION_URI,
  type RtcpPacket,
  RtcpPayloadSpecificFeedback,
  RtcpReceiverInfo,
  RtcpRrPacket,
  RtcpSrPacket,
  type RtpPacket,
  type TransportWideCCPayload,
  unwrapRtx,
} from "../imports/rtp";
import type { ReceiverNegotiationState } from "../negotiation/internalState";
import { codecParametersFromString } from "../sdp";
import type { RTCDtlsTransport } from "../transport/dtls";
import type { Kind } from "../types/domain";
import { compactNtp, ntpTimeToEpochMs, timestampSeconds } from "../utils";
import { primaryTrackCodec } from "./codecCompatibility";
import { usePLI, useTWCC } from "./extension/rtcpFeedback";
import type {
  RTCRtpCodecParameters,
  RTCRtpReceiveParameters,
} from "./parameters";
import { NackHandler } from "./receiver/nack";
import {
  acquireTransportReceiverTWCC,
  type ReceiverTWCC,
  releaseTransportReceiverTWCC,
} from "./receiver/receiverTwcc";
import { ReceivedPacketHistory } from "./receiver/rtxRepair";
import { StreamStatistics } from "./receiver/statistics";
import {
  buildStatsReport,
  generateCodecStatsId,
  generateStatsId,
  getStatsTimestamp,
  type RTCCodecStats,
  type RTCInboundRtpStreamStats,
  type RTCRemoteOutboundRtpStreamStats,
  type RTCStats,
  type RTCStatsReport,
} from "./stats";
import {
  MediaStreamTrack,
  type RtpReceiveInfo,
  RtpReceivePacketType,
} from "./track";

const MAX_MEDIA_SSRCS_PER_RID = 4;

const log = debug("werift:packages/webrtc/src/media/rtpReceiver.ts");

export class RTCRtpReceiver {
  readonly config: PeerConfig;
  public kind: Kind;
  public rtcpSsrc: number;

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
  /**
   * Simulcast RTX without `a=ssrc-group:FID` (RFC 8852): the RID each RTX
   * SSRC repairs, learned from `repaired-rtp-stream-id`, and the media SSRCs
   * each RID has used (oldest first, bounded), learned from `rtp-stream-id`.
   * They name the candidates of an RTX packet when {@link ssrcByRtx} (SDP)
   * has no entry; {@link receivedBySsrc} decides between them per packet.
   * Packet-driven live state like {@link learnedTrackSsrcs}: a negotiation
   * (commit, rollback, `resyncCodecs`) keeps it, a later packet updates it.
   */
  readonly ridByRtxSsrc: { [rtxSsrc: number]: string } = {};
  readonly mediaSsrcsByRid: { [rid: string]: number[] } = {};
  /** Received packets of the media SSRCs in {@link mediaSsrcsByRid}. */
  readonly receivedBySsrc = new Map<number, ReceivedPacketHistory>();
  private readonly nack = new NackHandler(this);
  private readonly audioRedHandler = new RedHandler();

  readonly type = "receiver";
  readonly uuid = randomUUID().toString();
  readonly tracks: MediaStreamTrack[] = [];
  readonly trackBySSRC: { [ssrc: string]: MediaStreamTrack } = {};
  readonly trackByRID: { [rid: string]: MediaStreamTrack } = {};
  /**
   * Tracks whose SSRC a later pranswer / answer of the same offer replaced.
   * The next SSRC a description gives this receiver takes one over, so the
   * application keeps receiving on the same track object.
   */
  private unboundTracks: MediaStreamTrack[] = [];
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
  /** DTLS transport {@link receiverTWCC} was acquired from (release key). */
  private receiverTWCCTransport?: RTCDtlsTransport;
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
  /** Media payload type last received on each SSRC (RTX resolved to its media SSRC). */
  private payloadTypeBySsrc: { [ssrc: number]: number } = {};

  constructor(config: PeerConfig, kind: Kind, rtcpSsrc: number) {
    this.config = config;
    this.kind = kind;
    this.rtcpSsrc = rtcpSsrc;
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
    if (this.receiverTWCCTransport && this.receiverTWCCTransport !== dtls) {
      this.releaseReceiverTWCC();
    }
    this.dtlsTransport = dtls;
  }

  /** Drop this receiver's reference to the transport-shared TWCC generator. */
  private releaseReceiverTWCC() {
    if (this.receiverTWCC && this.receiverTWCCTransport) {
      releaseTransportReceiverTWCC(
        this.receiverTWCCTransport,
        this.receiverTWCC,
      );
    }
    this.receiverTWCC = undefined;
    this.receiverTWCCTransport = undefined;
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

  /** `a=rtcp-fb:<pt> nack pli` (RFC 4585): a generic `nack` alone does not allow PLI. */
  get pliEnabled() {
    const pli = usePLI();
    return this.codecArray[0]?.rtcpFeedback.find(
      (f) => f.type === pli.type && f.parameter === pli.parameter,
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
      unboundTracks: [...this.unboundTracks],
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
    this.unboundTracks = [...state.unboundTracks];
    // A track the rolled-back description rebound gets its SSRC back.
    for (const [ssrc, track] of Object.entries(state.trackBySSRC)) {
      if (!track.rid) track.ssrc = Number(ssrc);
    }
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
    // The committed description replaces the tables as a whole: values a
    // pending description staged must not come back at the commit.
    this.discardStagedReceive();
    clearTable(this.codecs);
    clearTable(this.ssrcByRtx);
    this.prepareReceive(params);
    const codec = primaryTrackCodec(this.kind, params.codecs);
    if (codec) {
      for (const track of this.tracks) track.codec = codec;
    }
    // Re-acquire before releasing the previous reference so a still-enabled
    // receiver keeps the same transport-wide history instead of recreating it.
    const previous = this.receiverTWCC;
    const previousTransport = this.receiverTWCCTransport;
    this.receiverTWCC = undefined;
    this.receiverTWCCTransport = undefined;
    if (mediaSourceSsrc != undefined) {
      this.setupTWCC(mediaSourceSsrc);
    }
    if (previous && previousTransport) {
      releaseTransportReceiverTWCC(previousTransport, previous);
    }
  }

  /**
   * Attach this receiver to the DTLS-transport-scoped TWCC generator.
   * BUNDLE audio/video share one {@link ReceiverTWCC} so interleaved
   * transport-wide sequences are not reported as loss.
   */
  setupTWCC(mediaSourceSsrc: number, negotiated = !!this.twccEnabled) {
    if (!negotiated || !this.dtlsTransport) {
      return;
    }
    if (!this.receiverTWCC) {
      this.receiverTWCC = acquireTransportReceiverTWCC(
        this.dtlsTransport,
        this.rtcpSsrc,
        mediaSourceSsrc,
      );
      this.receiverTWCCTransport = this.dtlsTransport;
      return;
    }
    this.receiverTWCC.setMediaSourceSsrc(mediaSourceSsrc);
  }

  /**
   * Internal: tracks a replaced remote offer gave this receiver stay its
   * tracks; the SSRCs the replacing offer gives take them over.
   */
  keepUnboundTracks(tracks: MediaStreamTrack[]) {
    for (const track of tracks) {
      if (track.rid || this.tracks.includes(track)) continue;
      this.tracks.push(track);
      this.unboundTracks.push(track);
    }
  }

  /** Internal: a superseded pending description no longer routes `ssrc`. */
  releaseProvisionalSsrc(ssrc: number) {
    const track = this.trackBySSRC[ssrc];
    if (!track || track.rid) return;
    delete this.trackBySSRC[ssrc];
    this.unboundTracks.push(track);
  }

  addTrack(track: MediaStreamTrack) {
    if (
      track.ssrc &&
      !track.rid &&
      !this.trackBySSRC[track.ssrc] &&
      this.unboundTracks.length > 0
    ) {
      const unbound =
        this.unboundTracks.find((t) => t.ssrc === track.ssrc) ??
        this.unboundTracks[0];
      this.unboundTracks = this.unboundTracks.filter((t) => t !== unbound);
      unbound.ssrc = track.ssrc;
      unbound.codec = track.codec ?? unbound.codec;
      this.trackBySSRC[track.ssrc] = unbound;
      this.learnedTrackSsrcs.delete(track.ssrc);
      return false;
    }
    const exist = this.tracks.find((t) => {
      if (this.unboundTracks.includes(t)) return false;
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

    this.releaseReceiverTWCC();
    this.nack.close();
    clearTable(this.ridByRtxSsrc);
    clearTable(this.mediaSsrcsByRid);
    this.receivedBySsrc.clear();
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
      allowed: codec
        ? hasFeedback(codec, usePLI().type, usePLI().parameter)
        : !!this.pliEnabled,
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
    const { ssrc } = packet.header;
    if (track && !this.trackBySSRC[ssrc]) {
      this.trackBySSRC[ssrc] = track;
      this.learnedTrackSsrcs.add(ssrc);
    }
    if (track && !isRtxCodec(this.codecs[packet.header.payloadType])) {
      this.learnRidMediaSsrc(rid, ssrc);
    }

    this.handleRTP(packet, extensions, track);
  };

  /**
   * An RTX packet that names the RID it repairs (`repaired-rtp-stream-id`).
   * The RTX SSRC is bound to that RID; the packet is restored once the RID's
   * media SSRC is known (until then it is dropped, see {@link handleRTP}).
   */
  handleRtxByRid = (
    packet: RtpPacket,
    repairedRid: string,
    extensions: Extensions,
  ) => {
    if (!this.trackByRID[repairedRid]) {
      log("repaired rid has no track", repairedRid);
      return;
    }
    this.ridByRtxSsrc[packet.header.ssrc] = repairedRid;
    this.handleRTP(packet, extensions);
  };

  private learnRidMediaSsrc(rid: string, ssrc: number) {
    const ssrcs = (this.mediaSsrcsByRid[rid] ??= []);
    if (ssrcs.includes(ssrc)) return;
    ssrcs.push(ssrc);
    if (!this.receivedBySsrc.has(ssrc)) {
      this.receivedBySsrc.set(ssrc, new ReceivedPacketHistory());
    }
    if (ssrcs.length <= MAX_MEDIA_SSRCS_PER_RID) return;
    const evicted = ssrcs.shift()!;
    const inUse = Object.values(this.mediaSsrcsByRid).some((other) =>
      other.includes(evicted),
    );
    if (!inUse) this.receivedBySsrc.delete(evicted);
  }

  /**
   * Media SSRC an RTX packet repairs. SDP pairing (`ssrc-group:FID`) names
   * it. Otherwise the packet itself is checked against each media SSRC its
   * RID has used: it must fill a hole of exactly one of them (see
   * {@link ReceivedPacketHistory} for why this identifies the stream). Each
   * packet is checked on its own and nothing is pinned, so a media SSRC
   * change of the RID, an RTX packet arriving before its media, or an RTX
   * SSRC first seen after the change cannot carry a wrong pairing forward.
   * A packet that fits no hole, or the holes of several SSRCs, is dropped.
   */
  private mediaSsrcOfRtx(rtx: RtpPacket): number | undefined {
    const rtxSsrc = rtx.header.ssrc;
    const bySdp = this.ssrcByRtx[rtxSsrc];
    if (bySdp !== undefined) return bySdp;
    const rid = this.ridByRtxSsrc[rtxSsrc];
    if (rid === undefined) return undefined;
    const originalSeq = rtx.payload.readUInt16BE(0);
    const matches = (this.mediaSsrcsByRid[rid] ?? []).filter((ssrc) =>
      this.receivedBySsrc
        .get(ssrc)
        ?.fitsHole(originalSeq, rtx.header.timestamp),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

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

    const paddingOnly = isPaddingOnlyRtpPacket(packet);
    let receiveType: RtpReceivePacketType = paddingOnly
      ? RtpReceivePacketType.padding
      : RtpReceivePacketType.media;
    let mediaCodec = codec;
    if (isRtxCodec(codec)) {
      const codecParams = codecParametersFromString(codec.parameters ?? "");
      const aptCodec = this.codecs[codecParams.apt];
      if (!aptCodec) {
        log("rtx apt codec not found", { apt: codecParams.apt });
        return;
      }
      mediaCodec = aptCodec;
    }

    if (hasFeedback(mediaCodec, useTWCC().type)) {
      this.setupTWCC(packet.header.ssrc, true);
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

    // RTCP feedback follows the codec this packet was negotiated with, not
    // whichever payload type happens to sort first in the receive table.
    if (isRtxCodec(codec)) {
      // Padding-only RTX (probe / bandwidth padding) carries no original
      // packet: TWCC above already observed it, nothing is delivered.
      if (packet.payload.length < 2) return;
      const originalSsrc = this.mediaSsrcOfRtx(packet);
      if (originalSsrc === undefined) {
        log("rtx media ssrc not resolved", { rtxSsrc: packet.header.ssrc });
        return;
      }

      packet = unwrapRtx(packet, mediaCodec.payloadType, originalSsrc);
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

    this.payloadTypeBySsrc[packet.header.ssrc] = mediaCodec.payloadType;
    this.receivedBySsrc
      .get(packet.header.ssrc)
      ?.add(packet.header.sequenceNumber, packet.header.timestamp);

    if (track?.kind === "video" && hasFeedback(mediaCodec, "nack")) {
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

function isRtxCodec(codec: RTCRtpCodecParameters | undefined) {
  return codec?.name.toLowerCase() === "rtx";
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
