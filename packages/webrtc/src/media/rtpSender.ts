/**
   [10 Nov 1995 11:33:25.125 UTC]       [10 Nov 1995 11:33:36.5 UTC]
   n                 SR(n)              A=b710:8000 (46864.500 s)
   ---------------------------------------------------------------->
                      v                 ^
   ntp_sec =0xb44db705 v               ^ dlsr=0x0005:4000 (    5.250s)
   ntp_frac=0x20000000  v             ^  lsr =0xb705:2000 (46853.125s)
     (3024992005.125 s)  v           ^
   r                      v         ^ RR(n)
   ---------------------------------------------------------------->
                          |<-DLSR->|
                           (5.250 s)
        
   A     0xb710:8000 (46864.500 s)
   DLSR -0x0005:4000 (    5.250 s)
   LSR  -0xb705:2000 (46853.125 s)
   -------------------------------
   delay 0x0006:2000 (    6.125 s)
        
Figure 2: Example for round-trip time computation
 */

import { randomBytes } from "crypto";

import { randomUUID } from "crypto";
import { setTimeout } from "timers/promises";
import { Event, random16, uint16Add, uint32Add } from "../imports/common";

import { codecParametersFromString } from "..";
import {
  type Extension,
  GenericNack,
  PictureLossIndication,
  RTP_EXTENSION_URI,
  ReceiverEstimatedMaxBitrate,
  RedEncoder,
  type RtcpPacket,
  RtcpPayloadSpecificFeedback,
  RtcpRrPacket,
  RtcpSenderInfo,
  RtcpSourceDescriptionPacket,
  RtcpSrPacket,
  RtcpTransportLayerFeedback,
  RtpHeader,
  RtpPacket,
  SourceDescriptionChunk,
  SourceDescriptionItem,
  TransportWideCC,
  debug,
  serializeAbsSendTime,
  serializeRepairedRtpStreamId,
  serializeSdesMid,
  serializeSdesRTPStreamID,
  serializeTransportWideCC,
  wrapRtx,
} from "../imports/rtp";
import type { RTCDtlsTransport } from "../transport/dtls";
import type { Kind } from "../types/domain";
import { compactNtp, milliTime, ntpTime, timestampSeconds } from "../utils";
import type {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpSendParameters,
} from "./parameters";
import type { BandwidthEstimator } from "./sender/bandwidthEstimator";
import { isProbePacingController } from "./sender/bandwidthEstimator";
import {
  kProbePaddingMaxBurst,
  kProbePaddingPacketBytes,
} from "./sender/estimators/gcc/constants";
import {
  SenderBandwidthEstimator,
  type SentInfo,
} from "./sender/senderBWE";
import {
  type RTCCodecStats,
  type RTCMediaSourceStats,
  type RTCOutboundRtpStreamStats,
  type RTCRemoteInboundRtpStreamStats,
  type RTCStats,
  type RTCStatsReport,
  buildStatsReport,
  generateCodecStatsId,
  generateStatsId,
  getStatsTimestamp,
} from "./stats";
import type { MediaStream, MediaStreamTrack } from "./track";

const log = debug("werift:packages/webrtc/src/media/rtpSender.ts");

const RTP_HISTORY_SIZE = 128;
const RTT_ALPHA = 0.85;

export class RTCRtpSender {
  readonly type = "sender";
  readonly kind: Kind;
  readonly ssrc = randomBytes(4).readUInt32BE(0);
  readonly rtxSsrc = randomBytes(4).readUInt32BE(0);
  readonly trackId = randomUUID().toString();
  readonly onReady = new Event();
  readonly onRtcp = new Event<[RtcpPacket]>();
  readonly onPictureLossIndication = new Event<[]>();
  readonly onGenericNack = new Event<[GenericNack]>();
  /**
   * Active send-side bandwidth estimator (TWCC-driven).
   * Mutable only via {@link setBandwidthEstimator} (not a public field write).
   */
  private _senderBWE: BandwidthEstimator = new SenderBandwidthEstimator();

