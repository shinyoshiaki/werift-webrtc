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

import { randomBytes, randomUUID } from "crypto";
import { setTimeout } from "timers/promises";
import { codecParametersFromString } from "..";
import { createWebRtcDomException } from "../errors";
import { Event, random16, uint16Add } from "../imports/common";
import {
  appendRfc3550Padding,
  buildSendHeaderExtensions,
  createRtxPaddingPacket,
  debug,
  FullIntraRequest,
  GenericNack,
  isPaddingOnlyRtpPacket,
  PictureLossIndication,
  ReceiverEstimatedMaxBitrate,
  RedEncoder,
  RTP_EXTENSION_URI,
  type RtcpPacket,
  RtcpPayloadSpecificFeedback,
  RtcpRrPacket,
  RtcpSourceDescriptionPacket,
  RtcpSrPacket,
  RtcpTransportLayerFeedback,
  RtpContinuity,
  type RtpHeader,
  RtpPacket,
  SourceDescriptionChunk,
  SourceDescriptionItem,
  stampHopByHopExtensions,
  TransportWideCC,
  wrapRtx,
} from "../imports/rtp";
import type { RTCDtlsTransport } from "../transport/dtls";
import type { Kind } from "../types/domain";
import { milliTime, ntpTime } from "../utils";
import { isCodecCompatible } from "./codecCompatibility";
import type {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpSendParameters,
} from "./parameters";
import {
  type BandwidthEstimator,
  isProbePacingController,
  type LegacyCongestionCompatibility,
  needsPacedSendPath,
  type ProbeClusterConfig,
} from "./sender/bandwidthEstimator";
import { EstimatorBinding } from "./sender/estimatorBinding";
import { type OutgoingMeta, OutgoingQueue } from "./sender/outgoingQueue";
import { PaddingInjector } from "./sender/padding";
import {
  type PendingRtpOptions,
  PendingRtpQueue,
  resolvePendingRtpOptions,
} from "./sender/pendingRtp";
import { estimateOutgoingBytes, sendDtlsRtp } from "./sender/rtpWire";
import { SenderBandwidthEstimator, type SentInfo } from "./sender/senderBWE";
import { SenderStatistics, senderStatsIds } from "./sender/senderStats";
import { MediaPacer, waitForProbeSendTime } from "./sender/sendPacer";
import {
  buildStatsReport,
  getStatsTimestamp,
  type RTCStats,
  type RTCStatsReport,
} from "./stats";
import {
  captureTrackSourceCodecs,
  getTrackSourceCodecs,
  type MediaStream,
  type MediaStreamTrack,
} from "./track";

export type { PendingRtpOptions } from "./sender/pendingRtp";

const log = debug("werift:packages/webrtc/src/media/rtpSender.ts");

/** NACK history: the last sent media packets by sequence number modulo this. */
const RTP_HISTORY_SIZE = 128;

export type RTCRtpSenderOptions = {
  /**
   * Initial send-side bandwidth estimator. When omitted, the default is
   * {@link SenderBandwidthEstimator}. {@link RTCPeerConnection} passes the
   * instance created from {@link PeerConfig.bandwidthEstimator}.
   */
  bandwidthEstimator?: BandwidthEstimator;
  /** Pending RTP cache. Disabled by default. Pass `true` or `{ maxLength }` to enable. */
  pendingRtp?: boolean | PendingRtpOptions;
};

