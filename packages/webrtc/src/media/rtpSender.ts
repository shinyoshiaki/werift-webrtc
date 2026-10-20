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
import {
  Event,
  random16,
  uint16Add,
  uint16Gt,
  uint32Add,
} from "../imports/common";

import { codecParametersFromString } from "..";
import { createWebRtcDomException } from "../errors";
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
  isPaddingOnlyRtpPacket,
  serializeAbsSendTime,
  serializeRepairedRtpStreamId,
  serializeSdesMid,
  serializeSdesRTPStreamID,
  serializeTransportWideCC,
  wrapRtx,
} from "../imports/rtp";
import { RTCDtlsTransport } from "../transport/dtls";
import type { Kind } from "../types/domain";
import { compactNtp, milliTime, ntpTime, timestampSeconds } from "../utils";
import { isCodecCompatible } from "./codecCompatibility";
import type {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpSendParameters,
} from "./parameters";
import type {
  BandwidthEstimator,
  LegacyCongestionCompatibility,
  ProbeClusterConfig,
} from "./sender/bandwidthEstimator";
import { SenderBandwidthEstimator, type SentInfo } from "./sender/senderBWE";
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
import {
  type MediaStream,
  type MediaStreamTrack,
  captureTrackSourceCodecs,
  getTrackSourceCodecs,
} from "./track";

const log = debug("werift:packages/webrtc/src/media/rtpSender.ts");

const RTP_HISTORY_SIZE = 128;
const DEFAULT_PENDING_RTP_MAX_LENGTH = 256;
const RTT_ALPHA = 0.85;
/** Per-sender send FIFO caps. Video drops stale frames; audio is looser on count. */
const kOutgoingQueueMaxPacketsVideo = 48;
const kOutgoingQueueMaxPacketsAudio = 250;
const kOutgoingQueueMaxBytesVideo = 512 * 1024;
const kOutgoingQueueMaxBytesAudio = 64 * 1024;
const kOutgoingQueueMaxDurationMsVideo = 500;
const kOutgoingQueueMaxDurationMsAudio = 200;

type OutgoingKind = "media" | "rtx" | "padding";

type OutgoingQueued = {
  kind: OutgoingKind;
  bytes: number;
  enqueuedAtMs: number;
  start: () => void;
  drop: () => void;
  /** Source epoch of a queued media packet; undefined for padding / RTX. */
  sourceEpoch?: number;
};

function freezeRtpContinuityOffsets(
  lastOutputSeq: number,
  lastOutputTimestamp: number,
  firstInputSeq: number,
  firstInputTimestamp: number,
  timestampStep: number,
) {
  return {
    seqOffset: uint16Add(uint16Add(lastOutputSeq, 1), -firstInputSeq),
    timestampOffset: uint32Add(
      uint32Add(lastOutputTimestamp, timestampStep),
      -firstInputTimestamp,
    ),
  };
}

export type PendingRtpOptions = {
  /** Queue RTP until DTLS is connected and a codec is set. Default true when this object is passed. */
  enabled?: boolean;
  /** Max queued packets when enabled. Oldest packets are dropped. Default 256. */
  maxLength?: number;
};

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