  /**
   * Active send-side bandwidth estimator (TWCC-driven).
   *
   * Default is {@link SenderBandwidthEstimator} (legacy cumulative algorithm).
   * Replace only with {@link setBandwidthEstimator} (e.g. `new GccBandwidthEstimator()`).
   *
   * Prefer {@link onAvailableBitrate} on this sender for bitrate notifications that
   * survive estimator swaps. Algorithm-specific events remain on concrete instances.
   */
  get senderBWE(): BandwidthEstimator {
    return this._senderBWE;
  }

  /**
   * Stable recommended send bitrate event (**bps**, change-only).
   * Bridged from the active {@link BandwidthEstimator}; subscriptions survive
   * {@link setBandwidthEstimator} without re-subscribing.
   *
   * Prefer this over `senderBWE.onAvailableBitrate` for application adaptation.
   */
  readonly onAvailableBitrate = new Event<[number]>();
  private bweAvailableBitrateUnsub?: () => void;

  /**
   * GCC probe cluster configs (target bps / min packets). Bridged when the
   * active estimator is {@link GccBandwidthEstimator}.
   */
  readonly onProbeClusterConfig = new Event<
    [{ id: number; targetBps: number; minPackets: number; minDurationMs: number }]
  >();
  private bweProbeUnsub?: () => void;

  /** Token-bucket pacer state for probe / target rate enforcement. */
  private paceBudgetBytes = 0;
  private lastPaceMs = 0;
  /** Prevent re-entrant probe padding injection (async race). */
  private probePaddingInFlight = false;

  private cname?: string;
  private mid?: string;
  private rtpStreamId?: string;
  private repairedRtpStreamId?: string;
  private rtxPayloadType?: number;
  private rtxSequenceNumber = random16();
  redRedundantPayloadType?: number;
  private _redDistance = 2;
  redEncoder = new RedEncoder(this._redDistance);
  private headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
  private disposeTrack?: () => void;
  private sendEncodings: Array<Record<string, unknown>> = [{}];

  // # stats
  private lastSRtimestamp?: number;
  private lastSentSRTimestamp?: number;
  private ntpTimestamp = 0n;
  private rtpTimestamp = 0;
  private octetCount = 0;
  private packetCount = 0;
  private headerBytesSent = 0;
  private rtt?: number;
  private totalRoundTripTime = 0;
  private roundTripTimeMeasurements = 0;
  private retransmittedPacketsSent = 0;
  private retransmittedBytesSent = 0;
  private nackCount = 0;
  private pliCount = 0;
  private firCount = 0;
  private remotePacketsLost?: number;
  private remoteFractionLost?: number;
  receiverEstimatedMaxBitrate = 0n;

  // rtp
  private sequenceNumber?: number;
  private timestamp?: number;
  private timestampOffset = 0;
  private seqOffset = 0;
  private rtpCache: RtpPacket[] = [];
  codec?: RTCRtpCodecParameters;
  public dtlsTransport!: RTCDtlsTransport;
  private dtlsDisposer: (() => void)[] = [];

  track: MediaStreamTrack | null = null;
  streamIds: string[] = [];
  stopped = false;
  rtcpRunning = false;
  private rtcpCancel = new AbortController();

  constructor(public trackOrKind: Kind | MediaStreamTrack) {
    this.kind =
      typeof this.trackOrKind === "string"
        ? this.trackOrKind
        : this.trackOrKind.kind;
    if (typeof trackOrKind !== "string") {
      this.registerTrack(trackOrKind);
    }
    this.bindBandwidthEstimatorEvents(this._senderBWE);
  }

  get transport() {
    return this.dtlsTransport ?? null;
  }

  get streamId() {
    return this.streamIds[0];
  }

  set streamId(value: string | undefined) {
    this.streamIds = value ? [value] : [];
  }

