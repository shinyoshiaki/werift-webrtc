import { randomBytes, randomUUID } from "crypto";

import type { RTCDataChannel } from "./dataChannel";
import { createWebRtcDomException, createWebRtcTypeError } from "./errors";
import { EventTarget, enumerate } from "./helper";
import {
  type Address,
  Event,
  type InterfaceAddresses,
  type TlsConnectionOptions,
  debug,
} from "./imports/common";
import type { CandidatePair, Message, Protocol } from "./imports/ice";
import {
  type MediaStream,
  type MediaStreamTrack,
  RTCRtpCodecParameters,
  type RTCRtpHeaderExtensionParameters,
  type RTCRtpReceiver,
  type RTCRtpSender,
  type RTCRtpSenderOptions,
  type RTCRtpTransceiver,
  type RouterTableSnapshot,
  RtpRouter,
  TransceiverManager,
  type TransceiverMediaSnapshot,
  type TransceiverOptions,
  useOPUS,
  usePCMU,
  useVP8,
} from "./media";
import {
  type RTCPeerConnectionStats,
  type RTCStats,
  type RTCStatsReport,
  buildStatsReport,
  generateStatsId,
  getStatsTimestamp,
} from "./media/stats";
import { type SctpMediaSnapshot, SctpTransportManager } from "./sctpManager";
import {
  type BundlePolicy,
  type MediaDescription,
  type RTCSessionDescription,
  SessionDescription,
} from "./sdp";
import { type RTCSessionDescriptionInit, SDPManager } from "./sdpManager";
import { SecureTransportManager } from "./secureTransportManager";
import type {
  DtlsKeys,
  DtlsRemoteSnapshot,
  RTCCertificate,
  RTCDtlsTransport,
} from "./transport/dtls";
import type {
  IceGathererState,
  IceRemoteCandidateSnapshot,
  RTCIceCandidate,
  RTCIceCandidateInit,
  RTCIceConnectionState,
  RTCIceTransport,
} from "./transport/ice";
import {
  DEFAULT_MAX_MESSAGE_SIZE,
  type RTCSctpTransport,
} from "./transport/sctp";
import type { ConnectionState, Kind, RTCSignalingState } from "./types/domain";
import type { Callback, CallbackWithValue } from "./types/util";
import { andDirection, deepMerge } from "./utils";

const log = debug("werift:packages/webrtc/src/peerConnection.ts");

/**
 * W3C compatibility notes kept near the public RTCPeerConnection surface so the
 * reviewable diff does not depend on external PR text.
 *
 * - `current/pending*Description`, `canTrickleIceCandidates`, `sctp`,
 *   `addIceCandidate(null)`, and `RTCConfiguration` round-trip behavior are
 *   implemented here and covered by `tests/wpt/peerConnectionApiCompatibility.test.ts`.
 * - `addIceCandidate()` also validates `sdpMid` / `sdpMLineIndex` /
 *   `usernameFragment` against the applied remote description and appends
 *   candidates or end-of-candidates markers to the corresponding m-section.
 *   The public API keeps werift's historical pre-SRD buffering behavior, while
 *   the WPT runner wraps the class to exercise strict spec rejection.
 * - `bundlePolicy: "balanced"` is accepted for input compatibility but is
 *   normalized to werift's `"max-compat"` behavior, so `getConfiguration()`
 *   returns the normalized value.
 * - `setLocalDescription()` keeps the historical `SessionDescription` return
 *   value for non-rollback calls, while `{ type: "rollback" }` resolves `void`
 *   to match the actual behavior without pretending to return a description.
 * - API reference markdown is regenerated with `cd packages/webrtc && npm run doc`.
 *   The generated output lives under `packages/webrtc/doc/`; compatibility
 *   notes remain here and in the package README so review context is visible
 *   even when generated docs are not committed in the same change.
 */
export class RTCPeerConnection extends EventTarget {
  readonly id = randomUUID().toString();
  readonly cname = randomUUID().toString();

  config: Required<PeerConfig> = generateDefaultPeerConfig();
  signalingState: RTCSignalingState = "stable";
  negotiationneeded = false;
  needRestart = false;
  private readonly router = new RtpRouter();
  private readonly sdpManager: SDPManager;
  private readonly transceiverManager: TransceiverManager;
  private readonly sctpManager: SctpTransportManager;
  private readonly secureManager: SecureTransportManager;
  private isClosed = false;
  private shouldNegotiationneeded = false;
  private lastCreatedAnswer?: RTCSessionDescription;
  private lastCreatedOffer?: RTCSessionDescription;
  private readonly pendingRemoteCandidates: Array<
    RTCIceCandidate | RTCIceCandidateInit | null
  > = [];
  /**
   * remote offer/pranswer 適用前の transceiver media snapshot。rollback 時に
   * 復元し、pending だった変更を current session へ漏らさない。
   */
  private pendingTransceiverSnapshot?: TransceiverMediaSnapshot[];
  private pendingRouterSnapshot?: RouterTableSnapshot;
  private pendingSctpSnapshot?: SctpMediaSnapshot;
  private pendingTransportIds?: Set<string>;
  /**
   * commit 待ちの remote ICE/DTLS 更新。ICE-restart 級の変更は current
   * session を壊さないよう適用せず stage し、local answer の commit
   * (setLocalDescription) で反映する。rollback では破棄する。
   */
  private stagedIceParams = new Map<
    RTCIceTransport,
    {
      params: NonNullable<MediaDescription["iceParams"]>;
      renomination: boolean;
      candidates: MediaDescription["iceCandidates"];
      endOfCandidates: boolean;
      localUsername: string;
      localPassword: string;
    }
  >();
  private stagedDtlsParams = new Map<
    RTCDtlsTransport,
    NonNullable<MediaDescription["dtlsParams"]>
  >();
  private pendingDtlsSnapshot = new Map<RTCDtlsTransport, DtlsRemoteSnapshot>();
  private pendingIceCandidateSnapshot = new Map<
    RTCIceTransport,
    IceRemoteCandidateSnapshot
  >();

  readonly iceGatheringStateChange = new Event<[IceGathererState]>();
  readonly iceConnectionStateChange = new Event<[RTCIceConnectionState]>();
  readonly signalingStateChange = new Event<[RTCSignalingState]>();
  readonly connectionStateChange = new Event<[ConnectionState]>();
  readonly onDataChannel = new Event<[RTCDataChannel]>();
  readonly onRemoteTransceiverAdded = new Event<[RTCRtpTransceiver]>();
  readonly onTransceiverAdded = new Event<[RTCRtpTransceiver]>();
  readonly onIceCandidate = new Event<[RTCIceCandidate | undefined]>();
  readonly onNegotiationneeded = new Event<[]>();
  readonly onTrack = new Event<[MediaStreamTrack]>();
  private readonly eventHandlers: PeerConnectionEventHandlers = {};

  get ondatachannel() {
    return this.eventHandlers.ondatachannel ?? null;
  }

  set ondatachannel(value: CallbackWithValue<RTCDataChannelEvent> | null) {
    this.eventHandlers.ondatachannel = value ?? undefined;
  }

  get onicecandidate() {
    return this.eventHandlers.onicecandidate ?? null;
  }

  set onicecandidate(value: CallbackWithValue<RTCPeerConnectionIceEvent> | null) {
    this.eventHandlers.onicecandidate = value ?? undefined;
  }

  get onicecandidateerror() {
    return this.eventHandlers.onicecandidateerror ?? null;
  }

  set onicecandidateerror(value: CallbackWithValue<any> | null) {
    this.eventHandlers.onicecandidateerror = value ?? undefined;
  }

  get onicegatheringstatechange() {
    return this.eventHandlers.onicegatheringstatechange ?? null;
  }

  set onicegatheringstatechange(value: CallbackWithValue<any> | null) {
    this.eventHandlers.onicegatheringstatechange = value ?? undefined;
  }

  get onnegotiationneeded() {
    return this.eventHandlers.onnegotiationneeded ?? null;
  }

  set onnegotiationneeded(value: CallbackWithValue<any> | null) {
    this.eventHandlers.onnegotiationneeded = value ?? undefined;
  }

  get onsignalingstatechange() {
    return this.eventHandlers.onsignalingstatechange ?? null;
  }

  set onsignalingstatechange(value: CallbackWithValue<any> | null) {
    this.eventHandlers.onsignalingstatechange = value ?? undefined;
  }

  get ontrack() {
    return this.eventHandlers.ontrack ?? null;
  }

  set ontrack(value: CallbackWithValue<RTCTrackEvent> | null) {
    this.eventHandlers.ontrack = value ?? undefined;
  }

  get onconnectionstatechange() {
    return this.eventHandlers.onconnectionstatechange ?? null;
  }

  set onconnectionstatechange(value: Callback | null) {
    this.eventHandlers.onconnectionstatechange = value ?? undefined;
  }

  get oniceconnectionstatechange() {
    return this.eventHandlers.oniceconnectionstatechange ?? null;
  }

  set oniceconnectionstatechange(value: Callback | null) {
    this.eventHandlers.oniceconnectionstatechange = value ?? undefined;
  }