type PendingRtpItem = {
  packet: RtpPacket;
  sourceEpoch: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function resolvePendingRtpOptions(
  pendingRtp: RTCRtpSenderOptions["pendingRtp"],
): { enabled: boolean; maxLength: number } {
  if (pendingRtp === true) {
    return { enabled: true, maxLength: DEFAULT_PENDING_RTP_MAX_LENGTH };
  }
  if (pendingRtp == undefined || pendingRtp === false) {
    return { enabled: false, maxLength: DEFAULT_PENDING_RTP_MAX_LENGTH };
  }
  const maxLength =
    typeof pendingRtp.maxLength === "number" &&
    Number.isFinite(pendingRtp.maxLength) &&
    pendingRtp.maxLength >= 1
      ? Math.floor(pendingRtp.maxLength)
      : DEFAULT_PENDING_RTP_MAX_LENGTH;
  return { enabled: pendingRtp.enabled ?? true, maxLength };
}

/**
 * Production uses {@link RTCDtlsTransport.sendRtpWithMeta} for ICE-enqueue time.
 * Tests that stub {@link RTCDtlsTransport.sendRtp} keep a number (or object) return.
 */
async function sendDtlsRtp(
  dtls: RTCDtlsTransport,
  payload: Buffer,
  header: RtpHeader,
  fallbackSendingAtMs: number,
): Promise<{ size: number; sendingAtMs: number }> {
  const mocked = dtls.sendRtp !== RTCDtlsTransport.prototype.sendRtp;
  if (!mocked) {
    return dtls.sendRtpWithMeta(payload, header);
  }
  const sent: unknown = await dtls.sendRtp(payload, header);
  if (
    typeof sent === "object" &&
    sent !== null &&
    "size" in sent &&
    typeof (sent as { size: unknown }).size === "number"
  ) {
    const meta = sent as { size: number; sendingAtMs?: number };
    return {
      size: meta.size,
      sendingAtMs: meta.sendingAtMs ?? fallbackSendingAtMs,
    };
  }
  return {
    size: typeof sent === "number" ? sent : 0,
    sendingAtMs: fallbackSendingAtMs,
  };
}

function estimateOutgoingBytes(rtp: Buffer | RtpPacket): number {
  if (Buffer.isBuffer(rtp)) return rtp.length;
  return rtp.header.serializeSize + rtp.payload.length;
}

function estimateRedPayloadLength(
  encoder: RedEncoder,
  block: Buffer,
  timestamp: number,
  blockPT: number,
): number {
  const clone = new RedEncoder(encoder.distance);
  clone.cacheSize = encoder.cacheSize;
  const src = encoder as unknown as {
    cache: { block: Buffer; timestamp: number; blockPT: number }[];
  };
  (clone as unknown as { cache: typeof src.cache }).cache = [...src.cache];
  clone.push({ block, timestamp, blockPT });
  return clone.build().serialize().length;
}

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
  private _senderBWE: BandwidthEstimator;

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
    return this._senderBWE as BandwidthEstimator &
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
  private bweAvailableBitrateUnsub?: () => void;

  /**
   * Probe cluster configs (target bps / min packets). Bridged from the active
   * {@link BandwidthEstimator}; GCC fires this, legacy / disabled never do.
   */
  readonly onProbeClusterConfig = new Event<[ProbeClusterConfig]>();
  private bweProbeUnsub?: () => void;

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
  /** Token-bucket pacer state for **media** (not probe) rate enforcement. */
  private paceBudgetBytes = 0;
  private lastPaceMs = 0;
  /**
   * pin `pending_untracked_size_` — bytes sent without TWCC tracking,
   * attached to the next tracked packet as `priorUnackedBytes`.
   */
  private pendingUntrackedBytes = 0;
  /**
   * FIFO for reservation → pacing wait → sequence allocation → DTLS write.
   * Idle calls start synchronously so Event.execute() tests observe the send.
   * Probe padding may call {@link sendRtpInternal} on this stack only after
   * the current packet's DTLS write ({@link nestOutgoingPadding}); timer /
   * cluster events always enqueue so they cannot share a DTLS write.
   */
  private outgoingRunning = false;
  private outgoingQueue: OutgoingQueued[] = [];
  /**
   * Set only around post-DTLS {@link maybeInjectProbePadding} so padding can
   * drain on the same FIFO task without deadlock. Must stay false during
   * probe/pacing wait, or a cluster event would send in parallel.
   */
  private nestOutgoingPadding = false;
  /**
   * Generation that currently owns the probe/loss padding drain, or `undefined`.
   * Same-generation re-entry is skipped; a newer {@link bweGeneration} may start
   * a drain while an older loop is still unwinding.
   */
  private probePaddingFlightGeneration: number | undefined;
  /**
   * Bumped on every {@link setBandwidthEstimator} (including same-instance reset).
   * In-flight `sendRtpInternal` / `maybeInjectProbePadding` capture the generation
   * at start and discard BWE delivery / stop padding when it no longer matches —
   * so a mid-send swap cannot pollute the new clean estimator or revive a disposed
   * probe controller.
   */
  private bweGeneration = 0;
  /**
   * Sender-clock process timer. Interval comes from
   * {@link BandwidthEstimator.processIntervalMs} (0 = do not start).
   */
  private bweProcessTimer?: ReturnType<typeof setInterval>;

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
  /**
   * Wrap-aware high-water of allocated outbound RTP sequences.
   * Padding always allocates after this; media prefers `source + seqOffset`
   * and only remaps when that candidate was already used (e.g. by padding).
   */
  private highWaterWireSeq?: number;
  /** Recently allocated wire sequences (padding must not reuse media or padding). */
  private usedWireSeqs = new Set<number>();
  /** Wire sequences allocated to probe padding. */
  private paddingWireSeqs = new Set<number>();
  /**
   * Recent source media seq → wire seq. A delayed source duplicate keeps the
   * wire seq of its first copy instead of taking a fresh one that the next
   * in-order packet would also map to.
   */
  private sourceToWireSeq = new Map<number, number>();
  /** Reverse of {@link sourceToWireSeq}, used when pruning old wire seqs. */
  private wireToSourceSeq = new Map<number, number>();
  private timestamp?: number;
  private timestampOffset = 0;
  private seqOffset = 0;
  /** Source seqs of non-forwarded padding, consumed by later media allocation. */
  private skippedSourceSeqs: number[] = [];
  private rtpContinuityPending = false;
  private pendingTimestampStep = 1;
  private rtpCache: RtpPacket[] = [];
  private pendingRtp: PendingRtpItem[] = [];
  /**
   * Bumped on replaceTrack / detachTrack / onSourceChanged. Media accepted
   * under an older epoch is dropped before it can allocate seq/timestamp, so
   * it neither consumes the new source's continuity offset nor leaks out
   * after `replaceTrack(null)`.
   */
  private sourceEpoch = 0;
  /** Aborted on every source epoch bump to wake probe / pacing waits. */
  private sourceEpochCancel = new AbortController();
  /** Aborted on every BWE generation bump to wake probe / pacing waits. */
  private bweGenerationCancel = new AbortController();
  private drainingPendingRtp = false;
  private readonly pendingRtpEnabled: boolean;
  private readonly pendingRtpMaxLength: number;
  codec?: RTCRtpCodecParameters;
  private negotiatedCodecs: RTCRtpCodecParameters[] = [];
  private sendPrimaryCodec?: RTCRtpCodecParameters;
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
    this.pendingRtpMaxLength = pendingRtp.maxLength;
    this.kind =
      typeof this.trackOrKind === "string"
        ? this.trackOrKind
        : this.trackOrKind.kind;
    this._senderBWE =
      options?.bandwidthEstimator ?? new SenderBandwidthEstimator();
    if (typeof trackOrKind !== "string") {
      this.registerTrack(trackOrKind);
    }
    this.bindBandwidthEstimatorEvents(this._senderBWE);
    this.syncBweProcessTimer();
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
   * 1. Bumps {@link bweGeneration} so in-flight sends discard `rtpPacketSent`
   *    delivery and in-flight {@link maybeInjectProbePadding} loops exit
   *    (cancelled — no packets to disposed / previous estimator).
   * 2. Clears {@link pendingUntrackedBytes} so the next estimator's first
   *    `SentInfo.priorUnackedBytes` is 0.
   * 3. Stops delivering `rtpPacketSent` / `receiveTWCC` to the previous instance.
   * 3. Unbinds the stable {@link onAvailableBitrate} bridge, then `dispose()`/`reset()` the old instance.
   * 4. **Always** `reset()` the injected `impl` so a previously used instance
   *    starts clean (no implicit state merge), then rebinds the bridge.
   *
   * Subscriptions to {@link onAvailableBitrate} on this sender are preserved.
   * Re-subscribe algorithm-specific events on the new concrete instance.
   */
  setBandwidthEstimator(impl: BandwidthEstimator): void {
    // Invalidate in-flight media/padding so they do not touch the next estimator
    // (or revive a disposed probe controller after dispose/reset).
    this.bumpBweGeneration();
    const prev = this._senderBWE;
    if (prev === impl) {
      // Same instance: still reset so callers get a clean estimator state.
      impl.reset?.();
      this.resetBweSendTransientState();
      this.syncNetworkAvailability();
      this.syncBweProcessTimer();
      void this.maybeInjectProbePadding();
      return;
    }
    this.bweAvailableBitrateUnsub?.();
    this.bweAvailableBitrateUnsub = undefined;
    this.bweProbeUnsub?.();
    this.bweProbeUnsub = undefined;
    if (prev.dispose) {
      prev.dispose();
    } else {
      prev.reset?.();
    }
    // Clean start for the injected estimator (used or fresh).
    impl.reset?.();
    this._senderBWE = impl;
    this.bindBandwidthEstimatorEvents(impl);
    this.resetBweSendTransientState();
    this.syncNetworkAvailability();
    this.syncBweProcessTimer();
    // New generation may have missed onProbeClusterConfig while the previous
    // drain still held the same-generation re-entry lock.
    void this.maybeInjectProbePadding();
  }

  /** Drop pacing leftover and unacked bytes that belonged to the previous BWE generation. */
  private resetBweSendTransientState(): void {
    this.paceBudgetBytes = 0;
    this.lastPaceMs = 0;
    this.pendingUntrackedBytes = 0;
  }

  /**
   * pin `OnNetworkAvailability` — initial probes wait until DTLS can send.
   * Also syncs when swapping onto an already-connected sender.
   * Legacy / disabled no-op `setNetworkAvailable`.
   */
  private syncNetworkAvailability(): void {
    this._senderBWE.setNetworkAvailable(
      this.dtlsTransport?.state === "connected",
    );
  }

  /**
   * pin `GoogCcNetworkControllerFactory::GetProcessInterval`.
   * Interval is {@link BandwidthEstimator.processIntervalMs} (0 = skip).
   */
  private syncBweProcessTimer(): void {
    this.stopBweProcessTimer();
    if (this.stopped) return;
    const intervalMs = this._senderBWE.processIntervalMs;
    if (!(intervalMs > 0)) return;
    const timer = setInterval(() => {
      if (this.stopped) return;
      this._senderBWE.process(milliTime());
      // pin GetPacingRates padding_rate while kIncreaseUsingPadding.
      void this.maybeInjectLossPadding();
    }, intervalMs);
    timer.unref?.();
    this.bweProcessTimer = timer;
  }

  private stopBweProcessTimer(): void {
    if (this.bweProcessTimer !== undefined) {
      clearInterval(this.bweProcessTimer);
      this.bweProcessTimer = undefined;
    }
  }

  private bindBandwidthEstimatorEvents(impl: BandwidthEstimator) {
    this.bweAvailableBitrateUnsub?.();
    this.bweAvailableBitrateUnsub = impl.onAvailableBitrate.subscribe((bps) => {
      this.onAvailableBitrate.execute(bps);
    }).unSubscribe;

    this.bweProbeUnsub?.();
    this.bweProbeUnsub = impl.onProbeClusterConfig.subscribe((cfg) => {
      this.onProbeClusterConfig.execute(cfg);
      // pin BitrateProber: no prepaid token-bucket credit. Probe packets
      // wait on next_probe_time = started_at + sent_bytes / send_bitrate.
      void this.maybeInjectProbePadding();
    }).unSubscribe;
  }

  /**
   * Effective send pacing rate (bps): estimator estimate, raised to the active
   * probe target while probing. 0 when unknown. Legacy returns 0 from
   * {@link BandwidthEstimator.getPacingBitrateBps} so media is unpaced.
   */
  get pacingBitrateBps(): number {
    const paced = this._senderBWE.getPacingBitrateBps();
    return paced > 0 ? paced : this._senderBWE.availableBitrate;
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
    // Keep a RID set via sendEncodings/setParameters when SDP carries none.
    this.rtpStreamId = params.rtpStreamId ?? this.rtpStreamId;
    this.repairedRtpStreamId = params.repairedRtpStreamId;

    this.negotiatedCodecs = [...params.codecs];
    this.codec =
      params.codecs.find((codec) => codec.name.toLowerCase() !== "rtx") ??
      params.codecs[0];
    const redPrimaryPayloadType =
      this.codec?.name.toLowerCase() === "red"
        ? Number((this.codec.parameters ?? "").split("/")[0])
        : undefined;
    this.sendPrimaryCodec =
      this.codec?.name.toLowerCase() === "red"
        ? params.codecs.find(
            (codec) =>
              !["red", "rtx"].includes(codec.name.toLowerCase()) &&
              codec.payloadType === redPrimaryPayloadType,
          )
        : this.codec;
    if (this.track) {
      this.track.codec = this.codec;
    }

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

  private canSendRtp() {
    return (
      !this.stopped && this.dtlsTransport?.state === "connected" && !!this.codec
    );
  }

  private settlePendingRtp(item: PendingRtpItem, error?: unknown) {
    if (error == undefined) {
      item.resolve();
      return;
    }
    item.reject(error);
  }

  private discardPendingRtp() {
    const dropped = this.pendingRtp.splice(0);
    for (const item of dropped) {
      this.settlePendingRtp(item);
    }
  }

  private enqueuePendingRtp(
    rtp: Buffer | RtpPacket,
    resolve: () => void,
    reject: (error: unknown) => void,
  ) {
    const packet = Buffer.isBuffer(rtp)
      ? RtpPacket.deSerialize(rtp)
      : rtp.clone();
    this.pendingRtp.push({
      packet,
      resolve,
      reject,
      sourceEpoch: this.sourceEpoch,
    });
    while (this.pendingRtp.length > this.pendingRtpMaxLength) {
      const dropped = this.pendingRtp.shift();
      if (dropped) {
        this.settlePendingRtp(dropped);
      }
    }
  }

  /**
   * Send queued RTP once DTLS is connected and a codec is set.
   * Drain uses {@link sendRtpInternal} so GCC pacing / TWCC stay on the send path.
   */
  private async drainPendingRtp() {
    if (this.drainingPendingRtp) {
      return;
    }
    this.drainingPendingRtp = true;
    try {
      while (this.pendingRtp.length > 0 && this.canSendRtp()) {
        const item = this.pendingRtp.shift()!;
        if (!this.canSendRtp()) {
          this.settlePendingRtp(item);
          continue;
        }
        try {
          await this.enqueueOutgoing(
            () =>
              this.sendRtpInternal(item.packet, {
                injectProbePadding: true,
                sourceEpoch: item.sourceEpoch,
              }),
            {
              kind: "media",
              bytes: estimateOutgoingBytes(item.packet),
              sourceEpoch: item.sourceEpoch,
            },
          );
          this.settlePendingRtp(item);
        } catch (error) {
          this.settlePendingRtp(item, error);
        }
      }
    } finally {
      this.drainingPendingRtp = false;
    }
    if (this.pendingRtp.length > 0 && this.canSendRtp()) {
      await this.drainPendingRtp();
    }
  }

  registerTrack(track: MediaStreamTrack) {
    if (track.stopped) throw new Error("track is ended");

    captureTrackSourceCodecs(track);

    if (this.disposeTrack) {
      this.disposeTrack();
    }

    track.id = this.trackId;

    const { unSubscribe: unSubscribeRtp } = track.onReceiveRtp.subscribe(
      async (rtp, _extensions, info) => {
        if (info?.type === "padding") {
          // Padding is not forwarded; close its source seq so the media that
          // follows stays contiguous for downstream NACK / depacketization.
          this.skipSourceSequence(rtp);
          return;
        }
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
    if (
      this.sendPrimaryCodec != undefined &&
      sourceCodecs != undefined &&
      !sourceCodecs.some((source) =>
        isCodecCompatible(source, this.sendPrimaryCodec!),
      )
    ) {
      throw createWebRtcDomException(
        "InvalidModificationError",
        `Track codec ${sourceCodecs.map((codec) => codec.mimeType).join(", ")} is incompatible with negotiated codecs ${this.negotiatedCodecs.map((codec) => codec.mimeType).join(", ")}`,
      );
    }

    if (this.sequenceNumber != undefined) {
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
    this.rtpContinuityPending = false;
    this.discardPendingRtp();
    this.invalidateQueuedSource();
    if (this.disposeTrack) {
      this.disposeTrack();
      this.disposeTrack = undefined;
    }
    this.track = null;
  }

  stop({ keepTrack = false }: { keepTrack?: boolean } = {}) {
    this.stopped = true;
    this.rtpContinuityPending = false;
    this.discardPendingRtp();
    // Invalidate in-flight sendRtp / maybeInjectProbePadding before dispose
    // so they cannot emit padding or revive a disposed estimator.
    this.bumpBweGeneration();
    this.rtcpRunning = false;
    this.rtcpCancel.abort();
    this.stopBweProcessTimer();
    this.bweAvailableBitrateUnsub?.();
    this.bweAvailableBitrateUnsub = undefined;
    this.bweProbeUnsub?.();
    this.bweProbeUnsub = undefined;
    if (this._senderBWE.dispose) {
      this._senderBWE.dispose();
    } else {
      this._senderBWE.reset?.();
    }
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
      this.sequenceNumber,
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
    const stale = this.outgoingQueue.filter(
      (queued) =>
        queued.sourceEpoch !== undefined &&
        queued.sourceEpoch !== this.sourceEpoch,
    );
    this.outgoingQueue = this.outgoingQueue.filter(
      (queued) => !stale.includes(queued),
    );
    for (const queued of stale) {
      queued.drop();
    }
    const stalePending = this.pendingRtp.filter(
      (item) => item.sourceEpoch !== this.sourceEpoch,
    );
    this.pendingRtp = this.pendingRtp.filter(
      (item) => item.sourceEpoch === this.sourceEpoch,
    );
    for (const item of stalePending) {
      this.settlePendingRtp(item);
    }
  }

  private isStaleSource(sourceEpoch: number | undefined): boolean {
    return sourceEpoch !== undefined && sourceEpoch !== this.sourceEpoch;
  }

  /** Abort signal for a send wait: sender stop, plus source switch for media. */
  /**
   * Invalidate sends planned under the current estimator and release any
   * probe / pacing wait still running at the old estimator's rate.
   */
  private bumpBweGeneration() {
    this.bweGeneration++;
    this.bweGenerationCancel.abort();
    this.bweGenerationCancel = new AbortController();
  }

  /**
   * Abort signal for a send wait: sender stop, estimator swap, plus source
   * switch for media.
   */
  private sendWaitSignal(sourceEpoch: number | undefined): AbortSignal {
    const signals = [this.rtcpCancel.signal, this.bweGenerationCancel.signal];
    if (sourceEpoch !== undefined) {
      signals.push(this.sourceEpochCancel.signal);
    }
    return AbortSignal.any(signals);
  }

  private scheduleRtpContinuity(timestampStep = 1) {
    this.invalidateQueuedSource();
    this.rtpContinuityPending = true;
    this.pendingTimestampStep = timestampStep;
    this.rtpCache = [];
    // New source mapping — clear allocation bookkeeping so prior padding
    // ranges cannot collide with the replaced stream.
    this.usedWireSeqs.clear();
    this.paddingWireSeqs.clear();
    this.sourceToWireSeq.clear();
    this.wireToSourceSeq.clear();
    this.skippedSourceSeqs = [];
    this.highWaterWireSeq = undefined;
  }

  private skipSourceSequence(rtp: Buffer | RtpPacket) {
    if (this.stopped) return;
    const seq = Buffer.isBuffer(rtp)
      ? rtp.readUInt16BE(2)
      : rtp.header.sequenceNumber;
    const skipped = seq & 0xffff;
    if (this.skippedSourceSeqs.includes(skipped)) return;
    this.skippedSourceSeqs.push(skipped);
    if (this.skippedSourceSeqs.length > 256) {
      // Bound the list but keep the count: fold the oldest into the offset.
      this.skippedSourceSeqs.shift();
      this.seqOffset = uint16Add(this.seqOffset, -1);
    }
  }

  /** Shift the wire mapping down for every skipped source seq behind `src`. */
  private consumeSkippedSourceSeqs(src: number) {
    if (this.skippedSourceSeqs.length === 0) return;
    this.skippedSourceSeqs = this.skippedSourceSeqs.filter((skipped) => {
      if (!uint16Gt(src, skipped)) return true;
      this.seqOffset = uint16Add(this.seqOffset, -1);
      return false;
    });
  }

  private markWireSeqUsed(wire: number, isPadding = false) {
    const seq = wire & 0xffff;
    this.usedWireSeqs.add(seq);
    if (isPadding) {
      this.paddingWireSeqs.add(seq);
    }
    if (
      this.highWaterWireSeq === undefined ||
      uint16Gt(seq, this.highWaterWireSeq)
    ) {
      this.highWaterWireSeq = seq;
    }
    // Prune sequences far behind high-water so 16-bit wrap can reuse them.
    if (this.usedWireSeqs.size > 4096 && this.highWaterWireSeq !== undefined) {
      const h = this.highWaterWireSeq;
      for (const s of this.usedWireSeqs) {
        const dist = uint16Add(h, -s);
        if (dist > 4096 && dist < 0x8000) {
          this.usedWireSeqs.delete(s);
          this.paddingWireSeqs.delete(s);
          const src = this.wireToSourceSeq.get(s);
          if (src !== undefined) {
            this.wireToSourceSeq.delete(s);
            if (this.sourceToWireSeq.get(src) === s) {
              this.sourceToWireSeq.delete(src);
            }
          }
        }
      }
    }
  }

  /**
   * True when `seq` is strictly behind {@link highWaterWireSeq} in 16-bit
   * wrap space (a reorder hole), not equal or ahead.
   */
  private isWireSeqBehindHighWater(seq: number): boolean {
    if (this.highWaterWireSeq === undefined) return false;
    const dist = uint16Add(this.highWaterWireSeq, -(seq & 0xffff));
    return dist > 0 && dist < 0x8000;
  }

  /**
   * Media: prefer `sourceSeq + seqOffset` so source gaps/reorders stay
   * visible. A source duplicate reuses the wire seq of its first copy (as
   * develop forwarded the input seq unchanged). Otherwise never reuse a wire
   * seq already given to a different packet (padding or earlier media). After
   * a padding-driven offset bump, a late reorder still occupies its original
   * source seq when that hole is free.
   */
  private allocateMediaSequence(sourceSeq: number): number {
    const src = sourceSeq & 0xffff;
    const known = this.sourceToWireSeq.get(src);
    if (known !== undefined) {
      return known;
    }
    this.consumeSkippedSourceSeqs(src);
    const wire = this.pickMediaWireSeq(src);
    this.markWireSeqUsed(wire);
    this.sourceToWireSeq.set(src, wire);
    this.wireToSourceSeq.set(wire, src);
    return wire;
  }

  private pickMediaWireSeq(src: number): number {
    const preferred = uint16Add(src, this.seqOffset);
    if (!this.usedWireSeqs.has(preferred)) {
      return preferred;
    }

    const behind = this.isWireSeqBehindHighWater(preferred);
    // Offset bump mapped this late packet onto an already-sent seq.
    // Keep the source-relative hole when it is still free (10→pad→11→late 9).
    if (behind && !this.usedWireSeqs.has(src)) {
      return src;
    }

    let wire =
      this.highWaterWireSeq === undefined
        ? uint16Add(preferred, 1)
        : uint16Add(this.highWaterWireSeq, 1);
    while (this.usedWireSeqs.has(wire)) {
      wire = uint16Add(wire, 1);
    }
    if (!behind) {
      this.seqOffset = uint16Add(wire, -src);
    }
    return wire;
  }

  /** Padding: always after high-water so media holes (reorder) stay free. */
  private allocatePaddingSequence(): number {
    let wire =
      this.highWaterWireSeq === undefined
        ? this.sequenceNumber === undefined
          ? 0
          : uint16Add(this.sequenceNumber, 1)
        : uint16Add(this.highWaterWireSeq, 1);
    while (this.usedWireSeqs.has(wire)) {
      wire = uint16Add(wire, 1);
    }
    this.markWireSeqUsed(wire, true);
    return wire;
  }

  /**
   * Serialize reservation → pacing → sequence allocation → DTLS write.
   * Idle calls start the task in this turn so Event.execute() observers
   * see the DTLS write. Concurrent callers wait on {@link outgoingQueue}.
   */
  private enqueueOutgoing<T>(
    task: () => Promise<T>,
    meta: { kind: OutgoingKind; bytes: number; sourceEpoch?: number },
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false;
      const settleOk = (value: T | undefined) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const settleErr = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const start = () => {
        const done = Promise.resolve(task());
        done.then(settleOk, settleErr).finally(() => {
          const next = this.outgoingQueue.shift();
          if (next) {
            next.start();
            return;
          }
          this.outgoingRunning = false;
        });
      };
      const item: OutgoingQueued = {
        kind: meta.kind,
        bytes: meta.bytes,
        enqueuedAtMs: milliTime(),
        start,
        drop: () => settleOk(undefined),
        sourceEpoch: meta.sourceEpoch,
      };
      if (this.outgoingRunning) {
        this.outgoingQueue.push(item);
        this.trimOutgoingQueue();
        return;
      }
      this.outgoingRunning = true;
      start();
    });
  }

  private outgoingQueueLimits() {
    if (this.kind === "audio") {
      return {
        maxPackets: kOutgoingQueueMaxPacketsAudio,
        maxBytes: kOutgoingQueueMaxBytesAudio,
        maxDurationMs: kOutgoingQueueMaxDurationMsAudio,
      };
    }
    return {
      maxPackets: kOutgoingQueueMaxPacketsVideo,
      maxBytes: kOutgoingQueueMaxBytesVideo,
      maxDurationMs: kOutgoingQueueMaxDurationMsVideo,
    };
  }

  private trimOutgoingQueue() {
    // Legacy / disabled estimators do not pace: a burst is written straight
    // through, so dropping queued media would corrupt frames without any
    // congestion signal. Only bound the queue when a pacing estimator (GCC)
    // can actually stall the FIFO.
    if (this._senderBWE.processIntervalMs <= 0) {
      return;
    }
    const { maxPackets, maxBytes, maxDurationMs } = this.outgoingQueueLimits();
    const now = milliTime();
    const queueBytes = () =>
      this.outgoingQueue.reduce((sum, queued) => sum + queued.bytes, 0);
    const overLimit = () => {
      if (this.outgoingQueue.length === 0) return false;
      const oldest = this.outgoingQueue[0];
      const stale = now - oldest.enqueuedAtMs > maxDurationMs;
      return (
        stale ||
        this.outgoingQueue.length > maxPackets ||
        queueBytes() > maxBytes
      );
    };
    while (overLimit()) {
      const paddingIdx = this.outgoingQueue.findIndex(
        (queued) => queued.kind === "padding",
      );
      const idx = paddingIdx >= 0 ? paddingIdx : 0;
      const [dropped] = this.outgoingQueue.splice(idx, 1);
      dropped.drop();
    }
  }

  private hasQueuedRealtimeMedia(): boolean {
    return this.outgoingQueue.some(
      (queued) => queued.kind === "media" || queued.kind === "rtx",
    );
  }

  async sendRtp(rtp: Buffer | RtpPacket) {
    if (this.stopped) {
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
      const sourceEpoch = this.sourceEpoch;
      await this.enqueueOutgoing(
        () =>
          this.sendRtpInternal(packet, {
            injectProbePadding: true,
            sourceEpoch,
          }),
        { kind: "media", bytes: estimateOutgoingBytes(packet), sourceEpoch },
      );
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.enqueuePendingRtp(rtp, resolve, reject);
      void this.drainPendingRtp();
    });
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
  /** True when transport-wide CC header extension is negotiated. */
  private isTransportCcNegotiated(): boolean {
    return this.headerExtensions.some(
      (e) => e.uri === RTP_EXTENSION_URI.transportWideCC,
    );
  }

  async maybeInjectProbePadding(): Promise<number> {
    if (this.nestOutgoingPadding) {
      return this.drainProbePadding();
    }
    return (
      (await this.enqueueOutgoing(() => this.drainProbePadding(), {
        kind: "padding",
        bytes: this._senderBWE.probePaddingPacketBytes,
      })) ?? 0
    );
  }

  private async drainProbePadding(): Promise<number> {
    if (this.stopped) return 0;
    if (this.dtlsTransport?.state !== "connected" || !this.codec) {
      return 0;
    }
    // Probe padding requires TWCC so feedback can validate clusters.
    if (!this.isTransportCcNegotiated()) {
      return 0;
    }
    // Capture estimator + generation for the whole async drain. On swap,
    // generation bumps and we stop — never call dispose()'d controllers.
    const generation = this.bweGeneration;
    if (this.probePaddingFlightGeneration === generation) {
      return 0;
    }
    const e = this._senderBWE;
    const packetBytes = e.probePaddingPacketBytes;
    const maxBurst = e.probePaddingMaxBurst;
    if (!(packetBytes > 0) || !(maxBurst > 0)) {
      return 0;
    }
    this.probePaddingFlightGeneration = generation;
    let totalSent = 0;
    try {
      // Drain the full probe cluster across multiple bursts if needed.
      // Without this, large clusters stall when only maxBurst packets are sent.
      for (let safety = 0; safety < 64; safety++) {
        if (this.stopped || generation !== this.bweGeneration) {
          // stop() / setBandwidthEstimator cancelled this injection.
          break;
        }
        const pending = e.pendingProbePaddingPackets(packetBytes);
        if (pending <= 0) break;
        if (this.hasQueuedRealtimeMedia()) break;
        const n = Math.min(pending, maxBurst);
        for (let i = 0; i < n; i++) {
          if (this.stopped || generation !== this.bweGeneration) break;
          if (this.hasQueuedRealtimeMedia()) break;
          await this.sendRtpInternal(this.createPaddingRtpPacket(packetBytes), {
            injectProbePadding: false,
            forceProbeTag: true,
            isProbePadding: true,
          });
          if (this.stopped || generation !== this.bweGeneration) break;
          totalSent++;
          if (this.hasQueuedRealtimeMedia()) break;
        }
      }
      return totalSent;
    } finally {
      if (this.probePaddingFlightGeneration === generation) {
        this.probePaddingFlightGeneration = undefined;
      }
    }
  }

  /**
   * pin padding_rate while LossBased is `kIncreaseUsingPadding`.
   * Regular RTP padding (not probe/probation). Probe padding takes priority.
   */
  async maybeInjectLossPadding(): Promise<number> {
    return (
      (await this.enqueueOutgoing(() => this.drainLossPadding(), {
        kind: "padding",
        bytes: this._senderBWE.probePaddingPacketBytes,
      })) ?? 0
    );
  }

  private async drainLossPadding(): Promise<number> {
    if (this.stopped) return 0;
    if (this.dtlsTransport?.state !== "connected" || !this.codec) {
      return 0;
    }
    if (!this.isTransportCcNegotiated()) {
      return 0;
    }
    const generation = this.bweGeneration;
    if (this.probePaddingFlightGeneration === generation) return 0;
    const e = this._senderBWE;
    const packetBytes = e.probePaddingPacketBytes;
    const maxBurst = e.probePaddingMaxBurst;
    if (!(packetBytes > 0) || !(maxBurst > 0)) {
      return 0;
    }
    if (e.shouldTagProbePacket()) return 0;
    this.probePaddingFlightGeneration = generation;
    let totalSent = 0;
    try {
      const pending = e.pendingLossPaddingPackets(packetBytes);
      if (pending <= 0) return 0;
      const n = Math.min(pending, maxBurst);
      for (let i = 0; i < n; i++) {
        if (this.stopped || generation !== this.bweGeneration) break;
        if (this.hasQueuedRealtimeMedia()) break;
        await this.sendRtpInternal(this.createPaddingRtpPacket(packetBytes), {
          injectProbePadding: false,
          forceProbeTag: false,
          isProbePadding: true,
        });
        if (this.stopped || generation !== this.bweGeneration) break;
        totalSent++;
      }
      return totalSent;
    } finally {
      if (this.probePaddingFlightGeneration === generation) {
        this.probePaddingFlightGeneration = undefined;
      }
    }
  }

  private createPaddingRtpPacket(paddingSize: number): RtpPacket {
    return new RtpPacket(
      new RtpHeader({
        sequenceNumber: 0,
        timestamp: this.timestamp ?? 0,
        payloadType: this.codec!.payloadType,
        ssrc: this.ssrc,
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

  private async sendRtpInternal(
    rtp: Buffer | RtpPacket,
    opts: {
      injectProbePadding?: boolean;
      forceProbeTag?: boolean;
      /** @deprecated Prefer unified allocation; kept for explicit overrides. */
      absoluteSequenceNumber?: number;
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
    if (this.dtlsTransport.state !== "connected" || !this.codec) {
      return;
    }

    rtp = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;

    const { header, payload } = rtp;

    // Capture BWE generation at send start. After await sendRtp, only deliver
    // SentInfo when the generation is unchanged — mid-send setBandwidthEstimator
    // must not pollute the new clean estimator with packets planned under the old one.
    const sendGeneration = this.bweGeneration;
    const estimatorAtStart = this._senderBWE;

    const twccOn = this.isTransportCcNegotiated();

    // Stale source: drop before touching probe reservation or pacing budget.
    if (this.isStaleSource(opts.sourceEpoch)) {
      return;
    }

    // pin CurrentCluster: reserve probe id **before** the async send so a
    // concurrent completion cannot re-attribute this packet to the next cluster.
    let reservedClusterId: number | undefined;
    const wantsProbe =
      opts.forceProbeTag === true || estimatorAtStart.shouldTagProbePacket();
    if (twccOn && wantsProbe) {
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

    if (!opts.isRetransmission) {
      header.ssrc = this.ssrc;
      header.payloadType = this.codec.payloadType;
      if (opts.isProbePadding) {
        header.timestamp = this.timestamp ?? header.timestamp;
      } else {
        header.timestamp = uint32Add(inputTimestamp, this.timestampOffset);
      }
    }

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
            case RTP_EXTENSION_URI.sdesRTPStreamID:
              if (this.rtpStreamId) {
                return serializeSdesRTPStreamID(this.rtpStreamId);
              }
              return;
            case RTP_EXTENSION_URI.repairedRtpStreamId:
              if (this.repairedRtpStreamId) {
                return serializeRepairedRtpStreamId(this.repairedRtpStreamId);
              }
              return;
            case RTP_EXTENSION_URI.transportWideCC:
              return serializeTransportWideCC(0);
            case RTP_EXTENSION_URI.absSendTime:
              return serializeAbsSendTime(0n);
          }
        })();

        if (extPayload) return { id: extension.id, payload: extPayload };
      })
      .filter((v) => v) as Extension[];
    const hopByHopIds = new Set(
      this.headerExtensions
        .filter(
          (e) =>
            e.uri === RTP_EXTENSION_URI.transportWideCC ||
            e.uri === RTP_EXTENSION_URI.absSendTime,
        )
        .map((e) => e.id),
    );
    for (const ext of originalHeaderExtensions) {
      if (hopByHopIds.has(ext.id)) continue;
      const exist = header.extensions.find((v) => v.id === ext.id);
      if (exist) {
        exist.payload = ext.payload;
      } else {
        header.extensions.push(ext);
      }
    }
    header.extensions = header.extensions.sort((a, b) => a.id - b.id);

    const useRed =
      !!this.redRedundantPayloadType &&
      !opts.isProbePadding &&
      !opts.isRetransmission;
    const estimatedPayloadLen = useRed
      ? estimateRedPayloadLength(
          this.redEncoder,
          payload,
          header.timestamp,
          this.redRedundantPayloadType!,
        )
      : payload.length;
    const rfcPaddingLen =
      header.padding && header.paddingSize > 0 ? header.paddingSize : 0;
    const constructedBytes =
      header.serializeSize + estimatedPayloadLen + rfcPaddingLen;
    if (
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

    if (this.stopped || sendGeneration !== this.bweGeneration) {
      return;
    }
    // Accepted under a replaced/detached source: never send it, and never let
    // it consume the new source's continuity offset.
    if (this.isStaleSource(opts.sourceEpoch)) {
      return;
    }

    if (!opts.isRetransmission) {
      if (this.rtpContinuityPending && !opts.isProbePadding) {
        if (this.sequenceNumber != undefined && this.timestamp != undefined) {
          const offsets = freezeRtpContinuityOffsets(
            this.sequenceNumber,
            this.timestamp,
            inputSequenceNumber,
            inputTimestamp,
            this.pendingTimestampStep,
          );
          this.seqOffset = offsets.seqOffset;
          this.timestampOffset = offsets.timestampOffset;
          // Padding ahead of this first media is already absorbed by the
          // freeze (offset is derived from this media's own seq).
          this.skippedSourceSeqs = this.skippedSourceSeqs.filter(
            (skipped) => !uint16Gt(inputSequenceNumber & 0xffff, skipped),
          );
        }
        this.rtpContinuityPending = false;
        this.pendingTimestampStep = 1;
      }

      if (opts.isProbePadding) {
        header.timestamp = this.timestamp ?? inputTimestamp;
      } else {
        header.timestamp = uint32Add(inputTimestamp, this.timestampOffset);
      }
      if (opts.absoluteSequenceNumber !== undefined) {
        const abs = opts.absoluteSequenceNumber & 0xffff;
        header.sequenceNumber = abs;
        this.markWireSeqUsed(abs);
      } else if (opts.isProbePadding) {
        header.sequenceNumber = this.allocatePaddingSequence();
      } else {
        header.sequenceNumber = this.allocateMediaSequence(inputSequenceNumber);
      }
      this.timestamp = header.timestamp;
      this.sequenceNumber = header.sequenceNumber;
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

    let packetWideSeq: number | undefined;
    const ntpTimestamp = ntpTime();
    for (const ext of header.extensions) {
      const negotiated = this.headerExtensions.find((e) => e.id === ext.id);
      if (!negotiated) continue;
      if (negotiated.uri === RTP_EXTENSION_URI.transportWideCC && twccOn) {
        const allocated = this.dtlsTransport.allocateTransportWideSequence();
        packetWideSeq = allocated.extended;
        ext.payload = serializeTransportWideCC(allocated.wire);
      }
      if (negotiated.uri === RTP_EXTENSION_URI.absSendTime) {
        ext.payload = serializeAbsSendTime(ntpTimestamp);
      }
    }

    this.ntpTimestamp = ntpTimestamp;
    this.rtpTimestamp = header.timestamp;
    if (opts.isRetransmission) {
      this.retransmittedPacketsSent++;
      this.retransmittedBytesSent += payload.length;
      this.headerBytesSent += header.serializeSize;
    } else {
      this.headerBytesSent += header.serializeSize;
      this.packetCount = uint32Add(this.packetCount, 1);
      if (!opts.isProbePadding && !isPaddingOnlyRtpPacket(rtp)) {
        this.rtpCache[header.sequenceNumber % RTP_HISTORY_SIZE] = rtp;
      }
      this.octetCount += payloadOctetsForSr;
    }

    const sendingAtMs = milliTime();
    const { size, sendingAtMs: enqueueAtMs } = await sendDtlsRtp(
      this.dtlsTransport,
      rtpPayload,
      header,
      sendingAtMs,
    );
    const sentAtMs = milliTime();

    this.runRtcp();
    // BWE / TWCC only when transport-cc is negotiated — otherwise wideSeq would
    // not advance and probe padding would be useless / harmful.
    // Generation match: estimator was not swapped (or reset) while this packet
    // was in flight. Mismatch → discard (do not feed disposed or new clean BWE).
    if (
      twccOn &&
      packetWideSeq !== undefined &&
      sendGeneration === this.bweGeneration
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
    } else if (twccOn && sendGeneration === this.bweGeneration) {
      // Same generation but no wideSeq (should be rare). Do not fold
      // previous-generation bytes into the next estimator.
      this.pendingUntrackedBytes += size;
    }

    if (
      opts.injectProbePadding &&
      twccOn &&
      sendGeneration === this.bweGeneration
    ) {
      this.nestOutgoingPadding = true;
      try {
        await this.maybeInjectProbePadding();
      } finally {
        this.nestOutgoingPadding = false;
      }
    }
  }

  /**
   * pin BitrateProber next_probe_time wait. MinusInfinity / past → send now.
   * Sleeps in ≤100ms slices until `nextSendTimeMs` (same cap as media
   * {@link awaitPacingBudget}), so a 5–15 kbps recovery probe is not
   * released 100ms early.
   */
  private async awaitProbeSendTime(
    nextSendTimeMs: number,
    generation: number,
    sourceEpoch?: number,
  ): Promise<boolean> {
    const alive = () =>
      !this.stopped &&
      generation === this.bweGeneration &&
      !this.isStaleSource(sourceEpoch);
    if (!Number.isFinite(nextSendTimeMs)) return alive();
    while (alive()) {
      const waitMs = nextSendTimeMs - milliTime();
      if (waitMs <= 0) return true;
      try {
        await setTimeout(Math.min(waitMs, 100), undefined, {
          signal: this.sendWaitSignal(sourceEpoch),
        });
      } catch {
        return alive();
      }
    }
    return alive();
  }

  /**
   * Token-bucket wait against {@link pacingBitrateBps} for **media**.
   * Probe packets use {@link awaitProbeSendTime} instead.
   * Returns false if the sender is stopped, the estimator is swapped
   * (`generation` changes), or the packet's source is replaced/detached while
   * waiting (budget is not consumed then).
   */
  private async awaitPacingBudget(
    packetBytes: number,
    generation: number,
    sourceEpoch?: number,
  ): Promise<boolean> {
    const alive = () =>
      !this.stopped &&
      generation === this.bweGeneration &&
      !this.isStaleSource(sourceEpoch);
    const rateBps = this.pacingBitrateBps;
    if (rateBps <= 0) {
      return true;
    }

    const now = milliTime();
    if (this.lastPaceMs === 0) {
      this.lastPaceMs = now;
      this.paceBudgetBytes = 0;
    } else {
      this.refillPaceBudget(rateBps, now);
    }

    // Wait in a loop until the token bucket can cover this packet.
    // Cap accumulation so a single large packet is still eventually sendable.
    const maxBudget = Math.max((rateBps / 8) * 0.1, packetBytes);
    while (this.paceBudgetBytes < packetBytes) {
      if (!alive()) return false;
      const need = packetBytes - this.paceBudgetBytes;
      const waitMs = Math.max(1, Math.ceil((need * 8 * 1000) / rateBps));
      try {
        await setTimeout(Math.min(waitMs, 100), undefined, {
          signal: this.sendWaitSignal(sourceEpoch),
        });
      } catch {
        return false;
      }
      if (!alive()) return false;
      this.refillPaceBudget(rateBps, milliTime(), maxBudget);
    }

    this.paceBudgetBytes -= packetBytes;
    return true;
  }

  private refillPaceBudget(
    rateBps: number,
    nowMs: number,
    maxBudget = (rateBps / 8) * 0.1,
  ) {
    const elapsedSec = Math.max(0, (nowMs - this.lastPaceMs) / 1000);
    this.paceBudgetBytes += elapsedSec * (rateBps / 8);
    if (this.paceBudgetBytes > maxBudget) {
      this.paceBudgetBytes = maxBudget;
    }
    this.lastPaceMs = nowMs;
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
                  // Raw RTT for this RR sample (seconds).
                  const rawRttSeconds =
                    timestampSeconds() -
                    this.lastSentSRTimestamp -
                    report.dlsr / 65536;
                  this.totalRoundTripTime += rawRttSeconds;
                  this.roundTripTimeMeasurements++;
                  // pin OnRoundTripTimeUpdate: only **unsmoothed** RTT goes to
                  // AIMD (smoothed updates are discarded in GoogCc).
                  // Legacy / disabled no-op setRoundTripTime.
                  if (rawRttSeconds > 0) {
                    this._senderBWE.setRoundTripTime(rawRttSeconds * 1000);
                  }
                  // Stats / getStats keep an EWMA separately.
                  if (this.rtt === undefined) {
                    this.rtt = rawRttSeconds;
                  } else {
                    this.rtt =
                      RTT_ALPHA * this.rtt + (1 - RTT_ALPHA) * rawRttSeconds;
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
                    await this.enqueueOutgoing(
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