  setDtlsTransport(dtlsTransport: RTCDtlsTransport) {
    if (this.dtlsTransport) {
      this.dtlsDisposer.forEach((dispose) => dispose());
    }

    this.dtlsTransport = dtlsTransport;
    this.dtlsDisposer = [
      this.dtlsTransport.onStateChange.subscribe((state) => {
        if (state === "connected") {
          this.onReady.execute();
        }
      }).unSubscribe,
    ];
  }

  /**
   * Replace the send-side bandwidth estimator used for TWCC-driven BWE.
   *
   * Default is the legacy {@link SenderBandwidthEstimator}. Pass e.g.
   * `new GccBandwidthEstimator()` to use Google Congestion Control.
   *
   * Behavior on swap:
   * 1. Stops delivering `rtpPacketSent` / `receiveTWCC` to the previous instance.
   * 2. Unbinds the stable {@link onAvailableBitrate} bridge, then `dispose()`/`reset()` the old instance.
   * 3. Starts the new instance clean (no implicit state merge) and rebinds the bridge.
   *
   * Subscriptions to {@link onAvailableBitrate} on this sender are preserved.
   * Re-subscribe algorithm-specific events on the new concrete instance.
   */
  setBandwidthEstimator(impl: BandwidthEstimator): void {
    const prev = this._senderBWE;
    if (prev === impl) return;
    this.bweAvailableBitrateUnsub?.();
    this.bweAvailableBitrateUnsub = undefined;
    this.bweProbeUnsub?.();
    this.bweProbeUnsub = undefined;
    if (prev.dispose) {
      prev.dispose();
    } else {
      prev.reset?.();
    }
    this._senderBWE = impl;
    this.bindBandwidthEstimatorEvents(impl);
    this.paceBudgetBytes = 0;
    this.lastPaceMs = 0;
  }

  private bindBandwidthEstimatorEvents(impl: BandwidthEstimator) {
    this.bweAvailableBitrateUnsub?.();
    this.bweAvailableBitrateUnsub = impl.onAvailableBitrate.subscribe((bps) => {
      this.onAvailableBitrate.execute(bps);
    }).unSubscribe;

    this.bweProbeUnsub?.();
    this.bweProbeUnsub = undefined;
    const maybeGcc = impl as BandwidthEstimator & {
      onProbeClusterConfig?: Event<
        [{ id: number; targetBps: number; minPackets: number; minDurationMs: number }]
      >;
    };
    if (maybeGcc.onProbeClusterConfig) {
      this.bweProbeUnsub = maybeGcc.onProbeClusterConfig.subscribe((cfg) => {
        this.onProbeClusterConfig.execute(cfg);
        // Fill budget so probe packets can leave promptly at the new target.
        this.paceBudgetBytes = Math.max(
          this.paceBudgetBytes,
          (cfg.targetBps / 8) * 0.05,
        );
        // Inject padding when media alone may not fill the probe cluster.
        void this.maybeInjectProbePadding();
      }).unSubscribe;
    }
  }

  /**
   * Effective send pacing rate (bps): estimator estimate, raised to the active
   * probe target while probing. 0 when unknown.
   */
  get pacingBitrateBps(): number {
    const e = this._senderBWE;
    if (isProbePacingController(e)) {
      return e.getPacingBitrateBps();
    }
    return e.availableBitrate;
  }

  get redDistance() {
    return this._redDistance;
  }
  set redDistance(n: number) {
    this._redDistance = n;
    this.redEncoder.distance = n;
  }

  prepareSend(params: RTCRtpSendParameters) {
    this.cname = params.rtcp?.cname;
    this.mid = params.muxId;
    this.headerExtensions = params.headerExtensions;
    this.rtpStreamId = params.rtpStreamId;
    this.repairedRtpStreamId = params.repairedRtpStreamId;

    this.codec = params.codecs[0];
    if (this.track) {
      this.track.codec = this.codec;
    }

    params.codecs.forEach((codec) => {
      const codecParams = codecParametersFromString(codec.parameters ?? "");
      if (
        codec.name.toLowerCase() === "rtx" &&
        codecParams["apt"] === this.codec?.payloadType
      ) {
        this.rtxPayloadType = codec.payloadType;
      }
      if (codec.name.toLowerCase() === "red") {
        this.redRedundantPayloadType = Number(
          (codec.parameters ?? "").split("/")[0],
        );
      }
    });
  }