  constructor(config: RTCPeerConnectionConfig = {}) {
    super();

    this.setConfiguration(config);

    this.sdpManager = new SDPManager({
      cname: this.cname,
      bundlePolicy: this.config.bundlePolicy,
      mLineReuse: this.config.mLineReuse,
    });
    this.transceiverManager = new TransceiverManager(
      this.cname,
      this.config,
      this.router,
    );
    this.transceiverManager.onTransceiverAdded.pipe(this.onTransceiverAdded);
    this.transceiverManager.onRemoteTransceiverAdded.pipe(
      this.onRemoteTransceiverAdded,
    );
    this.transceiverManager.onTrack.subscribe(
      ({ track, streams, transceiver }) => {
        const event = new RTCTrackEvent({
          track,
          streams,
          transceiver,
          receiver: transceiver.receiver,
        });
        this.onTrack.execute(track);
        this.emit("track", event);
        if (this.ontrack) {
          this.ontrack(event);
        }
      },
    );
    this.transceiverManager.onNegotiationNeeded.subscribe(() =>
      this.needNegotiation(),
    );
    this.sctpManager = new SctpTransportManager();
    this.sctpManager.onDataChannel.subscribe((channel) => {
      this.onDataChannel.execute(channel);
      const event: RTCDataChannelEvent = { type: "datachannel", channel };
      this.ondatachannel?.(event);
      this.emit("datachannel", event);
    });
    this.secureManager = new SecureTransportManager({
      config: this.config,
      sctpManager: this.sctpManager,
      transceiverManager: this.transceiverManager,
    });
    this.secureManager.iceGatheringStateChange.subscribe((state) => {
      this.iceGatheringStateChange.execute(state);
      this.onicegatheringstatechange?.(
        new globalThis.Event("icegatheringstatechange"),
      );
      this.emit("icegatheringstatechange");
    });
    this.secureManager.iceConnectionStateChange.subscribe((state) => {
      if (state === "closed") {
        this.close();
      }
      this.iceConnectionStateChange.execute(state);
      this.oniceconnectionstatechange?.();
      this.emit("iceconnectionstatechange");
    });
    this.secureManager.connectionStateChange.subscribe((state) => {
      this.connectionStateChange.execute(state);
      this.onconnectionstatechange?.();
      this.emit("connectionstatechange");
    });
    this.secureManager.onIceCandidate.subscribe((candidate) => {
      const iceCandidate = candidate ? candidate.toJSON() : undefined;
      this.onIceCandidate.execute(iceCandidate);
      const event: RTCPeerConnectionIceEvent = {
        type: "icecandidate",
        candidate: iceCandidate,
      };
      this.onicecandidate?.(event);
      this.emit("icecandidate", event);
    });
  }

  get connectionState() {
    return this.secureManager.connectionState;
  }
  get iceConnectionState() {
    return this.secureManager.iceConnectionState;
  }
  get iceGathererState() {
    return this.secureManager.iceGatheringState;
  }
  get iceGatheringState() {
    return this.secureManager.iceGatheringState;
  }
  get dtlsTransports() {
    return this.secureManager.dtlsTransports;
  }
  get sctpTransport() {
    return this.sctpManager.sctpTransport;
  }
  get sctp() {
    return this.sctpTransport ?? null;
  }
  get sctpRemotePort() {
    return this.sctpManager.sctpRemotePort;
  }
  get iceTransports() {
    return this.secureManager.iceTransports;
  }
  get extIdUriMap() {
    return this.router.extIdUriMap;
  }
  get iceGeneration() {
    return this.iceTransports[0].connection.generation;
  }
  get localDescription() {
    return this.sdpManager.localDescription ?? null;
  }
  get currentLocalDescription() {
    return this.sdpManager.currentLocalDescription?.toJSON() ?? null;
  }
  get pendingLocalDescription() {
    return this.sdpManager.pendingLocalDescription?.toJSON() ?? null;
  }
  get remoteDescription() {
    return this.sdpManager.remoteDescription ?? null;
  }
  get currentRemoteDescription() {
    return this.sdpManager.currentRemoteDescription?.toJSON() ?? null;
  }
  get pendingRemoteDescription() {
    return this.sdpManager.pendingRemoteDescription?.toJSON() ?? null;
  }
  get canTrickleIceCandidates() {
    const remoteDescription = this.sdpManager._remoteDescription;
    if (!remoteDescription) {
      return null;
    }
    const iceOptions = [
      remoteDescription.iceOptions,
      ...remoteDescription.media.map((media) => media.iceOptions),
    ]
      .filter((value): value is string => !!value)
      .join(" ");
    return iceOptions.split(/\s+/).includes("trickle");
  }
  get remoteIsBundled() {
    return this.sdpManager.remoteIsBundled;
  }
  /**@private */
  get _localDescription() {
    return this.sdpManager._localDescription;
  }
  /**@private */
  get _remoteDescription() {
    return this.sdpManager._remoteDescription;
  }

  getTransceivers() {
    return this.transceiverManager.getTransceivers();
  }

  getSenders(): RTCRtpSender[] {
    return this.transceiverManager.getSenders();
  }

  getReceivers() {
    return this.transceiverManager.getReceivers();
  }

  setConfiguration(config: RTCPeerConnectionConfig) {
    const normalizedConfig = normalizePeerConfiguration(config);
    const isReconfiguration = !!this.sdpManager;

    if (
      normalizedConfig.mLineReuse !== undefined &&
      !["compatible", "aggressive"].includes(normalizedConfig.mLineReuse)
    ) {
      throw new TypeError("mLineReuse must be compatible or aggressive");
    }
    if (
      isReconfiguration &&
      normalizedConfig.mLineReuse !== undefined &&
      normalizedConfig.mLineReuse !== this.config.mLineReuse
    ) {
      throw new Error("mLineReuse cannot be changed");
    }

    if (
      normalizedConfig.rtcpMuxPolicy &&
      normalizedConfig.rtcpMuxPolicy !== "require"
    ) {
      throw new Error("rtcpMuxPolicy must be require");
    }

    if (
      normalizedConfig.iceCandidatePoolSize !== undefined &&
      (!Number.isInteger(normalizedConfig.iceCandidatePoolSize) ||
        normalizedConfig.iceCandidatePoolSize < 0)
    ) {
      throw new Error("iceCandidatePoolSize must be a non-negative integer");
    }

    if (
      isReconfiguration &&
      normalizedConfig.bundlePolicy !== undefined &&
      normalizedConfig.bundlePolicy !== this.config.bundlePolicy
    ) {
      throw new Error("bundlePolicy cannot be changed");
    }

    if (
      isReconfiguration &&
      normalizedConfig.rtcpMuxPolicy !== undefined &&
      normalizedConfig.rtcpMuxPolicy !== this.config.rtcpMuxPolicy
    ) {
      throw new Error("rtcpMuxPolicy cannot be changed");
    }

    if (
      isReconfiguration &&
      normalizedConfig.certificates !== undefined &&
      !hasSameCertificates(
        normalizedConfig.certificates,
        this.config.certificates,
      )
    ) {
      throw new Error("certificates cannot be changed");
    }

    if (
      isReconfiguration &&
      normalizedConfig.iceCandidatePoolSize !== undefined &&
      this.localDescription &&
      normalizedConfig.iceCandidatePoolSize !== this.config.iceCandidatePoolSize
    ) {
      throw new Error(
        "iceCandidatePoolSize cannot be changed after setLocalDescription",
      );
    }

    if ((normalizedConfig.iceCandidatePoolSize ?? 0) > 0) {
      throw new Error("iceCandidatePoolSize > 0 is not supported");
    }

    deepMerge(this.config, normalizedConfig as Partial<PeerConfig>);

    if (this.config.icePortRange) {
      const [min, max] = this.config.icePortRange;
      if (min === max) throw new Error("should not be same value");
      if (min >= max) throw new Error("The min must be less than max");
    }

    if (
      !Number.isInteger(this.config.maxMessageSize) ||
      this.config.maxMessageSize < 0
    ) {
      throw new Error("maxMessageSize must be a non-negative integer");
    }

    if (this.sctpManager?.sctpTransport) {
      this.sctpManager.sctpTransport.maxMessageSize =
        this.config.maxMessageSize;
    }

    assignDynamicPayloadTypes(this.config);

    [
      ...(this.config.headerExtensions.audio || []),
      ...(this.config.headerExtensions.video || []),
    ].forEach((v, i) => {
      v.id = 1 + i;
    });

    // Propagate ICE server changes only to transports still in gathering
    // state "new". JSEP (RFC 8829 §4.1.18): STUN/TURN changes affect the next
    // gathering phase; once gathering has started or finished, nothing is
    // applied to the live Connection (WHIP: createOffer → setConfiguration →
    // setLocalDescription). Per-transport state is used so a gatherer that
    // was reset to "new" (e.g. after ICE restart) is not blocked by a stale
    // manager aggregate of "complete".
    if (
      isReconfiguration &&
      this.secureManager &&
      normalizedConfig.iceServers !== undefined
    ) {
      this.secureManager.updateIceServers();
    }
  }

  getConfiguration() {
    return clonePeerConfiguration(this.config);
  }

  async createOffer({ iceRestart }: { iceRestart?: boolean } = {}) {
    if (iceRestart || this.needRestart) {
      this.needRestart = false;
      this.secureManager.restartIce();
    }

    await this.secureManager.ensureCerts();

    for (const transceiver of this.transceiverManager.getTransceivers()) {
      if (transceiver.codecs.length === 0) {
        this.transceiverManager.assignTransceiverCodecs(transceiver);
      }
      if (transceiver.headerExtensions.length === 0) {
        transceiver.headerExtensions =
          this.config.headerExtensions[transceiver.kind] ?? [];
      }
    }

    const description = this.sdpManager.buildOfferSdp(
      this.transceiverManager.getTransceivers(),
      this.sctpTransport,
    );
    const createdOffer = description.toJSON();
    this.lastCreatedOffer = createdOffer;
    return createdOffer;
  }