// RTCRtpSender sends one media stream: negotiation parameters, track binding,
// the RTP send path, RTCP feedback and stats. Parts with their own state live
// in ./sender/ (internal, not exported):
//
// - estimatorBinding.ts: the bandwidth estimator, its generation and process timer
// - outgoingQueue.ts / sendPacer.ts: the GCC send FIFO and pacing
// - padding.ts: probe / loss padding drain on the RTX stream
// - pendingRtp.ts: RTP held until DTLS connects
// - senderStats.ts: counters, reception reports, Sender Reports, stats
// - rtpWire.ts: send FIFO size estimate and the DTLS write
// Generic RTP pieces (RtpContinuity, header extension rebuild / hop-by-hop
// stamping, RTX padding packets, RED size estimate) live in werift-rtp.
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
   * Active send-side bandwidth estimator (TWCC-driven) with its generation
   * and process timer. Replaced only via {@link setBandwidthEstimator}.
   */
  private readonly bwe: EstimatorBinding;

  /**
   * Active send-side bandwidth estimator (TWCC-driven).
   *
   * Default is {@link SenderBandwidthEstimator} (legacy cumulative algorithm).
   * Replace only with {@link setBandwidthEstimator} (e.g. `new GccBandwidthEstimator()`).
   *
   * Prefer {@link onAvailableBitrate} on this sender for bitrate notifications that
   * survive estimator swaps. Algorithm-specific events remain on concrete instances.
   *
   * **TypeScript compatibility:** {@link LegacyCongestionCompatibility} fields
   * (`onCongestion` / `onCongestionScore`) are present on every estimator so
   * existing `sender.senderBWE.onCongestion.subscribe(...)` still type-checks.
   * They fire only on {@link SenderBandwidthEstimator}; GCC / disabled are no-ops.
   * Prefer `sender.senderBWE as SenderBandwidthEstimator` (or
   * {@link isSenderBandwidthEstimator}) for legacy-only APIs.
   */
  get senderBWE(): BandwidthEstimator & LegacyCongestionCompatibility {
    return this.bwe.estimator as BandwidthEstimator &
      LegacyCongestionCompatibility;
  }

  /**
   * Stable recommended send bitrate event (**bps**, change-only).
   * Bridged from the active {@link BandwidthEstimator}; subscriptions survive
   * {@link setBandwidthEstimator} without re-subscribing.
   *
   * Prefer this over `senderBWE.onAvailableBitrate` for application adaptation.
   */
  readonly onAvailableBitrate = new Event<[number]>();

  /**
   * Probe cluster configs (target bps / min packets). Bridged from the active
   * {@link BandwidthEstimator}; GCC fires this, legacy / disabled never do.
   */
  readonly onProbeClusterConfig = new Event<[ProbeClusterConfig]>();

  /**
   * @internal Sim / test only. When false, skip the **media** token-bucket
   * (pin GetPacingRates). Probe `next_probe_time` waits stay enabled so
   * BitrateProber timing is not disabled by accident.
   *
   * Peer/Chrome sims turn this off during the congestion phase so the
   * synthetic generate rate hits the bottleneck, then turn it back on
   * when the app follows {@link onAvailableBitrate}.
   */
  mediaPacingEnabled = true;
  /** Token-bucket pacer for **media** (not probe) rate enforcement. */
  private readonly pacer = new MediaPacer();
  /**
   * pin `pending_untracked_size_` — bytes sent without TWCC tracking,
   * attached to the next tracked packet as `priorUnackedBytes`.
   */
  private pendingUntrackedBytes = 0;
  /**
   * GCC send FIFO: reservation → pacing wait → seq / TSN assignment → DTLS write.
   * Probe padding may call {@link sendRtpInternal} on this stack only after
   * the current packet's DTLS write ({@link nestOutgoingPadding}); timer /
   * cluster events always enqueue so they cannot share a DTLS write.
   */
  private readonly outgoing: OutgoingQueue;
  /**
   * Set only around post-DTLS {@link maybeInjectProbePadding} so padding can
   * drain on the same FIFO task without deadlock. Must stay false during
   * probe/pacing wait, or a cluster event would send in parallel.
   */
  private nestOutgoingPadding = false;
  private readonly padding: PaddingInjector;
  /** Fires for a FIR addressed to this sender with a new sequence number (RFC 5104 4.3.1). */
  readonly onFullIntraRequest = new Event<[FullIntraRequest]>();
  /**
   * Fires for every key frame request addressed to this sender: each PLI, and each FIR
   * that is not a retransmission. Fires in addition to onPictureLossIndication / onFullIntraRequest.
   */
  readonly onKeyFrameRequest = new Event<["pli" | "fir"]>();

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
  private readonly stats = new SenderStatistics();
  /**
   * Last FIR sequence number per (FIR sender SSRC, FCI target SSRC): RFC 5104
   * 4.3.1.1 keeps one sequence number space per pair.
   */
  private lastFirSequenceNumbers = new Map<string, number>();
  receiverEstimatedMaxBitrate = 0n;

  // rtp
  private readonly continuity = new RtpContinuity();
  private rtpCache: RtpPacket[] = [];
  private readonly pendingRtp: PendingRtpQueue;
  /**
   * Bumped on replaceTrack / detachTrack / onSourceChanged. Media accepted
   * under an older epoch is dropped before it can allocate seq/timestamp, so
   * it neither consumes the new source's continuity offset nor leaks out
   * after `replaceTrack(null)`.
   */
  private sourceEpoch = 0;
  /** Aborted on every source epoch bump to wake probe / pacing waits. */
  private sourceEpochCancel = new AbortController();
  private readonly pendingRtpEnabled: boolean;
  codec?: RTCRtpCodecParameters;
  private negotiatedCodecs: RTCRtpCodecParameters[] = [];
  private sendPrimaryCodec?: RTCRtpCodecParameters;
  /**
   * Primary codec a pending remote offer's answer would switch this sender to.
   * `replaceTrack()` must fit it too, since the commit sends the track with it.
   */
  private proposedPrimaryCodec?: RTCRtpCodecParameters;
  public dtlsTransport!: RTCDtlsTransport;
  private dtlsDisposer: (() => void)[] = [];

  track: MediaStreamTrack | null = null;
  streamIds: string[] = [];
  stopped = false;
  rtcpRunning = false;
  private rtcpCancel = new AbortController();

  constructor(
    public trackOrKind: Kind | MediaStreamTrack,
    options?: RTCRtpSenderOptions,
  ) {
    const pendingRtp = resolvePendingRtpOptions(options?.pendingRtp);
    this.pendingRtpEnabled = pendingRtp.enabled;
    this.pendingRtp = new PendingRtpQueue(pendingRtp.maxLength);
    this.kind =
      typeof this.trackOrKind === "string"
        ? this.trackOrKind
        : this.trackOrKind.kind;
    this.bwe = new EstimatorBinding(
      options?.bandwidthEstimator ?? new SenderBandwidthEstimator(),
      {
        onAvailableBitrate: (bps) => this.onAvailableBitrate.execute(bps),
        onProbeClusterConfig: (cfg) => {
          this.onProbeClusterConfig.execute(cfg);
          // pin BitrateProber: no prepaid token-bucket credit. Probe packets
          // wait on next_probe_time = started_at + sent_bytes / send_bitrate.
          void this.maybeInjectProbePadding();
        },
        // pin GetPacingRates padding_rate while kIncreaseUsingPadding.
        onProcessTick: () => void this.maybeInjectLossPadding(),
        isStopped: () => this.stopped,
      },
    );
    this.outgoing = new OutgoingQueue(this.kind, () =>
      needsPacedSendPath(this.bwe.estimator),
    );
    this.padding = this.createPaddingInjector();
    if (typeof trackOrKind !== "string") {
      this.registerTrack(trackOrKind);
    }
    this.bwe.syncProcessTimer();
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
    const previous = this.dtlsTransport;
    if (previous) {
      this.dtlsDisposer.forEach((dispose) => dispose());
    }

    this.dtlsTransport = dtlsTransport;
    // A stopped sender (also one a rollback binds again) sends nothing and
    // does not subscribe to the transport, which may outlive it.
    if (this.stopped) {
      this.dtlsDisposer = [];
      return;
    }
    if (previous && previous !== dtlsTransport) {
      this.resetBweForNewTransport();
    }
    this.dtlsDisposer = [
      this.dtlsTransport.onStateChange.subscribe((state) => {
        this.syncNetworkAvailability();
        if (state === "connected") {
          this.onReady.execute();
          void this.drainPendingRtp();
        }
      }).unSubscribe,
    ];
    this.syncNetworkAvailability();
  }

  /**
   * Replace the send-side bandwidth estimator used for TWCC-driven BWE.
   *
   * Default is the legacy {@link SenderBandwidthEstimator}. Pass e.g.
   * `new GccBandwidthEstimator()` to use Google Congestion Control.
   *
   * Behavior on swap:
   * 1. Bumps the estimator generation so in-flight sends discard
   *    `rtpPacketSent` delivery and in-flight {@link maybeInjectProbePadding}
   *    loops exit (cancelled — no packets to disposed / previous estimator).
   * 2. Stops delivering `rtpPacketSent` / `receiveTWCC` to the previous instance.
   * 3. Unbinds the stable {@link onAvailableBitrate} bridge, then `dispose()`/`reset()` the old instance.
   * 4. **Always** `reset()` the injected `impl` so a previously used instance
   *    starts clean (no implicit state merge), then rebinds the bridge.
   * 5. Clears {@link pendingUntrackedBytes} and pacing credit so the next
   *    estimator's first `SentInfo.priorUnackedBytes` is 0.
   *
   * Subscriptions to {@link onAvailableBitrate} on this sender are preserved.
   * Re-subscribe algorithm-specific events on the new concrete instance.
   */
  setBandwidthEstimator(impl: BandwidthEstimator): void {
    // Invalidate in-flight media/padding so they do not touch the next estimator
    // (or revive a disposed probe controller after dispose/reset).
    this.bwe.replace(impl);
    this.resetBweSendTransientState();
    this.syncNetworkAvailability();
    this.bwe.syncProcessTimer();
    // New generation may have missed onProbeClusterConfig while the previous
    // drain still held the same-generation re-entry lock.
    void this.maybeInjectProbePadding();
  }

  /**
   * A new DTLS transport has its own transport-wide sequence space and path:
   * drop the estimator's path state ({@link EstimatorBinding.resetForNewRoute},
   * which also bumps the generation so in-flight sends on the old transport
   * do not report their old TSN) and the pacing / unacked leftovers.
   */
  private resetBweForNewTransport(): void {
    this.bwe.resetForNewRoute();
    this.resetBweSendTransientState();
    this.bwe.syncProcessTimer();
  }

  /** Drop pacing leftover and unacked bytes that belonged to the previous BWE generation. */
  private resetBweSendTransientState(): void {
    this.pacer.reset();
    this.pendingUntrackedBytes = 0;
  }

  /** Initial probes wait until DTLS can send; also on a swap onto a connected sender. */
  private syncNetworkAvailability(): void {
    this.bwe.syncNetworkAvailability(this.dtlsTransport?.state === "connected");
  }

  /**
   * Effective send pacing rate (bps): estimator estimate, raised to the active
   * probe target while probing. 0 when unknown. Legacy returns 0 from
   * {@link BandwidthEstimator.getPacingBitrateBps} so media is unpaced.
   */
  get pacingBitrateBps(): number {
    const estimator = this.bwe.estimator;
    const paced = estimator.getPacingBitrateBps();
    return paced > 0 ? paced : estimator.availableBitrate;
  }

  get redDistance() {
    return this._redDistance;
  }
  set redDistance(n: number) {
    this._redDistance = n;
    this.redEncoder.distance = n;
  }

  /** Internal: the negotiated send parameters, for a negotiation baseline. */
  snapshotSendParams() {
    return {
      cname: this.cname,
      mid: this.mid,
      headerExtensions: [...this.headerExtensions],
      rtpStreamId: this.rtpStreamId,
      repairedRtpStreamId: this.repairedRtpStreamId,
      codec: this.codec,
      negotiatedCodecs: [...this.negotiatedCodecs],
      sendPrimaryCodec: this.sendPrimaryCodec,
      proposedPrimaryCodec: this.proposedPrimaryCodec,
      track: this.track,
      trackCodec: this.track?.codec,
      rtxPayloadType: this.rtxPayloadType,
      redRedundantPayloadType: this.redRedundantPayloadType,
    };
  }

  /**
   * Internal: a pending remote offer proposes `codecs` for the answer while
   * the committed codec keeps sending until the final answer.
   */
  proposeSend(codecs: RTCRtpCodecParameters[]) {
    this.proposedPrimaryCodec = primarySendCodecOf(codecs);
  }

  /** Internal: return to a negotiation baseline's send parameters. */
  restoreSendParams(snapshot: ReturnType<RTCRtpSender["snapshotSendParams"]>) {
    this.cname = snapshot.cname;
    this.mid = snapshot.mid;
    this.headerExtensions = [...snapshot.headerExtensions];
    this.rtpStreamId = snapshot.rtpStreamId;
    this.repairedRtpStreamId = snapshot.repairedRtpStreamId;
    this.codec = snapshot.codec;
    this.negotiatedCodecs = [...snapshot.negotiatedCodecs];
    this.sendPrimaryCodec = snapshot.sendPrimaryCodec;
    this.proposedPrimaryCodec = snapshot.proposedPrimaryCodec;
    if (this.track) {
      // A track attached during the rolled-back negotiation sends with the
      // restored codec, not the one a pranswer applied.
      this.track.codec =
        this.track === snapshot.track ? snapshot.trackCodec : this.codec;
    }
    this.rtxPayloadType = snapshot.rtxPayloadType;
    this.redRedundantPayloadType = snapshot.redRedundantPayloadType;
  }

  prepareSend(params: RTCRtpSendParameters) {
    this.cname = params.rtcp?.cname;
    this.mid = params.muxId;
    this.headerExtensions = params.headerExtensions;
    // Keep a RID set via sendEncodings/setParameters when SDP carries none.
    this.rtpStreamId = params.rtpStreamId ?? this.rtpStreamId;
    this.repairedRtpStreamId = params.repairedRtpStreamId;

    this.negotiatedCodecs = [...params.codecs];
    this.proposedPrimaryCodec = undefined;
    this.codec = sendCodecOf(params.codecs);
    this.sendPrimaryCodec = primarySendCodecOf(params.codecs);
    if (this.track) {
      this.track.codec = this.codec;
    }

    // Derived from these codecs only: a description without RTX/RED turns
    // them off instead of keeping an earlier negotiation's payload type.
    this.rtxPayloadType = undefined;
    this.redRedundantPayloadType = undefined;
    params.codecs.forEach((codec) => {
      const codecParams = codecParametersFromString(codec.parameters ?? "");
      if (
        codec.name.toLowerCase() === "rtx" &&
        this.sendPrimaryCodec?.payloadType === codecParams["apt"]
      ) {
        this.rtxPayloadType = codec.payloadType;
      }
    });
    if (
      this.codec?.name.toLowerCase() === "red" &&
      this.sendPrimaryCodec != undefined
    ) {
      this.redRedundantPayloadType = this.sendPrimaryCodec.payloadType;
    }
    void this.drainPendingRtp();
  }

  /**
   * The negotiated direction in effect (the answer's, or a pranswer's while
   * it is pending) does not include sending: RTP is dropped, not queued.
   * @internal
   */
  sendSuppressed = false;

  /** @internal Follow the transceiver's currentDirection. */
  setSendSuppressed(suppressed: boolean) {
    if (this.sendSuppressed === suppressed) return;
    this.sendSuppressed = suppressed;
    if (suppressed) {
      this.pendingRtp.discard();
      // Drop media already accepted into the send FIFO and release a packet
      // parked in a probe / pacing wait (same path as a source switch).
      this.invalidateQueuedSource();
    } else void this.drainPendingRtp();
  }

  private canSendRtp() {
    return (
      !this.stopped &&
      !this.sendSuppressed &&
      this.dtlsTransport?.state === "connected" &&
      !!this.codec
    );
  }

  /**
   * Send queued RTP once DTLS is connected and a codec is set.
   * Drain uses {@link sendRtpInternal} so GCC pacing / TWCC stay on the send path.
   */
  private drainPendingRtp() {
    return this.pendingRtp.drain(
      () => this.canSendRtp(),
      (packet, sourceEpoch) => this.dispatchMedia(packet, sourceEpoch),
    );
  }

  registerTrack(track: MediaStreamTrack) {
    if (track.stopped) throw new Error("track is ended");

    captureTrackSourceCodecs(track);

    if (this.disposeTrack) {
      this.disposeTrack();
    }

    track.id = this.trackId;

    const { unSubscribe: unSubscribeRtp } = track.onReceiveRtp.subscribe(
      async (rtp) => {
        await this.sendRtp(rtp);
      },
    );
    const { unSubscribe: unSubscribeSourceChanged } =
      track.onSourceChanged.subscribe((header) => {
        this.replaceRTP(header);
      });
    this.track = track;
    this.disposeTrack = () => {
      unSubscribeRtp();
      unSubscribeSourceChanged();
    };

    if (this.codec) {
      track.codec = this.codec;
    }
  }

  setStreams(streams: MediaStream[] = []) {
    this.streamIds = [...new Set(streams.map((stream) => stream.id))];
  }

  setSendEncodings(encodings: Array<Record<string, unknown>> = []) {
    this.sendEncodings =
      encodings.length > 0
        ? encodings.map((encoding) => ({ ...encoding }))
        : [{}];
    const rid = this.sendEncodings.find(
      (encoding) => typeof encoding.rid === "string",
    )?.rid;
    if (typeof rid === "string") {
      this.rtpStreamId = rid;
    }
  }

  async replaceTrack(track: MediaStreamTrack | null) {
    if (track === null) {
      this.detachTrack();
      return;
    }

    if (track.stopped) throw new Error("track is ended");

    captureTrackSourceCodecs(track);
    const sourceCodecs = getTrackSourceCodecs(track);
    const incompatible = [
      this.sendPrimaryCodec,
      this.proposedPrimaryCodec,
    ].find(
      (primary) =>
        primary != undefined &&
        sourceCodecs != undefined &&
        !sourceCodecs.some((source) => isCodecCompatible(source, primary)),
    );
    if (incompatible) {
      throw createWebRtcDomException(
        "InvalidModificationError",
        `Track codec ${sourceCodecs!.map((codec) => codec.mimeType).join(", ")} is incompatible with negotiated codec ${incompatible.mimeType}`,
      );
    }

    if (this.continuity.sequenceNumber != undefined) {
      this.scheduleRtpContinuity();
    } else {
      this.invalidateQueuedSource();
    }

    this.registerTrack(track);
    log("replaceTrack", "ssrc", track.ssrc, "rid", track.rid);
  }

  /**
   * Detach the current track without stopping the sender (`removeTrack`).
   * The same sender can resume sending after `replaceTrack(track)`.
   */
  detachTrack() {
    this.continuity.cancel();
    this.pendingRtp.discard();
    this.invalidateQueuedSource();
    if (this.disposeTrack) {
      this.disposeTrack();
      this.disposeTrack = undefined;
    }
    this.track = null;
  }

  stop({ keepTrack = false }: { keepTrack?: boolean } = {}) {
    this.stopped = true;
    // A stopped sender sends nothing: release its subscription on the
    // (possibly BUNDLE-shared) DTLS transport, which outlives it.
    for (const dispose of this.dtlsDisposer) dispose();
    this.dtlsDisposer = [];
    this.continuity.cancel();
    this.pendingRtp.discard();
    // Invalidate in-flight sendRtp / maybeInjectProbePadding before dispose
    // so they cannot emit padding or revive a disposed estimator.
    this.bwe.bumpGeneration();
    this.rtcpRunning = false;
    this.rtcpCancel.abort();
    this.bwe.close();
    if (this.disposeTrack) {
      this.disposeTrack();
      this.disposeTrack = undefined;
    }
    if (!keepTrack) {
      this.track = null;
    }
    this.dtlsDisposer.forEach((dispose) => dispose());
    this.dtlsDisposer = [];
  }

  async runRtcp() {
    if (this.rtcpRunning || this.stopped) return;
    this.rtcpRunning = true;

    try {
      while (this.rtcpRunning) {
        await setTimeout(500 + Math.random() * 1000, undefined, {
          signal: this.rtcpCancel.signal,
        });

        const packets: RtcpPacket[] = [this.buildSenderReport()];

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

  /** Sender Report for the instant `nowMonotonicMs` ({@link SenderStatistics.buildSenderReport}). */
  private buildSenderReport(nowMonotonicMs = performance.now()) {
    return this.stats.buildSenderReport(this.ssrc, nowMonotonicMs);
  }

  /**
   * Schedule RTP continuity rewrite for the next packet that is actually sent.
   * The header argument is kept for API compatibility and is not used to compute
   * offsets. `discontinuity` does not change sequence or timestamp mapping.
   * `timestampStep` (default 1) is the only way to choose the timestamp increment
   * at the source-switch boundary.
   */
  replaceRTP(
    header: Pick<RtpHeader, "sequenceNumber" | "timestamp">,
    discontinuity = false,
    timestampStep = 1,
  ) {
    this.scheduleRtpContinuity(timestampStep);
    log(
      "replaceRTP",
      this.continuity.sequenceNumber,
      header.sequenceNumber,
      discontinuity,
      timestampStep,
    );
  }

  /**
   * Start a new source epoch and drop queued media of the previous source.
   * A packet already past sequence allocation (in its DTLS write) completes;
   * one still waiting on pacing/probe is dropped by {@link sendRtpInternal}.
   */
  private invalidateQueuedSource() {
    this.sourceEpoch++;
    // Release the running FIFO task if it is a stale packet parked in a
    // probe / pacing wait, so new-source media is not held behind it.
    this.sourceEpochCancel.abort();
    this.sourceEpochCancel = new AbortController();
    this.outgoing.dropStaleSource(this.sourceEpoch);
    this.pendingRtp.dropStaleSource(this.sourceEpoch);
  }

  private isStaleSource(sourceEpoch: number | undefined): boolean {
    return sourceEpoch !== undefined && sourceEpoch !== this.sourceEpoch;
  }

  /**
   * Abort signal for a send wait: sender stop, estimator swap, plus source
   * switch for media.
   */
  private sendWaitSignal(sourceEpoch: number | undefined): AbortSignal {
    const signals = [this.rtcpCancel.signal, this.bwe.generationSignal];
    if (sourceEpoch !== undefined) {
      signals.push(this.sourceEpochCancel.signal);
    }
    return AbortSignal.any(signals);
  }

  /** A waiting send may still go out: not stopped, same estimator, same source. */
  private isSendAlive(generation: number, sourceEpoch: number | undefined) {
    return (
      !this.stopped &&
      generation === this.bwe.generation &&
      !this.isStaleSource(sourceEpoch)
    );
  }

  private scheduleRtpContinuity(timestampStep = 1) {
    this.invalidateQueuedSource();
    this.continuity.schedule(timestampStep);
    this.rtpCache = [];
  }

  private dispatchMedia(packet: RtpPacket, sourceEpoch: number) {
    return this.dispatchOutgoing(
      () =>
        this.sendRtpInternal(packet, {
          injectProbePadding: true,
          sourceEpoch,
        }),
      { kind: "media", bytes: estimateOutgoingBytes(packet), sourceEpoch },
    );
  }

  /**
   * Legacy / disabled estimators neither pace nor probe, so RTP is written
   * straight through as before the BWE abstraction: no FIFO, no queue limit,
   * and no wait before the DTLS write. Pacing estimators (GCC) go through
   * {@link outgoing}. A FIFO still draining after an estimator swap
   * keeps its order by queuing behind it.
   */
  private dispatchOutgoing(
    task: () => Promise<void>,
    meta: OutgoingMeta,
  ): Promise<void | undefined> {
    if (!this.outgoing.running && !needsPacedSendPath(this.bwe.estimator)) {
      return task();
    }
    return this.outgoing.enqueue(task, meta);
  }

  /**
   * Send immediately by default or queue until DTLS is ready when pending RTP
   * is enabled. Each call settles only after its own packet is sent or dropped.
   */
  async sendRtp(rtp: Buffer | RtpPacket) {
    // Drop (do not queue) while the negotiated direction does not send, so
    // nothing is flushed in a burst when sending resumes.
    if (this.stopped || this.sendSuppressed) {
      return;
    }
    if (!this.pendingRtpEnabled) {
      if (!this.canSendRtp()) {
        return;
      }
      // Own the packet before any pacing wait: a track shared by several
      // senders hands every subscriber the same RtpPacket, and header
      // rewrites (SSRC/seq/extensions) must not leak across senders.
      const packet = Buffer.isBuffer(rtp)
        ? RtpPacket.deSerialize(rtp)
        : rtp.clone();
      await this.dispatchMedia(packet, this.sourceEpoch);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.pendingRtp.enqueue(rtp, this.sourceEpoch, resolve, reject);
      void this.drainPendingRtp();
    });
  }

  /** True when transport-wide CC header extension is negotiated. */
  private isTransportCcNegotiated(): boolean {
    return this.headerExtensions.some(
      (e) => e.uri === RTP_EXTENSION_URI.transportWideCC,
    );
  }

  /**
   * Padding needs an estimator that asks for it, TWCC so feedback can see it,
   * and a negotiated RTX stream to carry it. Without RTX no padding is sent
   * (see `GCC_KNOWN_DIFFERENCES`): media sequence numbers stay untouched.
   */
  private canSendPadding(): boolean {
    return (
      !this.sendSuppressed &&
      isProbePacingController(this.bwe.estimator) &&
      this.rtxPayloadType !== undefined &&
      this.isTransportCcNegotiated()
    );
  }

  /**
   * Inject RTP padding packets while a GCC probe cluster is active and media
   * alone has not yet filled min packets / min bitrate×duration.
   *
   * Responsibility split:
   * - Estimator (`ProbeController` / `pendingProbePaddingPackets`) decides need
   * - Sender generates padding-only RTP on the RTX SSRC with a TWCC seq +
   *   `isProbation` and paces them
   */
  async maybeInjectProbePadding(): Promise<number> {
    if (!this.canSendPadding()) {
      return 0;
    }
    if (this.nestOutgoingPadding) {
      return this.padding.drainProbe();
    }
    return (
      (await this.outgoing.enqueue(() => this.padding.drainProbe(), {
        kind: "padding",
        bytes: this.bwe.estimator.probePaddingPacketBytes,
      })) ?? 0
    );
  }

  /**
   * pin padding_rate while LossBased is `kIncreaseUsingPadding`.
   * Regular RTP padding (not probe/probation). Probe padding takes priority.
   */
  async maybeInjectLossPadding(): Promise<number> {
    if (!this.canSendPadding()) {
      return 0;
    }
    return (
      (await this.outgoing.enqueue(() => this.padding.drainLoss(), {
        kind: "padding",
        bytes: this.bwe.estimator.probePaddingPacketBytes,
      })) ?? 0
    );
  }

  private createPaddingInjector() {
    const sender = this;
    return new PaddingInjector({
      get estimator() {
        return sender.bwe.estimator;
      },
      get generation() {
        return sender.bwe.generation;
      },
      canDrain: () =>
        !sender.stopped &&
        sender.dtlsTransport?.state === "connected" &&
        !!sender.codec &&
        sender.canSendPadding(),
      isCancelled: (generation) =>
        sender.stopped ||
        sender.sendSuppressed ||
        generation !== sender.bwe.generation,
      hasQueuedRealtimeMedia: () => sender.outgoing.hasQueuedRealtimeMedia(),
      sendPadding: (packetBytes, probe) =>
        sender.sendRtpInternal(sender.createPaddingRtpPacket(packetBytes), {
          injectProbePadding: false,
          forceProbeTag: probe,
          isProbePadding: true,
        }),
    });
  }

  /** Padding-only RTP on the RTX SSRC / payload type ({@link createRtxPaddingPacket}). */
  private createPaddingRtpPacket(paddingSize: number): RtpPacket {
    return createRtxPaddingPacket({
      paddingSize,
      timestamp: this.continuity.timestamp ?? 0,
      payloadType: this.rtxPayloadType!,
      ssrc: this.rtxSsrc,
    });
  }

  private async sendRtpInternal(
    rtp: Buffer | RtpPacket,
    opts: {
      injectProbePadding?: boolean;
      forceProbeTag?: boolean;
      /**
       * Padding-only packet on the RTX SSRC. Takes the next RTX sequence at
       * send time and never touches the media sequence / timestamp mapping.
       */
      isProbePadding?: boolean;
      /**
       * RTX / same-SSRC retransmission. Keep wrapRtx identity (ssrc / PT /
       * RTX sequence). Still allocate a **new** transport-wide seq.
       */
      isRetransmission?: boolean;
      /** Source epoch at sendRtp acceptance; stale media is dropped. */
      sourceEpoch?: number;
    } = {},
  ) {
    if (this.stopped) return;
    // Not sending in the negotiated direction: drop media and padding.
    // NACK retransmissions keep develop's behavior.
    if (this.sendSuppressed && !opts.isRetransmission) return;
    if (this.dtlsTransport.state !== "connected" || !this.codec) {
      return;
    }
    const sendClockRate = (this.sendPrimaryCodec ?? this.codec).clockRate;

    rtp = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;

    const { header, payload } = rtp;

    // Capture BWE generation at send start. After await sendRtp, only deliver
    // SentInfo when the generation is unchanged — mid-send setBandwidthEstimator
    // must not pollute the new clean estimator with packets planned under the old one.
    const sendGeneration = this.bwe.generation;
    const estimatorAtStart = this.bwe.estimator;

    const twccOn = this.isTransportCcNegotiated();
    // Legacy / disabled: no probe reservation or pacing wait (direct path).
    const paced = needsPacedSendPath(estimatorAtStart);

    // Stale source: drop before touching probe reservation or pacing budget.
    if (this.isStaleSource(opts.sourceEpoch)) {
      return;
    }

    // pin CurrentCluster: reserve probe id **before** the async send so a
    // concurrent completion cannot re-attribute this packet to the next cluster.
    let reservedClusterId: number | undefined;
    const wantsProbe =
      opts.forceProbeTag === true || estimatorAtStart.shouldTagProbePacket();
    if (paced && twccOn && wantsProbe) {
      const reservation = estimatorAtStart.reserveOutgoingProbe(milliTime());
      if (reservation) {
        reservedClusterId = reservation.clusterId;
        if (
          !(await this.awaitProbeSendTime(
            reservation.nextSendTimeMs,
            sendGeneration,
            opts.sourceEpoch,
          ))
        ) {
          return;
        }
      } else if (opts.forceProbeTag) {
        // Cluster already filled / discarded — do not emit untagged padding.
        return;
      }
    }

    const inputSequenceNumber = header.sequenceNumber;
    const inputTimestamp = header.timestamp;

    if (opts.isProbePadding) {
      // Padding is only ever sent on the negotiated RTX stream.
      if (this.rtxPayloadType === undefined) return;
      header.ssrc = this.rtxSsrc;
      header.payloadType = this.rtxPayloadType;
    } else if (!opts.isRetransmission) {
      header.ssrc = this.ssrc;
      header.payloadType = this.codec.payloadType;
      header.timestamp = this.continuity.mapTimestamp(inputTimestamp);
    }

    header.extensions = buildSendHeaderExtensions(
      header.extensions,
      this.headerExtensions,
      {
        mid: this.mid,
        rtpStreamId: this.rtpStreamId,
        repairedRtpStreamId: this.repairedRtpStreamId,
      },
    );

    const useRed =
      !!this.redRedundantPayloadType &&
      !opts.isProbePadding &&
      !opts.isRetransmission;
    const estimatedPayloadLen = useRed
      ? this.redEncoder.serializedLengthWith({
          block: payload,
          timestamp: header.timestamp,
          blockPT: this.redRedundantPayloadType!,
        })
      : payload.length;
    const rfcPaddingLen =
      header.padding && header.paddingSize > 0 ? header.paddingSize : 0;
    const constructedBytes =
      header.serializeSize + estimatedPayloadLen + rfcPaddingLen;
    if (
      paced &&
      reservedClusterId === undefined &&
      this.mediaPacingEnabled &&
      twccOn &&
      estimatorAtStart.getPacingBitrateBps() > 0
    ) {
      if (
        !(await this.awaitPacingBudget(
          constructedBytes,
          sendGeneration,
          opts.sourceEpoch,
        ))
      ) {
        return;
      }
    }

    if (this.stopped || sendGeneration !== this.bwe.generation) {
      return;
    }
    // Direction changed to not sending while this packet waited.
    if (this.sendSuppressed && !opts.isRetransmission) {
      return;
    }
    // Accepted under a replaced/detached source: never send it, and never let
    // it consume the new source's continuity offset.
    if (this.isStaleSource(opts.sourceEpoch)) {
      return;
    }

    if (opts.isProbePadding) {
      // RTX owns its sequence space, so padding never shifts media numbers.
      header.sequenceNumber = this.rtxSequenceNumber;
      this.rtxSequenceNumber = uint16Add(this.rtxSequenceNumber, 1);
      header.timestamp = this.continuity.timestamp ?? header.timestamp;
    } else if (!opts.isRetransmission) {
      if (this.continuity.assign(header, inputSequenceNumber, inputTimestamp)) {
        // ソース境界を SR の RTP/NTP 基準にも反映する。
        this.stats.resetClockAnchor();
      }
    }

    let rtpPayload = payload;
    if (useRed) {
      this.redEncoder.push({
        block: rtpPayload,
        timestamp: header.timestamp,
        blockPT: this.redRedundantPayloadType!,
      });
      rtpPayload = this.redEncoder.build().serialize();
    }
    const payloadOctetsForSr = rtpPayload.length;
    if (header.padding && header.paddingSize > 0) {
      rtpPayload = appendRfc3550Padding(rtpPayload, header.paddingSize);
    }

    const packetWideSeq = stampHopByHopExtensions(
      header,
      this.headerExtensions,
      {
        twccOn,
        allocateTransportWideSequence: () =>
          this.dtlsTransport.allocateTransportWideSequence(),
        ntpTimestamp: ntpTime(),
      },
    );

    if (opts.isProbePadding) {
      // RTX padding: not part of the media SSRC's SR packet / octet counts.
    } else if (opts.isRetransmission) {
      this.stats.recordRetransmissionSent(header.serializeSize, payload.length);
    } else {
      this.stats.recordMediaSent(header.serializeSize, payloadOctetsForSr);
      if (!isPaddingOnlyRtpPacket(rtp)) {
        this.rtpCache[header.sequenceNumber % RTP_HISTORY_SIZE] = rtp;
      }
    }

    const sendingAtMs = milliTime();
    const { size, sendingAtMs: enqueueAtMs } = await sendDtlsRtp(
      this.dtlsTransport,
      rtpPayload,
      header,
      sendingAtMs,
    );
    const sentAtMs = milliTime();

    if (
      !opts.isProbePadding &&
      !opts.isRetransmission &&
      !isPaddingOnlyRtpPacket(rtp)
    ) {
      this.stats.updateClockAnchor(header.timestamp, sendClockRate);
    }

    this.runRtcp();
    // BWE / TWCC only when transport-cc is negotiated — otherwise wideSeq would
    // not advance and probe padding would be useless / harmful.
    // Generation match: estimator was not swapped (or reset) while this packet
    // was in flight. Mismatch → discard (do not feed disposed or new clean BWE).
    if (
      twccOn &&
      packetWideSeq !== undefined &&
      sendGeneration === this.bwe.generation
    ) {
      const priorUnacked = this.pendingUntrackedBytes;
      this.pendingUntrackedBytes = 0;
      const sentInfo: SentInfo = {
        wideSeq: packetWideSeq,
        size,
        sendingAtMs: enqueueAtMs,
        sentAtMs,
        isProbation: reservedClusterId !== undefined,
        probeClusterId: reservedClusterId,
        priorUnackedBytes: priorUnacked,
        isRetransmission: opts.isRetransmission === true,
      };
      estimatorAtStart.rtpPacketSent(sentInfo);
    } else if (twccOn && sendGeneration === this.bwe.generation) {
      // Same generation but no wideSeq (should be rare). Do not fold
      // previous-generation bytes into the next estimator.
      this.pendingUntrackedBytes += size;
    }

    if (
      opts.injectProbePadding &&
      twccOn &&
      isProbePacingController(estimatorAtStart) &&
      sendGeneration === this.bwe.generation
    ) {
      this.nestOutgoingPadding = true;
      try {
        await this.maybeInjectProbePadding();
      } finally {
        this.nestOutgoingPadding = false;
      }
    }
  }

  /** pin BitrateProber next_probe_time wait ({@link waitForProbeSendTime}). */
  private awaitProbeSendTime(
    nextSendTimeMs: number,
    generation: number,
    sourceEpoch?: number,
  ): Promise<boolean> {
    return waitForProbeSendTime(
      nextSendTimeMs,
      () => this.isSendAlive(generation, sourceEpoch),
      () => this.sendWaitSignal(sourceEpoch),
    );
  }

  /**
   * Token-bucket wait against {@link pacingBitrateBps} for **media**.
   * Probe packets use {@link awaitProbeSendTime} instead.
   * Returns false if the sender is stopped, the estimator is swapped
   * (`generation` changes), or the packet's source is replaced/detached while
   * waiting (budget is not consumed then).
   */
  private awaitPacingBudget(
    packetBytes: number,
    generation: number,
    sourceEpoch?: number,
  ): Promise<boolean> {
    return this.pacer.acquire(
      packetBytes,
      this.pacingBitrateBps,
      () => this.isSendAlive(generation, sourceEpoch),
      () => this.sendWaitSignal(sourceEpoch),
    );
  }

  /**
   * @param firEntries Internal: the FCI entries of a FIR the router resolved to
   * this sender (see `KeyFrameRequestRouting`). Defaults to the entries for
   * the own SSRC.
   */
  handleRtcpPacket(
    rtcpPacket: RtcpPacket,
    firEntries?: FullIntraRequest["fir"],
  ) {
    switch (rtcpPacket.type) {
      case RtcpSrPacket.type:
      case RtcpRrPacket.type:
        {
          const packet = rtcpPacket as RtcpSrPacket | RtcpRrPacket;
          packet.reports
            .filter((report) => report.ssrc === this.ssrc)
            .forEach((report) => {
              const rawRttSeconds = this.stats.recordReceptionReport(report);
              // pin OnRoundTripTimeUpdate: only **unsmoothed** RTT goes to
              // AIMD (smoothed updates are discarded in GoogCc).
              // Legacy / disabled no-op setRoundTripTime.
              if (rawRttSeconds !== undefined && rawRttSeconds > 0) {
                this.bwe.estimator.setRoundTripTime(rawRttSeconds * 1000);
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
                this.stats.nackCount++;
                feedback.lost.forEach(async (seqNum) => {
                  let packet: RtpPacket | undefined =
                    this.rtpCache[seqNum % RTP_HISTORY_SIZE];
                  if (packet && packet.header.sequenceNumber !== seqNum) {
                    packet = undefined;
                  }
                  if (packet && isPaddingOnlyRtpPacket(packet)) {
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
                    const retransmission = packet;
                    // Route through sendRtpInternal: new TWCC seq, pacing,
                    // BWE SentInfo. Do not reuse the original transport-wide seq.
                    await this.dispatchOutgoing(
                      () =>
                        this.sendRtpInternal(retransmission, {
                          injectProbePadding: false,
                          isRetransmission: true,
                        }),
                      {
                        kind: "rtx",
                        bytes: estimateOutgoingBytes(retransmission),
                      },
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
          switch (packet.feedback?.count) {
            case ReceiverEstimatedMaxBitrate.count:
              {
                const feedback = packet.feedback as ReceiverEstimatedMaxBitrate;
                this.receiverEstimatedMaxBitrate = feedback.bitrate;
              }
              break;
            case PictureLossIndication.count:
              {
                this.stats.pliCount++;
                this.onPictureLossIndication.execute();
                this.onKeyFrameRequest.execute("pli");
              }
              break;
            case FullIntraRequest.count:
              {
                const feedback = packet.feedback as FullIntraRequest;
                const entries =
                  firEntries ??
                  feedback.fir.filter(({ ssrc }) => ssrc === this.ssrc);
                if (entries.length === 0) break;

                // W3C webrtc-stats: firCount is the number of FIR packets received,
                // however many FCI entries of the packet resolve to this sender
                this.stats.firCount++;
                // an entry with the same sequence number as the last one for its
                // (sender, target) pair is a retransmission (RFC 5104 4.3.1.1)
                let isNew = false;
                for (const { ssrc, sequenceNumber } of entries) {
                  const key = `${feedback.senderSsrc}:${ssrc}`;
                  if (this.lastFirSequenceNumbers.get(key) !== sequenceNumber) {
                    isNew = true;
                  }
                  this.lastFirSequenceNumbers.set(key, sequenceNumber);
                }
                if (isNew) {
                  this.onFullIntraRequest.execute(feedback);
                  this.onKeyFrameRequest.execute("fir");
                }
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

  getStatsRootIds() {
    return [senderStatsIds(this.trackId).outboundRtp];
  }

  collectStats(timestamp: number): RTCStats[] {
    return this.stats.collect(
      {
        trackId: this.trackId,
        ssrc: this.ssrc,
        kind: this.kind,
        mid: this.mid,
        dtlsTransport: this.dtlsTransport,
        codec: this.codec,
        rtxSsrc: this.rtxPayloadType ? this.rtxSsrc : undefined,
        trackIdentifier: this.track
          ? (this.track.id ?? this.trackId)
          : undefined,
      },
      timestamp,
    );
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

/** The codec RTP is sent with: the first non-RTX codec. */
function sendCodecOf(codecs: RTCRtpCodecParameters[]) {
  return (
    codecs.find((codec) => codec.name.toLowerCase() !== "rtx") ?? codecs[0]
  );
}

/** The media codec RTP carries: RED's primary payload, else the send codec. */
function primarySendCodecOf(codecs: RTCRtpCodecParameters[]) {
  const codec = sendCodecOf(codecs);
  if (codec?.name.toLowerCase() !== "red") return codec;
  const primaryPayloadType = Number((codec.parameters ?? "").split("/")[0]);
  return codecs.find(
    (candidate) =>
      !["red", "rtx"].includes(candidate.name.toLowerCase()) &&
      candidate.payloadType === primaryPayloadType,
  );
}