  registerTrack(track: MediaStreamTrack) {
    if (track.stopped) throw new Error("track is ended");

    if (this.disposeTrack) {
      this.disposeTrack();
    }

    track.id = this.trackId;

    const { unSubscribe } = track.onReceiveRtp.subscribe(async (rtp) => {
      await this.sendRtp(rtp);
    });
    this.track = track;
    this.disposeTrack = unSubscribe;

    if (this.codec) {
      track.codec = this.codec;
    }

    track.onSourceChanged.subscribe((header) => {
      this.replaceRTP(header);
    });
  }

  setStreams(streams: MediaStream[] = []) {
    this.streamIds = [...new Set(streams.map((stream) => stream.id))];
  }

  setSendEncodings(encodings: Array<Record<string, unknown>> = []) {
    this.sendEncodings =
      encodings.length > 0
        ? encodings.map((encoding) => ({ ...encoding }))
        : [{}];
  }

  async replaceTrack(track: MediaStreamTrack | null) {
    if (track === null) {
      if (this.disposeTrack) {
        this.disposeTrack();
      }
      this.track = null;
      return;
    }

    if (track.stopped) throw new Error("track is ended");

    if (this.sequenceNumber != undefined) {
      const header =
        track.header || (await track.onReceiveRtp.asPromise())[0].header;

      this.replaceRTP(header);
    }

    this.registerTrack(track);
    log("replaceTrack", "ssrc", track.ssrc, "rid", track.rid);
  }

  stop() {
    this.stopped = true;
    this.rtcpRunning = false;
    this.rtcpCancel.abort();
    if (this.disposeTrack) {
      this.disposeTrack();
    }
    this.track = null;
  }

  async runRtcp() {
    if (this.rtcpRunning || this.stopped) return;
    this.rtcpRunning = true;

    try {
      while (this.rtcpRunning) {
        await setTimeout(500 + Math.random() * 1000, undefined, {
          signal: this.rtcpCancel.signal,
        });

        const packets: RtcpPacket[] = [
          new RtcpSrPacket({
            ssrc: this.ssrc,
            senderInfo: new RtcpSenderInfo({
              ntpTimestamp: this.ntpTimestamp,
              rtpTimestamp: this.rtpTimestamp,
              packetCount: this.packetCount,
              octetCount: this.octetCount,
            }),
          }),
        ];
        this.lastSRtimestamp = compactNtp(this.ntpTimestamp);
        this.lastSentSRTimestamp = timestampSeconds();

        if (this.cname) {
          packets.push(
            new RtcpSourceDescriptionPacket({
              chunks: [
                new SourceDescriptionChunk({
                  source: this.ssrc,
                  items: [
                    new SourceDescriptionItem({ type: 1, text: this.cname }),
                  ],
                }),
              ],
            }),
          );
        }

        try {
          await this.dtlsTransport.sendRtcp(packets);
        } catch (error) {
          log("sendRtcp failed", error);
          await setTimeout(500 + Math.random() * 1000);
        }
      }
    } catch (error) {}
  }

  replaceRTP(
    {
      sequenceNumber,
      timestamp,
    }: Pick<RtpHeader, "sequenceNumber" | "timestamp">,
    discontinuity = false,
  ) {
    if (this.sequenceNumber != undefined) {
      this.seqOffset = uint16Add(this.sequenceNumber, -sequenceNumber);
      if (discontinuity) {
        this.seqOffset = uint16Add(this.seqOffset, 2);
      }
    }
    if (this.timestamp != undefined) {
      this.timestampOffset = uint32Add(this.timestamp, -timestamp);
      if (discontinuity) {
        this.timestampOffset = uint16Add(this.timestampOffset, 1);
      }
    }
    this.rtpCache = [];
    log("replaceRTP", this.sequenceNumber, sequenceNumber, this.seqOffset);
  }