  private createSctpTransport() {
    const sctp = this.sctpManager.createSctpTransport(
      this.config.maxMessageSize,
    );
    const dtlsTransport = this.findOrCreateTransport();
    sctp.setDtlsTransport(dtlsTransport);
    return sctp;
  }

  createDataChannel(
    label: string,
    options: Partial<{
      maxPacketLifeTime?: number;
      protocol: string;
      maxRetransmits?: number;
      ordered: boolean;
      negotiated: boolean;
      id?: number;
    }> = {},
  ): RTCDataChannel {
    if (!this.sctpTransport) {
      this.createSctpTransport();
      this.needNegotiation();
    }

    const channel = this.sctpManager.createDataChannel(label, options);
    if (!channel.sctp.dtlsTransport) {
      const dtlsTransport = this.findOrCreateTransport();
      channel.sctp.setDtlsTransport(dtlsTransport);
    }
    return channel;
  }

  removeTrack(sender: RTCRtpSender) {
    if (this.isClosed) {
      throw createWebRtcDomException("InvalidStateError", "peer closed");
    }
    this.transceiverManager.removeTrack(sender);
    this.needNegotiation();
  }

  private needNegotiation = async () => {
    this.invalidateLastCreatedDescriptions();
    this.shouldNegotiationneeded = true;
    if (this.negotiationneeded || this.signalingState !== "stable") {
      return;
    }
    this.shouldNegotiationneeded = false;
    setImmediate(() => {
      this.negotiationneeded = true;
      this.onNegotiationneeded.execute();
      if (this.onnegotiationneeded) {
        this.onnegotiationneeded(new globalThis.Event("negotiationneeded"));
      }
      this.emit("negotiationneeded");
    });
  };

  private invalidateLastCreatedDescriptions() {
    this.lastCreatedAnswer = undefined;
    this.lastCreatedOffer = undefined;
  }

  private async waitForPendingDescriptionTask() {
    this.assertNotClosed();
    await Promise.resolve();

    if (this.isClosed) {
      await new Promise<never>(() => undefined);
    }
  }

  private findOrCreateTransport() {
    // live transport のみ再利用する。停止済み transceiver だけが掴んでいる
    // transport を新規 m-line が拾うと failed な ICE に紐づいて接続できない。
    // 詳しくは SecureTransportManager.liveDtlsTransports を参照。
    const existingDtlsTransport = this.secureManager.liveDtlsTransports.find(
      (transport) => transport.state !== "closed",
    );
    const existing = existingDtlsTransport?.iceTransport;

    // Gather ICE candidates for only one track. If the remote endpoint is not bundle-aware, negotiate only one media track.
    // https://w3c.github.io/webrtc-pc/#rtcbundlepolicy-enum
    if (
      this.sdpManager.bundlePolicy === "max-bundle" ||
      (this.sdpManager.bundlePolicy !== "disable" && this.remoteIsBundled)
    ) {
      if (existingDtlsTransport) {
        return existingDtlsTransport;
      }
    }

    return this.createIndependentTransport();
  }

  /**
   * ICE/DTLS/RTP 配線つきの独立 transport を作る。BUNDLE group 外の m-line が
   * 共有 transport に載ってしまった場合の付け替えにも使う。
   */
  private createIndependentTransport() {
    const dtlsTransport = this.secureManager.createTransport();
    dtlsTransport.onRtp.subscribe((rtp) => {
      this.router.routeRtp(rtp);
    });
    dtlsTransport.onRtcp.subscribe((rtcp) => {
      this.router.routeRtcp(rtcp);
    });
    const iceTransport = dtlsTransport.iceTransport;

    iceTransport.onNegotiationNeeded.subscribe(() => {
      this.needNegotiation();
    });
    iceTransport.onIceCandidate.subscribe((candidate) => {
      if (!this.localDescription) {
        log("localDescription not found when ice candidate was gathered");
        return;
      }
      if (!candidate) {
        this.sdpManager.setLocal(
          this._localDescription!,
          this.transceiverManager.getTransceivers(),
          this.sctpTransport,
        );
        this.onIceCandidate.execute(undefined);
        if (this.onicecandidate) {
          this.onicecandidate({ candidate: undefined });
        }
        this.emit("icecandidate", { candidate: undefined });
        return;
      }

      if (!this._localDescription) {
        log("localDescription not found when ice candidate was gathered");
        return;
      }

      const tagged = this.sdpManager.getNegotiatedBundleTag();
      const owners = this.transceiverManager
        .getTransceivers()
        .filter((t) => t?.dtlsTransport?.iceTransport.id === iceTransport.id);
      // 共有 transport の持ち主は live な transceiver を優先する。停止済みを
      // 拾うと reject 済み MID でラベルしてしまう。
      const owner = owners.find((t) => !t.stopping && !t.stopped) ?? owners[0];
      // candidate 生成元 transport の持ち主が negotiated BUNDLE group 外なら、
      // group tag ではなく自身の MID/index でラベルする。membership は current
      // descriptions の積集合で判定し、pending offer の追加提案は commit まで
      // 採用しない。current remote が無い交渉前は local group 基準に従来どおり。
      const currentLocalItems =
        this.sdpManager.currentLocalDescription?.group.find(
          (group) => group.semantic === "BUNDLE",
        )?.items;
      const currentRemoteItems =
        this.sdpManager.currentRemoteDescription?.group.find(
          (group) => group.semantic === "BUNDLE",
        )?.items;
      const effectiveBundleItems = this.sdpManager.currentRemoteDescription
        ? (currentLocalItems ?? []).filter((mid) =>
            (currentRemoteItems ?? []).includes(mid),
          )
        : (this._localDescription?.group.find(
            (group) => group.semantic === "BUNDLE",
          )?.items ?? []);
      this.secureManager.handleNewIceCandidate({
        candidate,
        bundlePolicy: this.sdpManager.bundlePolicy,
        remoteIsBundled: !!this.sdpManager.remoteIsBundled,
        media: tagged.media,
        sdpMLineIndex: tagged.sdpMLineIndex,
        transceiver: owner,
        transceiverBundled:
          !owner?.mid || (effectiveBundleItems?.includes(owner.mid) ?? false),
        sctpTransport:
          this.sctpTransport?.dtlsTransport.iceTransport.id === iceTransport.id
            ? this.sctpTransport
            : undefined,
      });
    });

    return dtlsTransport;
  }

  async setLocalDescription(sessionDescription: {
    type: "rollback";
  }): Promise<void>;
  async setLocalDescription(
    sessionDescription?: RTCLocalSessionDescriptionInit,
  ): Promise<SessionDescription>;
  async setLocalDescription(
    sessionDescription?: RTCLocalSessionDescriptionInit,
  ): Promise<SessionDescription | void> {
    // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/setLocalDescription#type
    const implicitOfferState: RTCSignalingState[] = [
      "stable",
      "have-local-offer",
      "have-remote-pranswer",
    ];

    await this.waitForPendingDescriptionTask();

    if (sessionDescription?.type === "rollback") {
      this.sdpManager.rollbackLocalDescription(this.signalingState);
      this.setSignalingState("stable");
      if (this.shouldNegotiationneeded) {
        this.needNegotiation();
      }
      this.invalidateLastCreatedDescriptions();
      return;
    }

    const needsGeneratedDescription =
      !sessionDescription?.type ||
      !sessionDescription.sdp ||
      sessionDescription.sdp.length === 0;

    const generatedDescription = needsGeneratedDescription
      ? sessionDescription?.type === "offer"
        ? (this.lastCreatedOffer ?? (await this.createOffer()))
        : sessionDescription?.type === "answer" ||
            sessionDescription?.type === "pranswer"
          ? (this.lastCreatedAnswer ?? (await this.createAnswer()))
          : implicitOfferState.includes(this.signalingState)
            ? (this.lastCreatedOffer ?? (await this.createOffer()))
            : (this.lastCreatedAnswer ?? (await this.createAnswer()))
      : undefined;

    sessionDescription = {
      type: sessionDescription?.type ?? generatedDescription!.type,
      sdp:
        sessionDescription?.sdp && sessionDescription.sdp.length > 0
          ? sessionDescription.sdp
          : generatedDescription!.sdp,
    };

    if (
      sessionDescription.type === "offer" &&
      this.lastCreatedOffer &&
      sessionDescription.sdp !== this.lastCreatedOffer.sdp
    ) {
      throw createWebRtcDomException(
        "InvalidModificationError",
        "setLocalDescription must use the latest created offer",
      );
    }

    // # parse and validate description
    const descriptionType = sessionDescription.type as Exclude<
      RTCSessionDescriptionInit["type"],
      "rollback" | undefined
    >;
    const descriptionSdp = sessionDescription.sdp!;

    const description = this.sdpManager.parseSdp({
      sdp: descriptionSdp,
      isLocal: true,
      signalingState: this.signalingState,
      type: descriptionType,
    });

    // # update signaling state
    if (description.type === "offer") {
      this.setSignalingState("have-local-offer");
    } else if (description.type === "answer") {
      this.setSignalingState("stable");
    } else if (description.type === "pranswer") {
      this.setSignalingState("have-local-pranswer");
    }

    // # assign MID
    for (const [i, media] of enumerate(description.media)) {
      const mid = media.rtp.muxId!;
      this.sdpManager.registerMid(mid);
      if (["audio", "video"].includes(media.kind)) {
        const transceiver =
          this.transceiverManager.getTransceiverByMLineIndex(i);
        if (transceiver) {
          transceiver.mid = mid;
        }
      }
      if (media.kind === "application" && this.sctpTransport) {
        this.sctpTransport.mid = mid;
      }
    }

    // setup ice,dtls role
    const role = description.media.find((media) => media.dtlsParams)?.dtlsParams
      ?.role;

    this.secureManager.setLocalRole({
      type: description.type === "offer" ? "offer" : "answer",
      role,
    });

    // # configure direction
    if (["answer", "pranswer"].includes(description.type)) {
      for (const t of this.transceiverManager.getTransceivers()) {
        if (t.stopped) continue;
        const direction = andDirection(t.direction, t.offerDirection);
        t.setCurrentDirection(direction);
      }
    }

    // for trickle ice
    this.sdpManager.setLocal(
      description,
      this.transceiverManager.getTransceivers(),
      this.sctpTransport,
    );

    if (description.type === "answer") {
      // local answer の commit: stage していた remote 更新を反映する。
      // restart を伴う場合も通常フローと同じ扱いで、新 candidate は trickle
      // で送る。相手は userHistory により旧世代 ufrag の check も受け付ける。
      for (const [iceTransport, staged] of this.stagedIceParams) {
        // answer に載せた staged local generation へ atomically 切り替える。
        // ランダム再生成すると answer と live が不一致になるため、必ず
        // staged 値で restart する。
        iceTransport.restart({
          usernameFragment: staged.localUsername,
          password: staged.localPassword,
        });
        iceTransport.setRemoteParams(staged.params, staged.renomination);
        if (staged.params.iceLite && !iceTransport.connection.iceLite) {
          iceTransport.connection.iceControlling = true;
        }
      }
      for (const [dtlsTransport, params] of this.stagedDtlsParams) {
        dtlsTransport.setRemoteParams(params);
      }
      // credentials と同じ transaction で staged candidates/EOC を反映する。
      for (const [iceTransport, staged] of this.stagedIceParams) {
        for (const candidate of staged.candidates) {
          iceTransport.addRemoteCandidate(candidate);
        }
        if (staged.endOfCandidates) {
          iceTransport.addRemoteCandidate(undefined);
        }
      }
      this.stagedIceParams.clear();
      this.stagedDtlsParams.clear();
      this.pendingDtlsSnapshot.clear();
      this.pendingIceCandidateSnapshot.clear();
      this.sctpManager.commitStagedAssociation();
      await this.finishMediaStops(description);
      // local answer の commit で pending は確定した。rollback 対象は無い。
      this.pendingTransceiverSnapshot = undefined;
      this.pendingRouterSnapshot = undefined;
      this.pendingSctpSnapshot = undefined;
      this.pendingTransportIds = undefined;
    }

    await this.gatherCandidates().catch((e) => {
      log("gatherCandidates failed", e);
    });

    // connect transports
    if (description.type === "answer") {
      this.connect().catch((err) => {
        log("connect failed", err);
        this.secureManager.setConnectionState("failed");
      });
    }

    this.sdpManager.setLocal(
      description,
      this.transceiverManager.getTransceivers(),
      this.sctpTransport,
    );

    if (this.shouldNegotiationneeded) {
      this.needNegotiation();
    }

    this.invalidateLastCreatedDescriptions();
    return description;
  }

  private async gatherCandidates() {
    await this.secureManager.gatherCandidates(
      !!this.sdpManager.remoteIsBundled,
    );
  }

  async addIceCandidate(
    candidateMessage: RTCIceCandidate | RTCIceCandidateInit | null = {},
  ) {
    if (this.isClosed) {
      throw createWebRtcDomException("InvalidStateError", "is closed");
    }

    if (!this.remoteDescription || !this.sdpManager._remoteDescription) {
      this.pendingRemoteCandidates.push(candidateMessage);
      return;
    }
    await this.applyRemoteIceCandidate(candidateMessage);
  }

  private async applyRemoteIceCandidate(
    candidateMessage: RTCIceCandidate | RTCIceCandidateInit | null,
  ) {
    const sdp = this.sdpManager._remoteDescription;
    if (!sdp) {
      return;
    }
    // pending 中の trickle だけ snapshot 対象にする。stable 中は渡さず、
    // 次 offer 時の first-wins を汚さない。
    const appliedCandidate = await this.secureManager.addIceCandidate(
      sdp,
      candidateMessage,
      this.stagedIceParams,
      this.sdpManager.currentRemoteDescription,
      this.sdpManager.pendingRemoteDescription
        ? this.pendingIceCandidateSnapshot
        : undefined,
    );
    const remoteDescription = this.sdpManager._remoteDescription;
    if (!remoteDescription || !appliedCandidate) {
      return;
    }

    if (appliedCandidate.kind === "end-of-candidates") {
      for (const mediaIndex of appliedCandidate.mediaIndices) {
        const media = remoteDescription.media[mediaIndex];
        if (media) {
          media.iceCandidatesComplete = true;
        }
      }
      return;
    }

    for (const mediaIndex of appliedCandidate.mediaIndices) {
      const media = remoteDescription.media[mediaIndex];
      if (!media) {
        continue;
      }
      media.iceCandidates.push(appliedCandidate.candidate);
    }
  }

  private async flushPendingRemoteCandidates() {
    while (
      this.pendingRemoteCandidates.length > 0 &&
      this.remoteDescription &&
      this.sdpManager._remoteDescription
    ) {
      const candidate = this.pendingRemoteCandidates.shift();
      await this.applyRemoteIceCandidate(candidate ?? null);
    }
  }

  private async connect() {
    log("start connect");

    // dead transport (停止済み transceiver だけのもの) を除外する。含めると
    // start 失敗で connectionState が failed になる。
    const res = await Promise.allSettled(
      this.secureManager.liveDtlsTransports.map(async (dtlsTransport) => {
        const { iceTransport } = dtlsTransport;
        if (iceTransport.state === "connected") {
          return;
        }
        const checkDtlsConnected = () => dtlsTransport.state === "connected";

        if (checkDtlsConnected()) {
          return;
        }

        this.secureManager.setConnectionState("connecting");

        await iceTransport.start().catch((err) => {
          log("iceTransport.start failed", err);
          throw err;
        });

        if (checkDtlsConnected()) {
          return;
        }

        await dtlsTransport.start().catch((err) => {
          log("dtlsTransport.start failed", err);
          throw err;
        });

        if (
          this.sctpTransport &&
          this.sctpTransport.dtlsTransport.id === dtlsTransport.id
        ) {
          await this.sctpManager.connectSctp();
        }
      }),
    );

    if (res.find((r) => r.status === "rejected")) {
      this.secureManager.setConnectionState("failed");
    } else {
      this.secureManager.setConnectionState("connected");
    }
  }

  restartIce() {
    this.needRestart = true;
    this.needNegotiation();
  }