  async sendRtp(rtp: Buffer | RtpPacket) {
    await this.sendRtpInternal(rtp, { injectProbePadding: true });
  }

  /**
   * Inject RTP padding packets while a GCC probe cluster is active and media
   * alone has not yet filled min packets / min bitrate×duration.
   *
   * Responsibility split:
   * - Estimator (`ProbeController` / `pendingProbePaddingPackets`) decides need
   * - Sender generates padding RTP with TWCC seq + `isProbation` and paces them
   */
  /**
   * Dedicated probe-padding path: unique RTP sequence numbers and P-bit set.
   * Media uses {@link sendRtp}; padding never re-enters media RED path.
   */
  async maybeInjectProbePadding(): Promise<number> {
    if (this.dtlsTransport?.state !== "connected" || !this.codec) {
      return 0;
    }
    if (this.probePaddingInFlight) {
      return 0;
    }
    const e = this._senderBWE;
    if (!isProbePacingController(e)) {
      return 0;
    }
    this.probePaddingInFlight = true;
    try {
      const pending = e.pendingProbePaddingPackets(kProbePaddingPacketBytes);
      const n = Math.min(pending, kProbePaddingMaxBurst);
      // Pre-allocate unique absolute RTP sequence numbers for this burst.
      let seq =
        this.sequenceNumber === undefined
          ? 0
          : uint16Add(this.sequenceNumber, 1);
      for (let i = 0; i < n; i++) {
        const nextSeq = i === 0 ? seq : uint16Add(seq, i);
        const pad = new RtpPacket(
          new RtpHeader({
            sequenceNumber: nextSeq,
            timestamp: this.timestamp ?? 0,
            payloadType: this.codec.payloadType,
            ssrc: this.ssrc,
            extension: true,
            extensions: [],
            marker: false,
            // RFC 3550 padding: P bit + trailing padding size byte.
            padding: true,
            paddingSize: kProbePaddingPacketBytes,
            payloadOffset: 12,
          }),
          Buffer.alloc(0),
        );
        await this.sendRtpInternal(pad, {
          injectProbePadding: false,
          forceProbeTag: true,
          absoluteSequenceNumber: nextSeq,
          isProbePadding: true,
        });
      }
      return n;
    } finally {
      this.probePaddingInFlight = false;
    }
  }