  async setRemoteDescription(sessionDescription: RTCSessionDescriptionInit) {
    if (sessionDescription instanceof SessionDescription) {
      sessionDescription = sessionDescription.toSdp();
    }

    await this.waitForPendingDescriptionTask();

    const needsImplicitLocalRollback =
      sessionDescription.type === "offer" &&
      ["have-local-offer", "have-local-pranswer"].includes(this.signalingState);
    if (needsImplicitLocalRollback) {
      this.sdpManager.rollbackLocalDescription(this.signalingState);
      this.shouldNegotiationneeded = true;
      this.setSignalingState("stable");
      await Promise.resolve();
    }

    // # parse and validate description
    // answer/pranswer の codec 検証に失敗したら description の commit を
    // 巻き戻せるよう、適用前の記述を退避しておく。
    const prevPendingRemoteDescription =
      this.sdpManager.pendingRemoteDescription;
    const prevCurrentRemoteDescription =
      this.sdpManager.currentRemoteDescription;
    const prevPendingLocalDescription = this.sdpManager.pendingLocalDescription;
    const prevCurrentLocalDescription = this.sdpManager.currentLocalDescription;
    const remoteSdp = this.sdpManager.setRemoteDescription(
      sessionDescription,
      this.signalingState,
    );
    if (!remoteSdp) {
      // remote rollback: pending offer/pranswer 由来の transceiver 変更を
      // SRD 前の snapshot に戻し、current session との不一致を残さない。
      if (this.pendingTransceiverSnapshot) {
        this.transceiverManager.restoreTransceiverMedia(
          this.pendingTransceiverSnapshot,
        );
        this.pendingTransceiverSnapshot = undefined;
      }
      if (this.pendingRouterSnapshot) {
        this.transceiverManager.restoreRouterTables(this.pendingRouterSnapshot);
        this.pendingRouterSnapshot = undefined;
      }
      if (this.pendingSctpSnapshot) {
        // pending 中に作られた SCTP に付随する fresh DTLS は、SCTP 除去で
        // 持ち主を失い検出不能になるため、除去前に明示的に停止する。
        // 共有 transport (pending 前から存在) は停止しない。
        const createdSctpDtls = !this.pendingSctpSnapshot.existed
          ? this.sctpTransport?.dtlsTransport
          : undefined;
        await this.sctpManager.restoreMediaState(this.pendingSctpSnapshot);
        this.pendingSctpSnapshot = undefined;
        if (
          createdSctpDtls &&
          !this.pendingTransportIds?.has(createdSctpDtls.id)
        ) {
          await createdSctpDtls.stop().catch(() => undefined);
        }
      }
      // DTLS remote state を commit 前に戻す (fingerprint 累積の巻き戻し)。
      for (const [dtlsTransport, snapshot] of this.pendingDtlsSnapshot) {
        dtlsTransport.restoreRemoteState(snapshot);
      }
      this.pendingDtlsSnapshot.clear();
      // 同一世代で適用した candidates/EOC を巻き戻す。
      for (const [iceTransport, snapshot] of this.pendingIceCandidateSnapshot) {
        iceTransport.restoreRemoteCandidates(snapshot);
      }
      this.pendingIceCandidateSnapshot.clear();
      // stage した remote 更新は破棄する (何も適用していないため復元は不要)。
      this.stagedIceParams.clear();
      this.stagedDtlsParams.clear();
      this.sctpManager.clearStagedAssociation();
      // pending 中に作られ、復元後に持ち主のいない transport を停止する。
      await this.stopOrphanedTransports();
      if (
        this.signalingState === "have-remote-pranswer" &&
        this.sdpManager.pendingLocalDescription
      ) {
        // remote pranswer の rollback: pending local offer を残したまま
        // have-local-offer へ戻し、final answer を待てるようにする。
        this.setSignalingState("have-local-offer");
      } else {
        this.setSignalingState("stable");
      }
      if (this.shouldNegotiationneeded) {
        this.needNegotiation();
      }
      this.invalidateLastCreatedDescriptions();
      return;
    }
    if (remoteSdp.type === "answer" || remoteSdp.type === "pranswer") {
      try {
        // commit で pendingLocalDescription は current へ移るため、検証は
        // commit 前の exact pending local offer (退避済み) に対して行う。
        // config フォールバックでは offer で絞った codec を検出できない。
        this.transceiverManager.validateAnswerCodecs(
          remoteSdp,
          prevPendingLocalDescription,
        );
        this.assertSctpPortUnchanged(remoteSdp);
      } catch (error) {
        this.sdpManager.pendingRemoteDescription = prevPendingRemoteDescription;
        this.sdpManager.currentRemoteDescription = prevCurrentRemoteDescription;
        this.sdpManager.pendingLocalDescription = prevPendingLocalDescription;
        this.sdpManager.currentLocalDescription = prevCurrentLocalDescription;
        throw error;
      }
    }
    // BUNDLE は boolean ではなく offered group の membership set と
    // identification-tag として扱う。transport 共有は group member のみに
    // 限定し、group 外の m-section は独立 transport を維持する。
    const offeredBundleGroup = this.sdpManager.remoteIsBundled;
    const bundledMids = new Set(offeredBundleGroup?.items ?? []);
    const bundledTag = offeredBundleGroup?.items[0];

    // SCTP port の変更は association の作り直しが必要で未サポートのため、
    // live association に触れる前に明示的に拒否する。初回・同値は受理する。
    // final answer も含め、全 remote description 型で検証する。
    if (
      remoteSdp.type === "offer" ||
      remoteSdp.type === "pranswer" ||
      remoteSdp.type === "answer"
    ) {
      try {
        this.assertSctpPortUnchanged(remoteSdp);
      } catch (error) {
        this.sdpManager.pendingRemoteDescription = prevPendingRemoteDescription;
        this.sdpManager.currentRemoteDescription = prevCurrentRemoteDescription;
        this.sdpManager.pendingLocalDescription = prevPendingLocalDescription;
        this.sdpManager.currentLocalDescription = prevCurrentLocalDescription;
        throw error;
      }
    }

    // remote offer/pranswer 適用前の media 状態を退避する。terminal stop や
    // pipeline 破棄は commit まで遅延しているため、rollback ではこの snapshot
    // への復元で current session と一致させられる。
    if (remoteSdp.type === "offer" || remoteSdp.type === "pranswer") {
      // 複数 pending offer では current session 直前の snapshot を上書きしない。
      // 最初の snapshot への復元で current と一致させられる。
      if (!this.pendingTransceiverSnapshot) {
        this.pendingTransceiverSnapshot =
          this.transceiverManager.snapshotTransceiverMedia();
        this.pendingRouterSnapshot =
          this.transceiverManager.snapshotRouterTables();
        this.pendingSctpSnapshot = this.sctpManager.snapshotMediaState();
        this.pendingTransportIds = new Set(
          this.secureManager.dtlsTransports.map((transport) => transport.id),
        );
      }
    } else {
      this.pendingTransceiverSnapshot = undefined;
      this.pendingRouterSnapshot = undefined;
      this.pendingSctpSnapshot = undefined;
      this.pendingTransportIds = undefined;
      // remote answer は commit のため stage は不要。answer 経路で fresh に適用する。
      this.stagedIceParams.clear();
      this.stagedDtlsParams.clear();
      this.pendingDtlsSnapshot.clear();
      this.pendingIceCandidateSnapshot.clear();
      this.sctpManager.clearStagedAssociation();
    }

    const matchTransceiverWithMedia = (
      transceiver: RTCRtpTransceiver,
      media: MediaDescription,
    ) =>
      (!transceiver.stopping || transceiver.mid === media.rtp.muxId) &&
      transceiver.kind === media.kind &&
      [null, media.rtp.muxId].includes(transceiver.mid);

    // MIDs that this offer/answer still binds to media sections. A transceiver
    // using one of them must not be recycled for a different m-line.
    const claimedMids = new Set(
      remoteSdp.media
        .map((media) => media.rtp.muxId)
        .filter((mid): mid is string => !!mid),
    );

    // # match/create transceivers and assign transports by BUNDLE membership
    // 割当済み transceiver は予約し、MID 未設定の同種 transceiver が複数
    // m-line に重複割り当てされないようにする。
    const assignedTransceivers = new Set<RTCRtpTransceiver>();
    const mediaTransceivers: (RTCRtpTransceiver | undefined)[] =
      remoteSdp.media.map((remoteMedia, i) => {
        if (!["audio", "video"].includes(remoteMedia.kind)) {
          return undefined;
        }
        const previous = this.transceiverManager.getTransceiverByMLineIndex(i);
        if (
          remoteSdp.type === "offer" &&
          previous?.stopped &&
          previous.mid !== remoteMedia.rtp.muxId &&
          !claimedMids.has(previous.mid!)
        ) {
          previous.mid = null;
          previous.mLineIndex = undefined;
        }
        let transceiver = this.transceiverManager
          .getTransceivers()
          .find(
            (t) =>
              !assignedTransceivers.has(t) &&
              matchTransceiverWithMedia(t, remoteMedia),
          );
        if (!transceiver) {
          // create remote transceiver
          transceiver = this.addRemoteTransceiver(remoteMedia.kind);
          transceiver.mid = remoteMedia.rtp.muxId ?? null;
          this.onRemoteTransceiverAdded.execute(transceiver);
        }
        assignedTransceivers.add(transceiver);
        return transceiver;
      });

    // tagged MID の transport を bundleTransport にする。先頭 m-line ではなく
    // offered tag を基準にし、tag reject 後の付け替えにも追従する。
    // application はここで確保し、membership に応じて独立させる。
    if (
      remoteSdp.media.some((media) => media.kind === "application") &&
      !this.sctpTransport
    ) {
      this.createSctpTransport();
    }
    let bundleTransport: RTCDtlsTransport | undefined;
    if (offeredBundleGroup && bundledTag) {
      bundleTransport =
        mediaTransceivers.find((t) => t?.mid === bundledTag)?.dtlsTransport ??
        (this.sctpTransport?.mid === bundledTag
          ? this.sctpTransport.dtlsTransport
          : undefined);
    }
    remoteSdp.media.forEach((remoteMedia, i) => {
      const mid = remoteMedia.rtp.muxId;
      const inOfferedGroup =
        !!offeredBundleGroup && !!mid && bundledMids.has(mid);
      if (["audio", "video"].includes(remoteMedia.kind)) {
        const transceiver = mediaTransceivers[i]!;
        if (!inOfferedGroup) {
          if (
            offeredBundleGroup &&
            bundleTransport &&
            transceiver.dtlsTransport === bundleTransport &&
            // 接続しない section (停止済み・remote port 0) は共有に残し、
            // garbage transport を増やさない。live の受け入れ section だけ独立させる。
            !transceiver.stopping &&
            !transceiver.stopped &&
            remoteMedia.port !== 0
          ) {
            // group 外は独立 transport を維持する。
            transceiver.setDtlsTransport(this.createIndependentTransport());
          }
        } else {
          if (bundleTransport) {
            if (transceiver.dtlsTransport !== bundleTransport) {
              transceiver.setDtlsTransport(bundleTransport);
            }
          } else {
            bundleTransport = transceiver.dtlsTransport;
          }
        }
      } else if (remoteMedia.kind === "application" && this.sctpTransport) {
        if (!inOfferedGroup) {
          if (
            offeredBundleGroup &&
            bundleTransport &&
            this.sctpTransport.dtlsTransport === bundleTransport
          ) {
            this.sctpTransport.setDtlsTransport(
              this.createIndependentTransport(),
            );
          }
        } else {
          if (bundleTransport) {
            if (this.sctpTransport.dtlsTransport !== bundleTransport) {
              this.sctpTransport.setDtlsTransport(bundleTransport);
            }
          } else {
            bundleTransport = this.sctpTransport.dtlsTransport;
          }
        }
      }
    });

    // protocol-driven な適用 (remote SDP 由来の stop を含む) では
    // negotiationneeded を発火させない。交換自体で確定するため。
    let transports = this.transceiverManager.runWithoutNegotiationNeeded(() =>
      remoteSdp.media.map((remoteMedia, i) => {
        let dtlsTransport: RTCDtlsTransport;

        if (["audio", "video"].includes(remoteMedia.kind)) {
          const transceiver = mediaTransceivers[i]!;

          dtlsTransport = transceiver.dtlsTransport;

          this.transceiverManager.setRemoteRTP(
            transceiver,
            remoteMedia,
            remoteSdp.type,
            i,
          );
        } else if (remoteMedia.kind === "application") {
          let sctpTransport = this.sctpTransport;
          if (!sctpTransport) {
            // phase-1 で確保済みのはずだが、念のためフォールバックする。
            sctpTransport = this.createSctpTransport();
          }
          if (!sctpTransport.mid) {
            sctpTransport.mid = remoteMedia.rtp.muxId;
          }

          dtlsTransport = sctpTransport.dtlsTransport;

          this.sctpManager.setRemoteSCTP(remoteMedia, i, {
            deferAssociation:
              remoteSdp.type === "offer" || remoteSdp.type === "pranswer",
          });
        } else {
          throw new Error("invalid media kind");
        }

        const iceTransport = dtlsTransport.iceTransport;

        // ICE-restart 級の変更 (remote credentials が既存と異なる) は offer/pranswer
        // では commit まで stage し、current session の接続を壊さない。同一世代・
        // 初回は即時適用する (answer は commit のため常に即時)。
        const stageRemoteParams =
          (remoteSdp.type === "offer" || remoteSdp.type === "pranswer") &&
          !!iceTransport.connection.remoteUsername &&
          !!iceTransport.connection.remotePassword &&
          !!remoteMedia.iceParams &&
          (iceTransport.connection.remoteUsername !==
            remoteMedia.iceParams.usernameFragment ||
            iceTransport.connection.remotePassword !==
              remoteMedia.iceParams.password);

        if (remoteMedia.iceParams) {
          const renomination = !!this.sdpManager.inactiveRemoteMedia;
          if (stageRemoteParams) {
            // 新世代の params・candidates・EOC を stage する。同一 offer 内の
            // 複数 m-line は蓄積し、世代が変わる replacement offer では最新の
            // generation 内容へ置き換える。local 側も次の generation を用意し、
            // createAnswer へ載せて commit 時に atomically 切り替える。
            const prev = this.stagedIceParams.get(iceTransport);
            if (
              !prev ||
              prev.params.usernameFragment !==
                remoteMedia.iceParams.usernameFragment ||
              prev.params.password !== remoteMedia.iceParams.password
            ) {
              const local = this.generateStagedLocalCredentials();
              this.stagedIceParams.set(iceTransport, {
                params: remoteMedia.iceParams,
                renomination,
                candidates: [...remoteMedia.iceCandidates],
                endOfCandidates: remoteMedia.iceCandidatesComplete,
                localUsername: local.usernameFragment,
                localPassword: local.password,
              });
            } else {
              prev.params = remoteMedia.iceParams;
              prev.renomination = renomination;
              prev.candidates.push(...remoteMedia.iceCandidates);
              prev.endOfCandidates =
                prev.endOfCandidates || remoteMedia.iceCandidatesComplete;
            }
          } else {
            if (remoteSdp.type === "offer" || remoteSdp.type === "pranswer") {
              this.snapshotIceCandidates(iceTransport);
            }
            iceTransport.setRemoteParams(remoteMedia.iceParams, renomination);

            // One agent full, one lite:  The full agent MUST take the controlling role, and the lite agent MUST take the controlled role
            // RFC 8445 S6.1.1
            if (
              remoteMedia.iceParams.iceLite &&
              !iceTransport.connection.iceLite
            ) {
              iceTransport.connection.iceControlling = true;
            }
          }
        }
        if (remoteMedia.dtlsParams) {
          if (stageRemoteParams) {
            // commit 対象は常に最新の pending 値 (latest-wins)。rollback の
            // 基準は pendingDtlsSnapshot の first-wins と分離する。
            this.stagedDtlsParams.set(dtlsTransport, remoteMedia.dtlsParams);
          } else {
            if (remoteSdp.type === "offer" || remoteSdp.type === "pranswer") {
              this.snapshotDtlsRemote(dtlsTransport);
            }
            dtlsTransport.setRemoteParams(remoteMedia.dtlsParams);
          }
        }

        if (!stageRemoteParams) {
          // # add ICE candidates
          remoteMedia.iceCandidates.forEach(iceTransport.addRemoteCandidate);

          if (remoteMedia.iceCandidatesComplete) {
            iceTransport.addRemoteCandidate(undefined);
          }
        }
        // # set DTLS role
        if (remoteSdp.type === "answer" && remoteMedia.dtlsParams?.role) {
          dtlsTransport.role =
            remoteMedia.dtlsParams.role === "client" ? "server" : "client";
        }
        return iceTransport;
      }),
    ) as RTCIceTransport[];

    // filter out inactive transports
    transports = transports.filter((iceTransport) => !!iceTransport);

    const removedTransceivers = this.transceiverManager
      .getTransceivers()
      .filter(
        (t) =>
          remoteSdp.media.find((m) => matchTransceiverWithMedia(t, m)) ==
          undefined,
      );

    if (sessionDescription.type === "answer") {
      // protocol-driven の確定であり、application の明示的 stop ではない。
      this.transceiverManager.runWithoutNegotiationNeeded(() => {
        for (const transceiver of removedTransceivers) {
          // todo: handle answer side transceiver removal work.
          // event should trigger to notify media source to stop.
          transceiver.stop();
          transceiver.stopped = true;
        }
      });
    }

    if (remoteSdp.type === "offer") {
      this.setSignalingState("have-remote-offer");
    } else if (remoteSdp.type === "answer") {
      await this.finishMediaStops(remoteSdp);
      this.setSignalingState("stable");
    } else if (remoteSdp.type === "pranswer") {
      this.setSignalingState("have-remote-pranswer");
    }

    await this.flushPendingRemoteCandidates();

    // connect transports
    if (remoteSdp.type === "answer") {
      log("caller start connect");
      this.connect().catch((err) => {
        log("connect failed", err);
        this.secureManager.setConnectionState("failed");
      });
    }

    this.negotiationneeded = false;
    if (this.shouldNegotiationneeded) {
      this.needNegotiation();
    }
    this.invalidateLastCreatedDescriptions();
  }

  /**
   * rollback 後に持ち主のいなくなった transport を停止する。所有者導出の
   * getter では検出できないため生成台帳から探す。pending 中に作られたもの
   * だけが対象で、既存の transport には触らない。
   */
  private async stopOrphanedTransports(): Promise<void> {
    const knownIds = this.pendingTransportIds;
    this.pendingTransportIds = undefined;
    if (!knownIds) {
      return;
    }
    const ownedIds = new Set<string>();
    for (const transceiver of this.transceiverManager.getTransceivers()) {
      const id = transceiver.dtlsTransport?.id;
      if (id) {
        ownedIds.add(id);
      }
    }
    const sctpId = this.sctpTransport?.dtlsTransport?.id;
    if (sctpId) {
      ownedIds.add(sctpId);
    }
    const orphaned = this.secureManager.allDtlsTransports.filter(
      (transport) =>
        !knownIds.has(transport.id) &&
        !ownedIds.has(transport.id) &&
        transport.state !== "closed",
    );
    await Promise.allSettled(orphaned.map((transport) => transport.stop()));
    this.secureManager.pruneClosedTransports();
  }

  /**
   * rollback 用に ICE remote candidate state を退避する (first-wins)。
   * 同一世代の candidate/EOC 適用を取り消すためのもの。
   */
  private snapshotIceCandidates(iceTransport: RTCIceTransport): void {
    if (!this.pendingIceCandidateSnapshot.has(iceTransport)) {
      this.pendingIceCandidateSnapshot.set(
        iceTransport,
        iceTransport.snapshotRemoteCandidates(),
      );
    }
  }

  /**
   * SCTP port 変更の事前検証。確立済み association と異なる port は
   * live に触れる前に明示的に拒否する (association replacement 未サポート)。
   * 初回・同値・port 省略は受理する。
   */
  private assertSctpPortUnchanged(remoteSdp: SessionDescription): void {
    const appMedia = remoteSdp.media.find(
      (media) => media.kind === "application",
    );
    const currentPort = this.sctpTransport?.sctp.getRemotePort();
    if (
      appMedia?.sctpPort != null &&
      currentPort != null &&
      appMedia.sctpPort !== currentPort
    ) {
      throw createWebRtcDomException(
        "InvalidModificationError",
        "SCTP port change requires a new association, which is not supported.",
      );
    }
  }

  /**
   * 次の local ICE generation を生成する。名前解決の衝突を避けるため、
   * localPasswordPrefix の扱いは Connection.restart() と揃える。
   */
  private generateStagedLocalCredentials(): {
    usernameFragment: string;
    password: string;
  } {
    const prefix = this.config.icePasswordPrefix ?? "";
    return {
      usernameFragment: randomBytes(2).toString("hex"),
      password: prefix + randomBytes(11).toString("hex").slice(prefix.length),
    };
  }

  /**
   * rollback 用に DTLS remote state を退避する (first-wins)。fingerprint は
   * 累積するため、直接代入で復元できるよう commit 前の値を残す。
   */
  private snapshotDtlsRemote(dtlsTransport: RTCDtlsTransport): void {
    if (!this.pendingDtlsSnapshot.has(dtlsTransport)) {
      this.pendingDtlsSnapshot.set(
        dtlsTransport,
        dtlsTransport.snapshotRemoteState(),
      );
    }
  }