  private async sendRtpInternal(
    rtp: Buffer | RtpPacket,
    opts: {
      injectProbePadding?: boolean;
      forceProbeTag?: boolean;
      absoluteSequenceNumber?: number;
      isProbePadding?: boolean;
    } = {},
  ) {
    if (this.dtlsTransport.state !== "connected" || !this.codec) {
      return;
    }

    rtp = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;

    const { header, payload } = rtp;

    // Token-bucket pacing only for estimators that implement ProbePacingController
    // (e.g. GCC). Legacy default estimator must not alter send timing.
    const padBytes = header.padding ? header.paddingSize : 0;
    const payloadLen =
      payload.length + padBytes + (header.serializeSize || 12);
    if (isProbePacingController(this._senderBWE)) {
      if (!(await this.awaitPacingBudget(payloadLen))) {
        return;
      }
    }
    header.ssrc = this.ssrc;
    header.payloadType = this.codec.payloadType;
    header.timestamp = uint32Add(header.timestamp, this.timestampOffset);
    if (opts.absoluteSequenceNumber !== undefined) {
      // Probe padding: already-chosen unique absolute sequence number.
      header.sequenceNumber = opts.absoluteSequenceNumber & 0xffff;
    } else {
      header.sequenceNumber = uint16Add(header.sequenceNumber, this.seqOffset);
    }
    this.timestamp = header.timestamp;
    this.sequenceNumber = header.sequenceNumber;

    const ntpTimestamp = ntpTime();

    const originalHeaderExtensions = [...header.extensions];
    header.extensions = this.headerExtensions
      .map((extension) => {
        const extPayload = (() => {
          switch (extension.uri) {
            case RTP_EXTENSION_URI.sdesMid:
              if (this.mid) {
                return serializeSdesMid(this.mid);
              }
              return;
            // todo : sender simulcast unsupported now
            case RTP_EXTENSION_URI.sdesRTPStreamID:
              if (this.rtpStreamId) {
                return serializeSdesRTPStreamID(this.rtpStreamId);
              }
              return;
            // todo : sender simulcast unsupported now
            case RTP_EXTENSION_URI.repairedRtpStreamId:
              if (this.repairedRtpStreamId) {
                return serializeRepairedRtpStreamId(this.repairedRtpStreamId);
              }
              return;
            case RTP_EXTENSION_URI.transportWideCC:
              this.dtlsTransport.transportSequenceNumber = uint16Add(
                this.dtlsTransport.transportSequenceNumber,
                1,
              );
              return serializeTransportWideCC(
                this.dtlsTransport.transportSequenceNumber,
              );
            case RTP_EXTENSION_URI.absSendTime:
              return serializeAbsSendTime(ntpTimestamp);
          }
        })();

        if (extPayload) return { id: extension.id, payload: extPayload };
      })
      .filter((v) => v) as Extension[];
    for (const ext of originalHeaderExtensions) {
      const exist = header.extensions.find((v) => v.id === ext.id);
      if (exist) {
        exist.payload = ext.payload;
      } else {
        header.extensions.push(ext);
      }
    }
    header.extensions = header.extensions.sort((a, b) => a.id - b.id);

    this.ntpTimestamp = ntpTimestamp;
    this.rtpTimestamp = header.timestamp;
    this.octetCount += payload.length;
    this.headerBytesSent += header.serializeSize;
    this.packetCount = uint32Add(this.packetCount, 1);

    this.rtpCache[header.sequenceNumber % RTP_HISTORY_SIZE] = rtp;

    let rtpPayload = payload;

    if (this.redRedundantPayloadType && !opts.isProbePadding) {
      this.redEncoder.push({
        block: rtpPayload,
        timestamp: header.timestamp,
        blockPT: this.redRedundantPayloadType,
      });
      const red = this.redEncoder.build();
      rtpPayload = red.serialize();
    }

    // Probe padding keeps P-bit + paddingSize on the header (RFC 3550).
    // dtlsTransport.sendRtp sends payload+header; account padding in BWE size.
    let size = await this.dtlsTransport.sendRtp(rtpPayload, header);
    if (header.padding && header.paddingSize > 0) {
      size += header.paddingSize;
    }

    this.runRtcp();
    const millitime = milliTime();
    const probeCtl = isProbePacingController(this._senderBWE)
      ? this._senderBWE
      : undefined;
    const sentInfo: SentInfo = {
      wideSeq: this.dtlsTransport.transportSequenceNumber,
      size,
      sendingAtMs: millitime,
      sentAtMs: millitime,
      isProbation:
        opts.forceProbeTag === true ||
        probeCtl?.shouldTagProbePacket() === true,
    };
    this._senderBWE.rtpPacketSent(sentInfo);

    if (opts.injectProbePadding) {
      await this.maybeInjectProbePadding();
    }
  }

  /**
   * Token-bucket wait against {@link pacingBitrateBps}.
   * Returns false only if the sender is stopped while waiting.
   */
  private async awaitPacingBudget(packetBytes: number): Promise<boolean> {
    const rateBps = this.pacingBitrateBps;
    if (rateBps <= 0) {
      return true;
    }

    const now = milliTime();
    if (this.lastPaceMs === 0) {
      this.lastPaceMs = now;
      // Initial burst: 30 ms of rate.
      this.paceBudgetBytes = (rateBps / 8) * 0.03;
    } else {
      const elapsedSec = Math.max(0, (now - this.lastPaceMs) / 1000);
      this.paceBudgetBytes += elapsedSec * (rateBps / 8);
      // Cap accumulated budget to 100 ms of the current rate.
      const maxBudget = (rateBps / 8) * 0.1;
      if (this.paceBudgetBytes > maxBudget) {
        this.paceBudgetBytes = maxBudget;
      }
      this.lastPaceMs = now;
    }

    if (this.paceBudgetBytes >= packetBytes) {
      this.paceBudgetBytes -= packetBytes;
      return true;
    }

    const need = packetBytes - this.paceBudgetBytes;
    const waitMs = Math.ceil((need * 8 * 1000) / rateBps);
    if (waitMs > 0) {
      try {
        await setTimeout(Math.min(waitMs, 200), undefined, {
          signal: this.rtcpCancel.signal,
        });
      } catch {
        return !this.stopped;
      }
      if (this.stopped) return false;
      const after = milliTime();
      const elapsedSec = Math.max(0, (after - this.lastPaceMs) / 1000);
      this.paceBudgetBytes += elapsedSec * (rateBps / 8);
      this.lastPaceMs = after;
    }
    this.paceBudgetBytes = Math.max(0, this.paceBudgetBytes - packetBytes);
    return true;
  }

  handleRtcpPacket(rtcpPacket: RtcpPacket) {
    switch (rtcpPacket.type) {
      case RtcpSrPacket.type:
      case RtcpRrPacket.type:
        {
          const packet = rtcpPacket as RtcpSrPacket | RtcpRrPacket;
          packet.reports
            .filter((report) => report.ssrc === this.ssrc)
            .forEach((report) => {
              this.remotePacketsLost = report.packetsLost;
              this.remoteFractionLost = report.fractionLost / 256;
              if (this.lastSRtimestamp === report.lsr && report.dlsr) {
                if (this.lastSentSRTimestamp) {
                  const rtt =
                    timestampSeconds() -
                    this.lastSentSRTimestamp -
                    report.dlsr / 65536;
                  this.totalRoundTripTime += rtt;
                  this.roundTripTimeMeasurements++;
                  if (this.rtt === undefined) {
                    this.rtt = rtt;
                  } else {
                    this.rtt = RTT_ALPHA * this.rtt + (1 - RTT_ALPHA) * rtt;
                  }
                }
              }
            });
        }
        break;
      case RtcpTransportLayerFeedback.type:
        {
          const packet = rtcpPacket as RtcpTransportLayerFeedback;
          switch (packet.feedback.count) {
            case TransportWideCC.count:
              {
                const feedback = packet.feedback as TransportWideCC;
                this.senderBWE.receiveTWCC(feedback);
              }
              break;
            case GenericNack.count:
              {
                const feedback = packet.feedback as GenericNack;
                this.nackCount++;
                feedback.lost.forEach(async (seqNum) => {
                  let packet: RtpPacket | undefined =
                    this.rtpCache[seqNum % RTP_HISTORY_SIZE];
                  if (packet && packet.header.sequenceNumber !== seqNum) {
                    packet = undefined;
                  }
                  if (packet) {
                    if (this.rtxPayloadType != undefined) {
                      packet = wrapRtx(
                        packet,
                        this.rtxPayloadType,
                        this.rtxSequenceNumber,
                        this.rtxSsrc,
                      );
                      this.rtxSequenceNumber = uint16Add(
                        this.rtxSequenceNumber,
                        1,
                      );
                    }
                    this.retransmittedPacketsSent++;
                    this.retransmittedBytesSent += packet.payload.length;
                    this.headerBytesSent += packet.header.serializeSize;
                    await this.dtlsTransport.sendRtp(
                      packet.payload,
                      packet.header,
                    );
                  }
                });
                this.onGenericNack.execute(feedback);
              }
              break;
          }
        }
        break;
      case RtcpPayloadSpecificFeedback.type:
        {
          const packet = rtcpPacket as RtcpPayloadSpecificFeedback;
          switch (packet.feedback.count) {
            case ReceiverEstimatedMaxBitrate.count:
              {
                const feedback = packet.feedback as ReceiverEstimatedMaxBitrate;
                this.receiverEstimatedMaxBitrate = feedback.bitrate;
              }
              break;
            case PictureLossIndication.count:
              {
                this.pliCount++;
                this.onPictureLossIndication.execute();
              }
              break;
          }
        }
        break;
    }
    this.onRtcp.execute(rtcpPacket);
  }