  /**
   * reject 確定した transceiver を terminal stopped にし、他に live の持ち主が
   * いない transport を停止・prune する。共有 transport は残す。
   */
  private async finishMediaStops(
    description: SessionDescription,
  ): Promise<void> {
    const finalized: RTCRtpTransceiver[] = [];
    this.transceiverManager.runWithoutNegotiationNeeded(() => {
      for (const media of description.media) {
        if (media.port !== 0) continue;
        const transceiver = this.getTransceivers().find(
          (t) => t.mid === media.rtp.muxId,
        );
        if (
          transceiver &&
          (transceiver.stopping ||
            transceiver.rejected ||
            this.config.mLineReuse === "aggressive")
        ) {
          transceiver.rejected = true;
          transceiver.forceStop();
          finalized.push(transceiver);
        }
      }
    });
    const liveIds = new Set<string>();
    for (const transceiver of this.transceiverManager.getTransceivers()) {
      if (
        !transceiver.stopping &&
        !transceiver.stopped &&
        transceiver.dtlsTransport
      ) {
        liveIds.add(transceiver.dtlsTransport.id);
      }
    }
    const sctpId = this.sctpTransport?.dtlsTransport?.id;
    if (sctpId) {
      liveIds.add(sctpId);
    }
    const targets = new Map<string, RTCDtlsTransport>();
    for (const transceiver of finalized) {
      const dtls = transceiver.dtlsTransport;
      if (dtls && !liveIds.has(dtls.id)) {
        targets.set(dtls.id, dtls);
      }
    }
    await Promise.allSettled([...targets.values()].map((dtls) => dtls.stop()));
    this.secureManager.pruneClosedTransports();
  }

  addTransceiver(
    trackOrKind: Kind | MediaStreamTrack,
    options: Partial<TransceiverOptions> = {},
  ) {
    const dtlsTransport = this.findOrCreateTransport();
    const transceiver = this.transceiverManager.addTransceiver(
      trackOrKind,
      dtlsTransport,
      options,
    );

    this.secureManager.updateIceConnectionState();
    this.needNegotiation();

    return transceiver;
  }

  private addRemoteTransceiver(kind: Kind) {
    const dtlsTransport = this.findOrCreateTransport();
    const transceiver = this.transceiverManager.addTransceiver(
      kind,
      dtlsTransport,
      { direction: "recvonly" },
    );

    this.secureManager.updateIceConnectionState();
    this.needNegotiation();

    return transceiver;
  }

  // todo fix
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
    if (this.isClosed) {
      throw createWebRtcDomException("InvalidStateError", "is closed");
    }
    const transceiver = this.transceiverManager.addTrack(track, streams);
    if (!transceiver.dtlsTransport) {
      const dtlsTransport = this.findOrCreateTransport();
      transceiver.setDtlsTransport(dtlsTransport);
    }
    this.needNegotiation();
    return transceiver.sender;
  }

  async createAnswer() {
    this.assertNotClosed();

    await this.secureManager.ensureCerts();

    // staged local generation があれば answer に載せる。commit 時に同じ値へ
    // 切り替えるため、answer と live の不一致が起きない。
    const stagedLocalIce = new Map<
      RTCIceTransport,
      { usernameFragment: string; password: string }
    >();
    for (const [iceTransport, staged] of this.stagedIceParams) {
      stagedLocalIce.set(iceTransport, {
        usernameFragment: staged.localUsername,
        password: staged.localPassword,
      });
    }
    const description = this.sdpManager.buildAnswerSdp({
      transceivers: this.transceiverManager.getTransceivers(),
      sctpTransport: this.sctpTransport,
      signalingState: this.signalingState,
      stagedLocalIce,
    });
    const createdAnswer = description.toJSON();
    this.lastCreatedAnswer = createdAnswer;
    return createdAnswer;
  }

  private assertNotClosed() {
    if (this.isClosed) {
      throw createWebRtcDomException(
        "InvalidStateError",
        "RTCPeerConnection is closed",
      );
    }
  }

  private setSignalingState(state: RTCSignalingState) {
    if (this.signalingState === state) {
      return;
    }
    log("signalingStateChange", state);
    this.signalingState = state;
    this.signalingStateChange.execute(state);
    if (this.onsignalingstatechange) {
      this.onsignalingstatechange(new globalThis.Event("signalingstatechange"));
    }
    this.emit("signalingstatechange");
  }

  private createPeerConnectionStats(timestamp: number): RTCPeerConnectionStats {
    return {
      type: "peer-connection",
      id: generateStatsId("peer-connection", this.id),
      timestamp,
      dataChannelsOpened: this.sctpManager.dataChannelsOpened,
      dataChannelsClosed: this.sctpManager.dataChannelsClosed,
    };
  }

  async getStats(selector?: MediaStreamTrack | null): Promise<RTCStatsReport> {
    const timestamp = getStatsTimestamp();
    const stats: RTCStats[] = [];

    if (!selector) {
      stats.push(this.createPeerConnectionStats(timestamp));
    }

    stats.push(...this.transceiverManager.collectStats(timestamp));

    const transportStats = await this.secureManager.getStats(timestamp);
    stats.push(...transportStats);

    if (!selector && this.sctpTransport) {
      const dataChannelStats = await this.sctpManager.getStats(timestamp);
      if (dataChannelStats) {
        stats.push(...dataChannelStats);
      }
    }

    if (!selector) {
      return buildStatsReport(stats);
    }

    return buildStatsReport(
      stats,
      this.transceiverManager.getStatsRootIds(selector),
    );
  }

  async close() {
    if (this.isClosed) return;

    this.isClosed = true;
    this.pendingRemoteCandidates.length = 0;
    this.pendingTransceiverSnapshot = undefined;
    this.pendingRouterSnapshot = undefined;
    this.pendingSctpSnapshot = undefined;
    this.pendingTransportIds = undefined;
    this.stagedIceParams.clear();
    this.stagedDtlsParams.clear();
    this.pendingDtlsSnapshot.clear();
    this.pendingIceCandidateSnapshot.clear();
    this.setSignalingState("closed");

    this.transceiverManager.close();

    // SCTP ABORT は DTLS/ICE が生きている間に送る（close は abrupt であり SHUTDOWN ではない）
    await this.sctpManager.close();
    await this.secureManager.close();

    // 公開 Event を完了させ、購読者・クロージャが PeerConnection を保持し続けないようにする
    this.completePeerEvents();

    log("peerConnection closed");
  }

  private completePeerEvents() {
    const events = [
      this.onDataChannel,
      this.iceGatheringStateChange,
      this.iceConnectionStateChange,
      this.signalingStateChange,
      this.connectionStateChange,
      this.onTransceiverAdded,
      this.onRemoteTransceiverAdded,
      this.onIceCandidate,
      this.onNegotiationneeded,
    ] as const;
    for (const event of events) {
      if (!event.ended) {
        event.complete();
      }
    }
  }
}

export type DebugConfig = Partial<{
  /**% */
  inboundPacketLoss: number;
  /**% */
  outboundPacketLoss: number;
  /**ms */
  receiverReportDelay: number;
  disableSendNack: boolean;
  disableRecvRetransmit: boolean;
}>;

export interface PeerConfig {
  codecs: Partial<{
    /**
     * When specifying a codec with a fixed payloadType such as PCMU,
     * it is necessary to set the correct PayloadType in RTCRtpCodecParameters in advance.
     */
    audio: RTCRtpCodecParameters[];
    video: RTCRtpCodecParameters[];
  }>;
  headerExtensions: Partial<{
    audio: RTCRtpHeaderExtensionParameters[];
    video: RTCRtpHeaderExtensionParameters[];
  }>;
  iceTransportPolicy: "all" | "relay";
  /** Advertise local ICE lite and operate in the controlled role. */
  iceLite: boolean;
  iceServers: RTCIceServer[];
  /**Minimum port and Maximum port must not be the same value */
  icePortRange: [number, number] | undefined;
  iceInterfaceAddresses: InterfaceAddresses | undefined;
  /** Add additional host (local) addresses to use for candidate gathering.
   * Notably, you can include hosts that are normally excluded, such as loopback, tun interfaces, etc.
   */
  iceAdditionalHostAddresses: string[] | undefined;
  iceUseIpv4: boolean;
  iceUseIpv6: boolean;
  iceUseTcp: boolean;
  /** Gather passive (listening) TCP host candidates. Defaults to true. */
  iceTcpPassive: boolean;
  /**
   * Seconds to wait for server-reflexive candidates while gathering.
   * Defaults to 5 when undefined.
   */
  iceStunGatherTimeout: number | undefined;
  /**
   * Seconds to wait for a TURN TCP/TLS connection to be established.
   * Defaults to 8 when undefined.
   */
  iceTurnConnectTimeout: number | undefined;
  turnTransport: "udp" | "tcp" | "tls" | undefined;
  turnTlsOptions: TlsConnectionOptions | undefined;
  /** @deprecated Prefer turn URL transport parameters or turnTransport. */
  forceTurnTCP: boolean;
  /** such as google cloud run */
  iceUseLinkLocalAddress: boolean | undefined;
  /** If provided, is called on each STUN request.
   * Return `true` if a STUN response should be sent, false if it should be skipped. */
  iceFilterStunResponse:
    | ((message: Message, addr: Address, protocol: Protocol) => boolean)
    | undefined;
  iceFilterCandidatePair: ((pair: CandidatePair) => boolean) | undefined;
  dtls: Partial<{
    keys: DtlsKeys;
  }>;
  icePasswordPrefix: string | undefined;
  bundlePolicy: BundlePolicy;
  /** M-line recycling policy. Compatible preserves inactive sections (default).
   * Aggressive rejects inactive sections so their positions can be recycled. */
  mLineReuse: "compatible" | "aggressive";
  rtcpMuxPolicy: "require";
  iceCandidatePoolSize: number;
  certificates: RTCCertificate[];
  debug: DebugConfig;
  midSuffix: boolean;
  /** Advertised local SCTP max-message-size in SDP. Use 0 for unlimited. */
  maxMessageSize: number;
  /**
   * Queue outbound RTP on each sender until DTLS is connected.
   * Disabled by default. Pass `true` or `{ enabled: true, maxLength }` to buffer.
   */
  pendingRtp: NonNullable<RTCRtpSenderOptions["pendingRtp"]>;
}