  // todo impl
  getParameters() {
    return {
      encodings: this.sendEncodings.map((encoding) => ({ ...encoding })),
    };
  }

  // todo impl
  setParameters(params: { encodings?: Array<Record<string, unknown>> }) {
    if (params.encodings) {
      this.setSendEncodings(params.encodings);
    }
  }

  private get outboundRtpStatsId() {
    return generateStatsId("outbound-rtp", this.trackId);
  }

  private get mediaSourceStatsId() {
    return generateStatsId("media-source", this.trackId);
  }

  private get remoteInboundRtpStatsId() {
    return generateStatsId("remote-inbound-rtp", this.trackId);
  }

  getStatsRootIds() {
    return [this.outboundRtpStatsId];
  }

  collectStats(timestamp: number): RTCStats[] {
    const stats: RTCStats[] = [];
    const transportId = this.dtlsTransport
      ? generateStatsId("transport", this.dtlsTransport.id)
      : undefined;
    const codecId =
      this.codec && transportId
        ? generateCodecStatsId(
            transportId,
            this.codec.payloadType,
            this.trackId,
          )
        : undefined;

    // Outbound RTP stats
    const outboundRtpStats: RTCOutboundRtpStreamStats = {
      type: "outbound-rtp",
      id: this.outboundRtpStatsId,
      timestamp,
      ssrc: this.ssrc,
      kind: this.kind,
      transportId,
      codecId,
      mid: this.mid,
      packetsSent: this.packetCount,
      bytesSent: this.octetCount,
      headerBytesSent: this.headerBytesSent,
      retransmittedPacketsSent: this.retransmittedPacketsSent || undefined,
      retransmittedBytesSent: this.retransmittedBytesSent || undefined,
      rtxSsrc: this.rtxPayloadType ? this.rtxSsrc : undefined,
      mediaSourceId: this.track ? this.mediaSourceStatsId : undefined,
      remoteId:
        this.rtt !== undefined ||
        this.remotePacketsLost !== undefined ||
        this.remoteFractionLost !== undefined
          ? this.remoteInboundRtpStatsId
          : undefined,
      nackCount: this.nackCount || undefined,
      pliCount: this.pliCount || undefined,
      firCount: this.firCount || undefined,
    };
    stats.push(outboundRtpStats);

    // Media source stats
    if (this.track) {
      const mediaSourceStats: RTCMediaSourceStats = {
        type: "media-source",
        id: this.mediaSourceStatsId,
        timestamp,
        trackIdentifier: this.track.id ?? this.trackId,
        kind: this.kind,
      };
      stats.push(mediaSourceStats);
    }

    if (this.codec && transportId) {
      const codecStats: RTCCodecStats = {
        type: "codec",
        id: codecId!,
        timestamp,
        payloadType: this.codec.payloadType,
        transportId,
        mimeType: this.codec.mimeType,
        clockRate: this.codec.clockRate,
        channels: this.codec.channels,
        sdpFmtpLine: this.codec.parameters,
      };
      stats.push(codecStats);
    }

    // Remote inbound RTP stats (if we have RTT)
    if (
      this.rtt !== undefined ||
      this.remotePacketsLost !== undefined ||
      this.remoteFractionLost !== undefined
    ) {
      const remoteInboundStats: RTCRemoteInboundRtpStreamStats = {
        type: "remote-inbound-rtp",
        id: this.remoteInboundRtpStatsId,
        timestamp,
        ssrc: this.ssrc,
        kind: this.kind,
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

  async getStats(): Promise<RTCStatsReport> {
    const timestamp = getStatsTimestamp();
    const stats = this.collectStats(timestamp);

    if (this.dtlsTransport) {
      stats.push(...(await this.dtlsTransport.getStats(timestamp)));
    }

    return buildStatsReport(stats, this.getStatsRootIds());
  }
}