export const findCodecByMimeType = (
  codecs: RTCRtpCodecParameters[],
  target: RTCRtpCodecParameters,
) =>
  codecs.find(
    (localCodec) =>
      localCodec.mimeType.toLowerCase() === target.mimeType.toLowerCase(),
  )
    ? target
    : undefined;

export function adoptSenderTrackCodec(
  config: PeerConfig,
  track: MediaStreamTrack | undefined | null,
) {
  const codec = track?.codec;
  if (!codec || (track.kind !== "audio" && track.kind !== "video")) {
    return;
  }
  const kind = track.kind;
  const list = [...(config.codecs[kind] ?? [])];
  const mime = codec.mimeType.toLowerCase();
  const index = list.findIndex(
    (candidate) => candidate.mimeType.toLowerCase() === mime,
  );
  if (index === 0) {
    assignDynamicPayloadTypes(config);
    return;
  }
  if (index > 0) {
    const [existing] = list.splice(index, 1);
    list.unshift(existing);
  } else {
    list.unshift(cloneCodecParameters(codec));
  }
  config.codecs[kind] = list;
  assignDynamicPayloadTypes(config);
}

function assignDynamicPayloadTypes(config: PeerConfig) {
  for (const [i, codecParams] of enumerate([
    ...(config.codecs.audio || []),
    ...(config.codecs.video || []),
  ])) {
    if (codecParams.payloadType != undefined) {
      continue;
    }

    codecParams.payloadType = 96 + i;
    switch (codecParams.name.toLowerCase()) {
      case "rtx":
        {
          codecParams.parameters = `apt=${codecParams.payloadType - 1}`;
        }
        break;
      case "red":
        {
          if (codecParams.contentType === "audio") {
            const redundant = codecParams.payloadType + 1;
            codecParams.parameters = `${redundant}/${redundant}`;
            codecParams.payloadType = 63;
          }
        }
        break;
    }
  }
}

function cloneCodecParameters(codec: RTCRtpCodecParameters) {
  return new RTCRtpCodecParameters({
    mimeType: codec.mimeType,
    clockRate: codec.clockRate,
    ...(codec.channels != undefined ? { channels: codec.channels } : {}),
    ...(codec.payloadType != undefined
      ? { payloadType: codec.payloadType }
      : {}),
    rtcpFeedback: [...codec.rtcpFeedback],
    ...(codec.parameters != undefined ? { parameters: codec.parameters } : {}),
    direction: codec.direction,
  });
}

export type RTCIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type RTCBundlePolicy = "balanced" | "max-compat" | "max-bundle";
export type RTCRtcpMuxPolicy = "require";

export interface RTCConfiguration {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: PeerConfig["iceTransportPolicy"];
  bundlePolicy?: RTCBundlePolicy;
  rtcpMuxPolicy?: RTCRtcpMuxPolicy;
  iceCandidatePoolSize?: number;
  certificates?: RTCCertificate[];
}

export interface RTCLocalSessionDescriptionInit
  extends RTCSessionDescriptionInit {
  type?: Exclude<RTCSessionDescriptionInit["type"], "rollback"> | "rollback";
}

type RTCPeerConnectionRTCConfiguration = Omit<
  RTCConfiguration,
  "bundlePolicy"
> & {
  bundlePolicy?: PeerConfig["bundlePolicy"] | RTCBundlePolicy;
};

export type RTCPeerConnectionConfig = Partial<
  Omit<
    PeerConfig,
    "bundlePolicy" | "rtcpMuxPolicy" | "iceCandidatePoolSize" | "certificates"
  >
> &
  RTCPeerConnectionRTCConfiguration;

function generateDefaultPeerConfig(): PeerConfig {
  return {
    codecs: {
      audio: [useOPUS(), usePCMU()],
      video: [useVP8()],
    },
    headerExtensions: {
      audio: [],
      video: [],
    },
    iceTransportPolicy: "all",
    iceLite: false,
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    icePortRange: undefined,
    iceInterfaceAddresses: undefined,
    iceAdditionalHostAddresses: undefined,
    iceUseIpv4: true,
    iceUseIpv6: true,
    iceUseTcp: false,
    iceTcpPassive: true,
    iceStunGatherTimeout: undefined,
    iceTurnConnectTimeout: undefined,
    turnTransport: undefined,
    turnTlsOptions: undefined,
    iceFilterStunResponse: undefined,
    iceFilterCandidatePair: undefined,
    icePasswordPrefix: undefined,
    iceUseLinkLocalAddress: undefined,
    dtls: {},
    bundlePolicy: "max-compat",
    mLineReuse: "compatible",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 0,
    certificates: [],
    debug: {},
    midSuffix: false,
    forceTurnTCP: false,
    maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE,
    pendingRtp: false,
  };
}
export const defaultPeerConfig: PeerConfig = generateDefaultPeerConfig();

function normalizePeerConfiguration(
  config: RTCPeerConnectionConfig,
): Partial<PeerConfig> {
  const input = Object(config ?? {}) as RTCPeerConnectionConfig;
  const normalizedConfig = { ...input } as Partial<PeerConfig>;

  if (input.bundlePolicy === "balanced") {
    normalizedConfig.bundlePolicy = "max-compat";
  }

  if ("certificates" in input) {
    if (input.certificates === undefined) {
      normalizedConfig.certificates = undefined;
    } else if (
      !Array.isArray(input.certificates) ||
      input.certificates.some((certificate) => certificate == null)
    ) {
      throw createWebRtcTypeError(
        "certificates must be an array of RTCCertificate",
      );
    } else {
      normalizedConfig.certificates = [...input.certificates];
    }
  }

  if ("iceCandidatePoolSize" in input) {
    normalizedConfig.iceCandidatePoolSize = coerceUnsignedShort(
      input.iceCandidatePoolSize,
      "iceCandidatePoolSize",
    );
  }

  return normalizedConfig;
}

function coerceUnsignedShort(value: unknown, name: string) {
  const coerced = Number(value);
  if (
    !Number.isFinite(coerced) ||
    !Number.isInteger(coerced) ||
    coerced < 0 ||
    coerced > 65535
  ) {
    throw createWebRtcTypeError(`${name} must be an unsigned short`);
  }
  return coerced;
}

function hasSameCertificates(left: RTCCertificate[], right: RTCCertificate[]) {
  return (
    left.length === right.length &&
    left.every((certificate, index) => certificate === right[index])
  );
}

function clonePeerConfiguration(config: PeerConfig) {
  return {
    ...config,
    codecs: {
      audio: config.codecs.audio ? [...config.codecs.audio] : undefined,
      video: config.codecs.video ? [...config.codecs.video] : undefined,
    },
    headerExtensions: {
      audio: config.headerExtensions.audio
        ? [...config.headerExtensions.audio]
        : undefined,
      video: config.headerExtensions.video
        ? [...config.headerExtensions.video]
        : undefined,
    },
    iceServers: config.iceServers.map((server) => ({
      ...server,
      urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
    })),
    icePortRange: config.icePortRange
      ? ([...config.icePortRange] as [number, number])
      : undefined,
    iceAdditionalHostAddresses: config.iceAdditionalHostAddresses
      ? [...config.iceAdditionalHostAddresses]
      : undefined,
    dtls: { ...config.dtls },
    certificates: [...config.certificates],
    debug: { ...config.debug },
    pendingRtp:
      typeof config.pendingRtp === "object" && config.pendingRtp != undefined
        ? { ...config.pendingRtp }
        : config.pendingRtp,
  };
}

export class RTCTrackEvent {
  readonly type = "track";
  readonly track: MediaStreamTrack;
  readonly streams: MediaStream[];
  readonly transceiver: RTCRtpTransceiver;
  readonly receiver: RTCRtpReceiver;

  constructor(init: {
    track: MediaStreamTrack;
    streams: MediaStream[];
    transceiver: RTCRtpTransceiver;
    receiver: RTCRtpReceiver;
  }) {
    this.track = init.track;
    this.streams = [...init.streams];
    this.transceiver = init.transceiver;
    this.receiver = init.receiver;
  }
}

export interface RTCDataChannelEvent {
  type?: "datachannel";
  channel: RTCDataChannel;
}

export interface RTCPeerConnectionIceEvent {
  type?: "icecandidate";
  candidate?: RTCIceCandidate;
}

type PeerConnectionEventHandlers = {
  ondatachannel?: CallbackWithValue<RTCDataChannelEvent>;
  onicecandidate?: CallbackWithValue<RTCPeerConnectionIceEvent>;
  onicecandidateerror?: CallbackWithValue<any>;
  onicegatheringstatechange?: CallbackWithValue<any>;
  onnegotiationneeded?: CallbackWithValue<any>;
  onsignalingstatechange?: CallbackWithValue<any>;
  ontrack?: CallbackWithValue<RTCTrackEvent>;
  onconnectionstatechange?: Callback;
  oniceconnectionstatechange?: Callback;
};
