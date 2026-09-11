import { randomUUID } from "crypto";

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
import type { DtlsVersion } from "./imports/dtls";
import type { CandidatePair, Message, Protocol } from "./imports/ice";
import {
  type MediaStream,
  type MediaStreamTrack,
  type RTCRtpCodecParameters,
  type RTCRtpHeaderExtensionParameters,
  type RTCRtpReceiver,
  type RTCRtpSender,
  type RTCRtpTransceiver,
  RtpRouter,
  TransceiverManager,
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
import { SctpTransportManager } from "./sctpManager";
import {
  type BundlePolicy,
  type MediaDescription,
  type RTCSessionDescription,
  SessionDescription,
} from "./sdp";
import { type RTCSessionDescriptionInit, SDPManager } from "./sdpManager";
import { SecureTransportManager } from "./secureTransportManager";
import {
  type DtlsKeys,
  type RTCCertificate,
  type RTCDtlsTransport,
  dtlsParametersIndicateNewAssociation,
} from "./transport/dtls";
import type {
  IceGathererState,
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
import { andDirection, deepMerge, reverseDirection } from "./utils";

const log = debug("werift:packages/webrtc/src/peerConnection.ts");

type PeerGraphSnapshot = {
  transceivers: RTCRtpTransceiver[];
  transceiverStates: Map<
    RTCRtpTransceiver,
    ReturnType<RTCRtpTransceiver["captureNegotiationState"]>
  >;
  routerSsrcTable: typeof RtpRouter.prototype.ssrcTable;
  routerRidTable: typeof RtpRouter.prototype.ridTable;
  routerExtIdUriMaps: { [transportId: string]: { [id: number]: string } };
  sctpTransport?: RTCSctpTransport;
  sctpDtlsTransport?: RTCDtlsTransport;
  sctpRemotePort?: number;
  sctpMid?: string;
  sctpMLineIndex?: number;
  sctpRemoteMaxMessageSize?: number;
  currentLocalDescription?: SessionDescription;
  currentRemoteDescription?: SessionDescription;
  pendingLocalDescription?: SessionDescription;
  pendingRemoteDescription?: SessionDescription;
  pendingRemoteCandidates: Array<RTCIceCandidate | RTCIceCandidateInit | null>;
};

type RemoteMediaBinding = {
  remoteMedia: MediaDescription;
  index: number;
  isBundleMember: boolean;
  isBundleTag: boolean;
  transceiver?: RTCRtpTransceiver;
  sctpTransport?: RTCSctpTransport;
  currentTransport: RTCDtlsTransport;
  targetTransport: RTCDtlsTransport;
  rebind?: (transport: RTCDtlsTransport) => void;
  shouldEmitTrack: boolean;
  requiresNewDtlsAssociation?: boolean;
  rejectTransport?: boolean;
  applyRemote: () => void;
};

type PendingSctpParams = {
  remotePort: number;
  remoteMaxMessageSize?: number;
  mLineIndex: number;
  localPort: number;
  replaceAssociation: boolean;
  closeAssociation: boolean;
};

type PendingRemoteOfferPlan = {
  remoteDescription: SessionDescription;
  bindings: RemoteMediaBinding[];
  transportByMid: Map<string, RTCDtlsTransport>;
  replacedTransports: Set<RTCDtlsTransport>;
  createdTransports: Set<RTCDtlsTransport>;
  pendingTransceiverNotifications: RTCRtpTransceiver[];
  snapshot: PeerGraphSnapshot;
  bundleEstablished: boolean;
  committed: boolean;
  pendingSctp?: PendingSctpParams;
  deferReceiveParameters: boolean;
};

type PendingLocalOfferPlan = {
  transportByMid: Map<string, RTCDtlsTransport>;
  proposedBundleMids: Set<string>;
  replacedTransports: Set<RTCDtlsTransport>;
  createdTransports: Set<RTCDtlsTransport>;
  snapshot: PeerGraphSnapshot;
};

/**
 * W3C compatibility notes kept near the public RTCPeerConnection surface so the
 * reviewable diff does not depend on external PR text.
 *
 * - `current/pending*Description`, `canTrickleIceCandidates`, `sctp`,
 *   `addIceCandidate(null)`, and `RTCConfiguration` round-trip behavior are
 *   implemented here and covered by `tests/wpt/peerConnectionApiCompatibility.test.ts`.
 * - `addIceCandidate()` also validates `sdpMid` / `sdpMLineIndex` /
 *   `usernameFragment` against the applied remote description (including a
 *   pending remote offer) and appends candidates or end-of-candidates
 *   markers to the corresponding m-section.  Parsed candidates are staged
 *   until the matching answer commits them onto the live ICE agent.
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
  private dtlsTransportCreated = false;
  private shouldNegotiationneeded = false;
  private lastCreatedAnswer?: RTCSessionDescription;
  private lastCreatedOffer?: RTCSessionDescription;
  /** Incremented on each connect() so a superseded ICE-restart attempt cannot mark failed. */
  private connectEpoch = 0;
  private readonly pendingRemoteCandidates: Array<
    RTCIceCandidate | RTCIceCandidateInit | null
  > = [];
  /**
   * Initial BUNDLE candidates are routed only after the offerer's selected tag
   * is known. Keep the selected provisional tag tied to the exact pending SDP
   * so a later negotiation cannot reuse it for stale candidates.
   */
  private pendingInitialBundleRouting?: {
    remoteDescription: SessionDescription;
    tag: string;
  };
  /** Remote offer transport migration is committed only with its answer. */
  private pendingRemoteOfferPlan?: PendingRemoteOfferPlan;
  /** Local subsequent offers advertise this map before the answer rebinds. */
  private pendingLocalTransportByMid?: ReadonlyMap<string, RTCDtlsTransport>;
  /** Local BUNDLE additions/splits are committed only with the remote answer. */
  private pendingLocalOfferPlan?: PendingLocalOfferPlan;
  /** Local offer's advertised SCTP port, applied only when the answer commits. */
  private pendingLocalAdvertisedSctpPort?: number;

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

    // deepMerge skips undefined source values. Nested dtls must use the same
    // contract so `{ protocolVersions: undefined }` cannot drop DTLS 1.3.
    const nextDtls = { ...this.config.dtls };
    if (normalizedConfig.dtls !== undefined) {
      deepMerge(nextDtls, normalizedConfig.dtls);
      normalizedConfig.dtls = nextDtls;
    }
    if (normalizedConfig.warp !== undefined) {
      normalizedConfig.warp = {
        ...this.config.warp,
        ...normalizedConfig.warp,
      };
    }

    if (this.dtlsTransportCreated) {
      if (
        "sped" in normalizedConfig &&
        normalizedConfig.sped !== this.config.sped
      ) {
        throw new Error(
          "sped cannot be changed after a DTLS transport is created",
        );
      }
      if (
        dtlsProtocolVersionsKey(nextDtls.protocolVersions) !==
        dtlsProtocolVersionsKey(this.config.dtls.protocolVersions)
      ) {
        throw new Error(
          "dtls.protocolVersions cannot be changed after a DTLS transport is created",
        );
      }
      if (
        Boolean(nextDtls.helloRetryRequest) !==
        Boolean(this.config.dtls.helloRetryRequest)
      ) {
        throw new Error(
          "dtls.helloRetryRequest cannot be changed after a DTLS transport is created",
        );
      }
    }

    deepMerge(this.config, normalizedConfig as Partial<PeerConfig>);

    // DTLS transports keep a defensive copy of the WARP policy.  Re-apply a
    // live configuration change so the public PeerConfig and every existing
    // transport agree about early send and media buffering permissions.
    if (
      isReconfiguration &&
      normalizedConfig.warp !== undefined &&
      this.secureManager
    ) {
      for (const dtlsTransport of this.secureManager.dtlsTransports) {
        dtlsTransport.updateWarpConfig(this.config.warp);
      }
    }

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

    for (const [i, codecParams] of enumerate([
      ...(this.config.codecs.audio || []),
      ...(this.config.codecs.video || []),
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

    [
      ...(this.config.headerExtensions.audio || []),
    ].forEach((v, i) => {
      v.id = 1 + i;
    });
    [
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

  private createSctpTransport(dtlsTransport?: RTCDtlsTransport) {
    const sctp = this.sctpManager.createSctpTransport(
      this.config.maxMessageSize,
    );
    sctp.setDtlsTransport(dtlsTransport ?? this.findOrCreateTransport());
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

  private findOrCreateTransport(mid?: string) {
    const existingDtlsTransport = this.dtlsTransports.find(
      (transport) => transport.state !== "closed",
    );

    // `max-bundle` is a local allocation policy. A remote BUNDLE group is not
    // a PeerConnection-wide boolean: group-outside m-sections still need their
    // own transport. Existing remote members are resolved by MID when a caller
    // explicitly supplies one; SRD performs the same mapping for a new offer.
    if (this.sdpManager.bundlePolicy === "max-bundle") {
      if (existingDtlsTransport) {
        this.dtlsTransportCreated = true;
        return existingDtlsTransport;
      }
    }

    if (mid && this.sdpManager.isBundleEstablished()) {
      const group = this.sdpManager.getEstablishedBundleGroup();
      if (group?.items.includes(mid)) {
        const tag = group.items[0];
        const tagTransport = tag ? this.getDtlsTransportForMid(tag) : undefined;
        if (tagTransport && tagTransport.state !== "closed") {
          this.dtlsTransportCreated = true;
          return tagTransport;
        }
      }
    }

    return this.createIndependentTransport();
  }

  private createIndependentTransport() {
    const dtlsTransport = this.secureManager.createTransport();
    this.dtlsTransportCreated = true;
    dtlsTransport.onRtp.subscribe((rtp) => {
      this.router.routeRtp(rtp, dtlsTransport.id);
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
          {
            commit: this._localDescription!.type !== "answer",
            dtlsTransportByMid:
              this.pendingLocalTransportByMid ??
              (this.pendingRemoteOfferPlan &&
              !this.pendingRemoteOfferPlan.committed
                ? this.pendingRemoteOfferPlan.transportByMid
                : undefined),
            replaceDtls: this._localDescription!.type !== "answer",
          },
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

      const candidateTarget = this.resolveLocalCandidateTarget(iceTransport);

      this.secureManager.handleNewIceCandidate({
        candidate,
        bundlePolicy: this.sdpManager.bundlePolicy,
        media: candidateTarget?.media,
        candidateSdpMid: candidateTarget?.media.rtp.muxId ?? undefined,
        candidateSdpMLineIndex: candidateTarget?.index,
        transceiver: this.transceiverManager
          .getTransceivers()
          .find((t) => t?.dtlsTransport?.iceTransport.id === iceTransport.id),
        sctpTransport:
          this.sctpTransport?.dtlsTransport.iceTransport.id === iceTransport.id
            ? this.sctpTransport
            : undefined,
      });
    });

    return dtlsTransport;
  }

  private getDtlsTransportForMid(mid: string) {
    const transceiver = this.transceiverManager
      .getTransceivers()
      .find((candidate) => candidate.mid === mid);
    if (transceiver) return transceiver.dtlsTransport;
    if (this.sctpTransport?.mid === mid) {
      return this.sctpTransport.dtlsTransport;
    }
    return undefined;
  }

  private resolveLocalCandidateTarget(
    iceTransport: RTCIceTransport,
  ): { media: MediaDescription; index: number } | undefined {
    const description = this._localDescription;
    if (!description) return undefined;

    const pendingTransportByMid =
      this.pendingLocalTransportByMid ??
      (this.pendingRemoteOfferPlan && !this.pendingRemoteOfferPlan.committed
        ? this.pendingRemoteOfferPlan.transportByMid
        : undefined);
    const matches = description.media
      .map((media, index) => ({ media, index }))
      .filter(({ media, index }) => {
        const actualTransport = this.getDtlsTransportForMedia(media, index);
        const plannedTransport = pendingTransportByMid?.get(
          media.rtp.muxId ?? "",
        );
        return (
          actualTransport?.iceTransport.id === iceTransport.id ||
          plannedTransport?.iceTransport.id === iceTransport.id
        );
      });
    if (matches.length === 0) return undefined;

    const bundleGroup =
      description.group.find((group) => group.semantic === "BUNDLE") ??
      this.sdpManager.getEstablishedBundleGroup() ??
      (this.sdpManager.bundlePolicy === "max-bundle"
        ? this.sdpManager.getLocalBundleGroup()
        : undefined);
    const bundleTag = bundleGroup?.items[0];
    const bundleMembers = matches.filter(({ media }) =>
      bundleGroup?.items.includes(media.rtp.muxId ?? ""),
    );
    const routeToTag =
      !!bundleTag &&
      bundleMembers.length > 0 &&
      (!!pendingTransportByMid ||
        description.type !== "offer" ||
        this.sdpManager.isBundleEstablished() ||
        this.sdpManager.bundlePolicy === "max-bundle");
    if (routeToTag) {
      return (
        description.media
          .map((media, index) => ({ media, index }))
          .find(({ media }) => media.rtp.muxId === bundleTag) ?? matches[0]
      );
    }
    return matches[0];
  }

  private getDtlsTransportForMedia(media: MediaDescription, index: number) {
    if (media.kind === "application") {
      if (
        this.sctpTransport &&
        (this.sctpTransport.mid === media.rtp.muxId ||
          this.sctpTransport.mLineIndex === index)
      ) {
        return this.sctpTransport.dtlsTransport;
      }
      return undefined;
    }

    const transceiver = this.transceiverManager
      .getTransceivers()
      .find(
        (candidate) =>
          candidate.mid === media.rtp.muxId || candidate.mLineIndex === index,
      );
    return transceiver?.dtlsTransport;
  }

  private capturePeerGraph(): PeerGraphSnapshot {
    const transceivers = this.transceiverManager.getTransceivers().slice();
    return {
      transceivers,
      transceiverStates: new Map(
        transceivers.map((transceiver) => [
          transceiver,
          transceiver.captureNegotiationState(),
        ]),
      ),
      routerSsrcTable: { ...this.router.ssrcTable },
      routerRidTable: { ...this.router.ridTable },
      routerExtIdUriMaps: this.router.snapshotExtIdUriMaps(),
      sctpTransport: this.sctpTransport,
      sctpDtlsTransport: this.sctpTransport?.dtlsTransport,
      sctpRemotePort: this.sctpManager.sctpRemotePort,
      sctpMid: this.sctpTransport?.mid,
      sctpMLineIndex: this.sctpTransport?.mLineIndex,
      sctpRemoteMaxMessageSize: this.sctpTransport?.remoteMaxMessageSize,
      currentLocalDescription: this.sdpManager.currentLocalDescription,
      currentRemoteDescription: this.sdpManager.currentRemoteDescription,
      pendingLocalDescription: this.sdpManager.pendingLocalDescription,
      pendingRemoteDescription: this.sdpManager.pendingRemoteDescription,
      pendingRemoteCandidates: [...this.pendingRemoteCandidates],
    };
  }

  private async restorePeerGraph(snapshot: PeerGraphSnapshot) {
    const currentTransceivers = this.transceiverManager
      .getTransceivers()
      .slice();
    const keptNewTransceivers = currentTransceivers.filter(
      (transceiver) =>
        !snapshot.transceivers.includes(transceiver) &&
        transceiver.reusedByAddTrack,
    );
    currentTransceivers
      .filter(
        (transceiver) =>
          !snapshot.transceivers.includes(transceiver) &&
          !transceiver.reusedByAddTrack,
      )
      .forEach((transceiver) => transceiver.forceStop());

    const currentSctpTransport = this.sctpManager.sctpTransport;
    if (
      currentSctpTransport &&
      currentSctpTransport !== snapshot.sctpTransport
    ) {
      await currentSctpTransport.stop().catch((error) => {
        log("discard pending SCTP transport failed", error);
      });
    }

    this.transceiverManager.restoreTransceivers([
      ...snapshot.transceivers,
      ...keptNewTransceivers,
    ]);
    for (const [transceiver, state] of snapshot.transceiverStates) {
      transceiver.restoreNegotiationState(state);
    }

    this.router.ssrcTable = { ...snapshot.routerSsrcTable };
    this.router.ridTable = { ...snapshot.routerRidTable };
    this.router.restoreExtIdUriMaps(snapshot.routerExtIdUriMaps);
    for (const transceiver of keptNewTransceivers) {
      // RFC 9429 §5.7: keep the addTrack()-reused transceiver, but drop the
      // rolled-back remote offer's MID / m-section association.
      transceiver.mid = null;
      transceiver.mLineIndex = undefined;
      this.router.registerRtpSender(transceiver.sender);
    }

    if (snapshot.sctpTransport) {
      if (
        snapshot.sctpDtlsTransport &&
        snapshot.sctpTransport.dtlsTransport.id !==
          snapshot.sctpDtlsTransport.id
      ) {
        // A committed answer may have rebound the existing SCTP owner before
        // a later local/ICE validation step failed.  Recreate its association
        // on the original DTLS transport so the rejected transaction does not
        // leave the DataChannel owner pointed at the staged carrier.
        snapshot.sctpTransport.setDtlsTransport(snapshot.sctpDtlsTransport);
      }
      snapshot.sctpTransport.mid = snapshot.sctpMid;
      snapshot.sctpTransport.mLineIndex = snapshot.sctpMLineIndex;
      if (snapshot.sctpRemoteMaxMessageSize !== undefined) {
        snapshot.sctpTransport.remoteMaxMessageSize =
          snapshot.sctpRemoteMaxMessageSize;
      }
      if (snapshot.sctpRemotePort !== undefined) {
        snapshot.sctpTransport.setRemotePort(snapshot.sctpRemotePort);
      }
    }
    this.sctpManager.restoreSctpTransport(
      snapshot.sctpTransport,
      snapshot.sctpRemotePort,
    );
    this.sdpManager.currentLocalDescription = snapshot.currentLocalDescription;
    this.sdpManager.currentRemoteDescription =
      snapshot.currentRemoteDescription;
    this.sdpManager.pendingLocalDescription = snapshot.pendingLocalDescription;
    this.sdpManager.pendingRemoteDescription =
      snapshot.pendingRemoteDescription;
    this.pendingRemoteCandidates.splice(
      0,
      this.pendingRemoteCandidates.length,
      ...snapshot.pendingRemoteCandidates,
    );
  }

  private async stopPendingTransports(
    transports: Set<RTCDtlsTransport>,
  ): Promise<void> {
    const activeTransports = new Set(this.dtlsTransports);
    await Promise.allSettled(
      [...transports]
        .filter((transport) => !activeTransports.has(transport))
        .map((transport) => this.secureManager.stopTransport(transport)),
    );
  }

  private async stopReplacedTransports(
    transports: Set<RTCDtlsTransport>,
  ): Promise<void> {
    await this.stopPendingTransports(transports);
  }

  private applyRemoteTransportParameters(
    plan: Pick<PendingRemoteOfferPlan, "bindings" | "bundleEstablished">,
    remoteSdp: SessionDescription,
    bundleTag?: string,
    includeCandidates = true,
  ) {
    for (const binding of plan.bindings) {
      if (binding.requiresNewDtlsAssociation) continue;
      const { remoteMedia, isBundleMember, isBundleTag, targetTransport } =
        binding;
      const shouldApplyTransportParams =
        !isBundleMember || isBundleTag || bundleTag === undefined;
      const shouldApplyIceCandidates =
        shouldApplyTransportParams ||
        (isBundleMember && plan.bundleEstablished);
      if (!shouldApplyTransportParams && !shouldApplyIceCandidates) continue;

      const iceTransport = targetTransport.iceTransport;
      if (shouldApplyTransportParams && remoteMedia.iceParams) {
        const renomination = !!this.sdpManager.inactiveRemoteMedia;
        iceTransport.setRemoteParams(remoteMedia.iceParams, renomination);
        this.applyIceLiteRole(iceTransport, remoteMedia.iceParams.iceLite);
      }
      if (shouldApplyTransportParams && remoteMedia.dtlsParams) {
        targetTransport.setRemoteParams(remoteMedia.dtlsParams);
      }
      if (shouldApplyIceCandidates && includeCandidates) {
        remoteMedia.iceCandidates.forEach(iceTransport.addRemoteCandidate);
        if (remoteMedia.iceCandidatesComplete) {
          iceTransport.addRemoteCandidate(undefined);
        }
      }
      if (
        shouldApplyTransportParams &&
        remoteSdp.type === "answer" &&
        remoteMedia.dtlsParams?.role
      ) {
        targetTransport.role =
          remoteMedia.dtlsParams.role === "client" ? "server" : "client";
      }
    }
  }

  /**
   * RFC 8445 S6.1.1: a full ICE agent that sees a lite peer becomes
   * controlling.  Used both when remote parameters are committed and when an
   * initial remote offer is still pending, so application-visible ICE role
   * matches the offer before the answer commits ufrag/password.
   */
  private applyIceLiteRole(
    iceTransport: RTCIceTransport,
    remoteIsLite: boolean,
  ) {
    if (remoteIsLite) {
      iceTransport.connection.remoteIsLite = true;
      if (!iceTransport.connection.iceLite) {
        iceTransport.connection.iceControlling = true;
      }
    }
  }

  private applyInitialRemoteIceLiteHints(
    plan: Pick<PendingRemoteOfferPlan, "bindings">,
    bundleTag?: string,
  ) {
    for (const binding of plan.bindings) {
      const { remoteMedia, isBundleMember, isBundleTag, targetTransport } =
        binding;
      const shouldApplyTransportParams =
        !isBundleMember || isBundleTag || bundleTag === undefined;
      if (!shouldApplyTransportParams || !remoteMedia.iceParams) continue;
      this.applyIceLiteRole(
        targetTransport.iceTransport,
        remoteMedia.iceParams.iceLite,
      );
    }
  }

  private async commitRemoteTransportPlan(
    plan: Pick<
      PendingRemoteOfferPlan,
      | "bindings"
      | "replacedTransports"
      | "createdTransports"
      | "pendingTransceiverNotifications"
      | "bundleEstablished"
      | "pendingSctp"
      | "deferReceiveParameters"
    >,
    remoteSdp: SessionDescription,
    bundleTag?: string,
  ) {
    // Validate/apply ICE and DTLS properties to the proposed owner before any
    // rebind.  A non-tag BUNDLE section never writes IDENTICAL/TRANSPORT
    // properties into the shared owner.  Once a group is established, trickle
    // candidates for any remaining member still belong to that shared ICE.
    this.applyRemoteTransportParameters(plan, remoteSdp, bundleTag);

    // The graph mutation is deliberately after all media validation and
    // transport parameter writes.  This is the commit point for a pending
    // remote offer and for a remote answer.
    for (const binding of plan.bindings) {
      if (binding.requiresNewDtlsAssociation) continue;
      if (binding.currentTransport !== binding.targetTransport) {
        binding.rebind?.(binding.targetTransport);
      }
    }

    for (const transceiver of plan.pendingTransceiverNotifications) {
      this.transceiverManager.onTransceiverAdded.execute(transceiver);
      this.onRemoteTransceiverAdded.execute(transceiver);
    }

    for (const binding of plan.bindings) {
      if (!binding.transceiver) continue;
      if (binding.requiresNewDtlsAssociation) continue;
      if (remoteSdp.type === "offer") {
        this.transceiverManager.applyLocalSendParameters(binding.transceiver);
        if (plan.deferReceiveParameters) {
          this.transceiverManager.applyRemoteReceiveParameters(
            binding.transceiver,
            binding.remoteMedia,
          );
        }
      }
      if (binding.remoteMedia.ssrc[0]?.ssrc) {
        binding.transceiver.receiver.setupTWCC(
          binding.remoteMedia.ssrc[0].ssrc,
        );
      }
      if (binding.shouldEmitTrack) {
        this.transceiverManager.emitRemoteTrack(
          binding.transceiver,
          binding.remoteMedia,
        );
      }
    }

    const sctpBinding = plan.bindings.find(
      (binding) => binding.sctpTransport !== undefined,
    );
    if (
      sctpBinding?.sctpTransport &&
      !sctpBinding.requiresNewDtlsAssociation &&
      plan.pendingSctp
    ) {
      await this.sctpManager.applyAssociationUpdate(plan.pendingSctp);
    }

    await this.retireRejectedBindings(plan);
  }

  private async retireRejectedBindings(
    plan: Pick<PendingRemoteOfferPlan, "bindings">,
  ) {
    const retiredTransports = new Set<RTCDtlsTransport>();
    for (const binding of plan.bindings) {
      if (!binding.requiresNewDtlsAssociation && !binding.rejectTransport) {
        continue;
      }
      if (binding.transceiver) {
        this.router.unregisterRtpReceiver(binding.transceiver.receiver);
        binding.transceiver.stop();
        binding.transceiver.forceStop();
      }
      if (binding.sctpTransport) {
        await this.sctpManager.applyAssociationUpdate({
          remotePort: 0,
          localPort: binding.sctpTransport.port,
          mLineIndex: binding.index,
          replaceAssociation: false,
          closeAssociation: true,
        });
      }
      retiredTransports.add(binding.currentTransport);
      retiredTransports.add(binding.targetTransport);
    }

    for (const transport of retiredTransports) {
      const stillUsed =
        this.transceiverManager
          .getTransceivers()
          .some(
            (transceiver) =>
              !transceiver.stopped && transceiver.dtlsTransport === transport,
          ) ||
        (this.sctpTransport != undefined &&
          this.sctpManager.sctpRemotePort != undefined &&
          this.sctpTransport.dtlsTransport === transport);
      if (!stillUsed) {
        await this.secureManager.stopTransport(transport);
      }
    }
  }

  private buildPendingSctp(
    remoteMedia: MediaDescription,
    mLineIndex: number,
    advertisedLocalPort?: number,
  ): PendingSctpParams | undefined {
    if (remoteMedia.sctpPort == undefined && remoteMedia.port !== 0) {
      return undefined;
    }

    const currentRemote = this.sctpManager.sctpRemotePort;
    const currentLocal = this.sctpTransport?.port ?? 5000;
    const remotePort = remoteMedia.sctpPort ?? 0;
    if (remoteMedia.port === 0 || remotePort === 0) {
      return {
        remotePort,
        remoteMaxMessageSize: remoteMedia.sctpCapabilities?.maxMessageSize,
        mLineIndex,
        localPort: currentLocal,
        replaceAssociation: false,
        closeAssociation: true,
      };
    }

    const closedBySdp = this.sctpTransport?.associationClosedBySdp === true;
    const localPort =
      advertisedLocalPort != undefined && advertisedLocalPort !== currentLocal
        ? advertisedLocalPort
        : currentRemote != undefined && remotePort !== currentRemote
          ? SctpTransportManager.nextLocalPort(currentLocal)
          : currentLocal;
    const replaceAssociation =
      closedBySdp ||
      (currentRemote != undefined && remotePort !== currentRemote) ||
      localPort !== currentLocal;

    return {
      remotePort,
      remoteMaxMessageSize: remoteMedia.sctpCapabilities?.maxMessageSize,
      mLineIndex,
      localPort,
      replaceAssociation,
      closeAssociation: false,
    };
  }

  private assertAnswerRejectsUnimplementedDtlsReplacement(
    answer: SessionDescription,
    plan: PendingRemoteOfferPlan,
  ) {
    for (const binding of plan.bindings) {
      if (!binding.requiresNewDtlsAssociation) continue;
      const media =
        answer.media.find(
          (section) => section.rtp.muxId === binding.remoteMedia.rtp.muxId,
        ) ?? answer.media[binding.index];
      if (media && media.port !== 0) {
        throw createWebRtcDomException(
          "NotSupportedError",
          "DTLS association replacement is not implemented",
        );
      }
    }
  }

  private async discardPendingRemoteOfferPlan() {
    const plan = this.pendingRemoteOfferPlan;
    this.pendingRemoteOfferPlan = undefined;
    this.pendingInitialBundleRouting = undefined;
    if (!plan) return;

    await this.restorePeerGraph(plan.snapshot);
    await this.stopPendingTransports(plan.createdTransports);
  }

  private async discardPendingLocalOfferPlan() {
    const plan = this.pendingLocalOfferPlan;
    this.pendingLocalOfferPlan = undefined;
    this.pendingLocalTransportByMid = undefined;
    this.pendingLocalAdvertisedSctpPort = undefined;
    if (!plan) return;

    await this.restorePeerGraph(plan.snapshot);
    await this.stopPendingTransports(plan.createdTransports);
  }

  private stageLocalTransportPlan(
    description: SessionDescription,
    snapshot: PeerGraphSnapshot,
  ): PendingLocalOfferPlan | undefined {
    const establishedBundle = this.sdpManager.getEstablishedBundleGroup();
    const bundle = description.group.find(
      (group) => group.semantic === "BUNDLE",
    );
    if (!establishedBundle) return undefined;

    const bundleMids = new Set(bundle?.items ?? []);
    const tagTransport = bundle?.items.length
      ? this.getDtlsTransportForMid(establishedBundle.items[0])
      : undefined;

    const transportByMid = new Map<string, RTCDtlsTransport>();
    const replacedTransports = new Set<RTCDtlsTransport>();
    const createdTransports = new Set<RTCDtlsTransport>();
    for (const [index, media] of description.media.entries()) {
      const mid = media.rtp.muxId;
      if (!mid) continue;

      const currentTransport = this.getDtlsTransportForMedia(media, index);
      if (!currentTransport) continue;

      let targetTransport = currentTransport;
      if (tagTransport && bundleMids.has(mid)) {
        // A newly added m-line joins the already established tag transport.
        targetTransport = tagTransport;
      } else if (media.port !== 0 && establishedBundle.items.includes(mid)) {
        // A subsequent offer may split a former BUNDLE member.  Allocate its
        // independent transport while the offer is pending; the transceiver
        // itself is rebound only when the remote answer commits this plan.
        targetTransport = this.createIndependentTransport();
        createdTransports.add(targetTransport);
      }

      transportByMid.set(mid, targetTransport);
      if (targetTransport !== currentTransport) {
        replacedTransports.add(currentTransport);
      }
    }

    return {
      transportByMid,
      proposedBundleMids: bundleMids,
      replacedTransports,
      createdTransports,
      snapshot,
    };
  }

  /**
   * Recalculate BUNDLE membership/tag from the actual local answer.  Application
   * direction changes after SRD can reject or keep m-sections, so the SRD-time
   * plan is only a candidate graph until this point.
   */
  private finalizeRemoteBundlePlanFromAnswer(
    plan: PendingRemoteOfferPlan,
    answer: SessionDescription,
  ) {
    const answerGroup = answer.group.find(
      (group) => group.semantic === "BUNDLE",
    );
    const acceptedMids = new Set(
      answer.media
        .filter((media) => media.port !== 0 && media.rtp.muxId)
        .map((media) => media.rtp.muxId!),
    );
    const bundleItems = (answerGroup?.items ?? []).filter((mid) =>
      acceptedMids.has(mid),
    );
    const bundleTag = bundleItems[0];
    const tagBinding = plan.bindings.find(
      (binding) => binding.remoteMedia.rtp.muxId === bundleTag,
    );
    const tagTransport =
      tagBinding?.targetTransport ?? tagBinding?.currentTransport;

    for (const binding of plan.bindings) {
      const mid = binding.remoteMedia.rtp.muxId;
      if (binding.requiresNewDtlsAssociation) {
        // RFC 8842: declining a new DTLS association rejects the m-line and
        // keeps the current association/transport ownership.
        binding.targetTransport = binding.currentTransport;
        binding.isBundleMember = false;
        binding.isBundleTag = false;
        if (mid) {
          plan.transportByMid.set(mid, binding.currentTransport);
        }
        continue;
      }
      binding.isBundleMember = !!mid && bundleItems.includes(mid);
      binding.isBundleTag = binding.isBundleMember && mid === bundleTag;

      if (binding.isBundleMember && tagTransport) {
        binding.targetTransport = tagTransport;
      } else if (
        mid &&
        acceptedMids.has(mid) &&
        !binding.isBundleMember &&
        tagTransport &&
        binding.targetTransport.id === tagTransport.id
      ) {
        binding.targetTransport = this.createIndependentTransport();
        plan.createdTransports.add(binding.targetTransport);
      }

      if (mid) {
        plan.transportByMid.set(mid, binding.targetTransport);
      }
    }

    plan.replacedTransports.clear();
    for (const binding of plan.bindings) {
      if (binding.currentTransport !== binding.targetTransport) {
        plan.replacedTransports.add(binding.currentTransport);
      }
    }
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
      const hadPendingRemotePlan = !!this.pendingRemoteOfferPlan;
      const hadPendingLocalPlan = !!this.pendingLocalOfferPlan;
      this.sdpManager.rollbackLocalDescription(this.signalingState);
      if (hadPendingRemotePlan) {
        await this.discardPendingRemoteOfferPlan();
      }
      if (hadPendingLocalPlan) {
        await this.discardPendingLocalOfferPlan();
      } else {
        this.pendingLocalTransportByMid = undefined;
      }
      this.pendingInitialBundleRouting = undefined;
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

    if (description.type === "offer") {
      const application = description.media.find(
        (media) => media.kind === "application",
      );
      this.pendingLocalAdvertisedSctpPort = application?.sctpPort;
    }

    if (description.type === "answer" && this.pendingRemoteOfferPlan) {
      this.assertAnswerRejectsUnimplementedDtlsReplacement(
        description,
        this.pendingRemoteOfferPlan,
      );
    }

    const previousSignalingState = this.signalingState;
    if (description.type === "offer" && this.pendingLocalOfferPlan) {
      await this.discardPendingLocalOfferPlan();
    }
    const localGraphSnapshot =
      description.type === "offer" ? this.capturePeerGraph() : undefined;

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
        const direction = andDirection(t.direction, t.offerDirection);
        t.setCurrentDirection(direction);
      }
    }

    let localTransportByMid: ReadonlyMap<string, RTCDtlsTransport> | undefined;
    if (description.type === "offer") {
      const localPlan = localGraphSnapshot
        ? this.stageLocalTransportPlan(description, localGraphSnapshot)
        : undefined;
      this.pendingLocalOfferPlan = localPlan;
      localTransportByMid = localPlan?.transportByMid;
      this.pendingLocalTransportByMid = localTransportByMid;
      // A split transport can be allocated while staging this offer, after
      // the initial role setup loop above. Re-apply the offer role so the new
      // ICE checklist does not start as a second controlled agent.
      this.secureManager.setLocalRole({
        type: "offer",
        role,
        extraDtlsTransports: localPlan
          ? [...localPlan.createdTransports]
          : undefined,
      });
    } else {
      // Project the pending remote plan's target transports into the answer
      // without rebinding live transceivers yet.  The caller-supplied answer
      // SDP is still parsed above; addTransportDescription only fills ICE/DTLS
      // ownership from the planned graph.
      const pendingRemotePlan =
        this.pendingRemoteOfferPlan && !this.pendingRemoteOfferPlan.committed
          ? this.pendingRemoteOfferPlan
          : undefined;
      if (pendingRemotePlan) {
        this.finalizeRemoteBundlePlanFromAnswer(pendingRemotePlan, description);
        localTransportByMid = pendingRemotePlan.transportByMid;
      }
    }

    const pendingRemotePlanForAnswer =
      description.type === "answer" ? this.pendingRemoteOfferPlan : undefined;
    try {
      // Failure-prone local projection and gathering stay before any live
      // ICE/DTLS/SCTP mutation.  ICE restart gathering happens after the
      // commit point, once remote parameters have been applied.
      this.sdpManager.setLocal(
        description,
        this.transceiverManager.getTransceivers(),
        this.sctpTransport,
        {
          commit: description.type !== "answer",
          dtlsTransportByMid: localTransportByMid,
          replaceDtls: description.type !== "answer",
        },
      );

      await this.gatherCandidates().catch((e) => {
        log("gatherCandidates failed", e);
      });

      this.sdpManager.setLocal(
        description,
        this.transceiverManager.getTransceivers(),
        this.sctpTransport,
        {
          commit: description.type !== "answer",
          dtlsTransportByMid: localTransportByMid,
          replaceDtls: description.type !== "answer",
        },
      );

      if (pendingRemotePlanForAnswer && !pendingRemotePlanForAnswer.committed) {
        await this.commitRemoteTransportPlan(
          pendingRemotePlanForAnswer,
          pendingRemotePlanForAnswer.remoteDescription,
          pendingRemotePlanForAnswer.bindings.find(
            (binding) => binding.isBundleTag,
          )?.remoteMedia.rtp.muxId,
        );
        pendingRemotePlanForAnswer.committed = true;
        this.secureManager.setLocalRole({
          type: "answer",
          role,
          extraDtlsTransports: [
            ...pendingRemotePlanForAnswer.createdTransports,
          ],
        });
        await this.gatherCandidates().catch((e) => {
          log("gatherCandidates failed", e);
        });
        this.sdpManager.setLocal(
          description,
          this.transceiverManager.getTransceivers(),
          this.sctpTransport,
          {
            commit: false,
            dtlsTransportByMid: localTransportByMid,
            replaceDtls: false,
          },
        );
      }

      if (description.type === "answer") {
        await this.flushPendingRemoteCandidates();
        this.sdpManager.commitPendingDescriptions();
        if (pendingRemotePlanForAnswer) {
          await this.stopReplacedTransports(
            pendingRemotePlanForAnswer.replacedTransports,
          );
          await this.stopPendingTransports(
            pendingRemotePlanForAnswer.createdTransports,
          );
        }
        this.pendingRemoteOfferPlan = undefined;
        this.pendingInitialBundleRouting = undefined;
        this.pendingLocalTransportByMid = undefined;
        this.pendingLocalAdvertisedSctpPort = undefined;
      }
    } catch (error) {
      if (description.type === "answer") {
        this.sdpManager.discardPendingRemoteDescription();
        this.sdpManager.discardPendingLocalDescription();
        if (this.pendingRemoteOfferPlan) {
          await this.discardPendingRemoteOfferPlan();
        }
        this.setSignalingState(previousSignalingState);
      }
      throw error;
    }

    if (description.type === "answer") {
      // connect transports only after SDP and transport graph commit.
      this.connect().catch((err) => {
        log("connect failed", err);
        this.secureManager.setConnectionState("failed");
      });
    }

    if (this.shouldNegotiationneeded) {
      this.needNegotiation();
    }

    this.invalidateLastCreatedDescriptions();
    return description;
  }

  private async gatherCandidates() {
    const pendingTransportByMid =
      this.pendingLocalTransportByMid ??
      (this.pendingRemoteOfferPlan && !this.pendingRemoteOfferPlan.committed
        ? this.pendingRemoteOfferPlan.transportByMid
        : undefined);
    if (!pendingTransportByMid) {
      await this.secureManager.gatherCandidates();
      return;
    }

    const description = this.sdpManager._localDescription;
    const transports = description
      ? description.media
          .map(
            (media, index) =>
              pendingTransportByMid.get(media.rtp.muxId ?? "") ??
              this.getDtlsTransportForMedia(media, index),
          )
          .filter(
            (transport): transport is RTCDtlsTransport =>
              transport !== undefined,
          )
      : [...pendingTransportByMid.values()];
    await this.secureManager.gatherCandidates(transports, false);
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
    if (this.pendingRemoteOfferPlan && !this.pendingRemoteOfferPlan.committed) {
      await this.stageRemoteIceCandidate(candidateMessage);
      return;
    }
    await this.applyRemoteIceCandidate(candidateMessage);
  }

  private async stageRemoteIceCandidate(
    candidateMessage: RTCIceCandidate | RTCIceCandidateInit | null,
  ) {
    const sdp = this.sdpManager._remoteDescription;
    if (!sdp) {
      return;
    }
    const appliedCandidate = await this.secureManager.addIceCandidate(
      sdp,
      candidateMessage,
      undefined,
      true,
    );
    this.recordAppliedRemoteIceCandidate(sdp, appliedCandidate);
  }

  private async applyRemoteIceCandidate(
    candidateMessage: RTCIceCandidate | RTCIceCandidateInit | null,
  ) {
    const sdp = this.sdpManager._remoteDescription;
    if (!sdp) {
      return;
    }
    const initialBundleTag =
      this.pendingInitialBundleRouting?.remoteDescription === sdp
        ? this.pendingInitialBundleRouting.tag
        : undefined;
    const appliedCandidate = await this.secureManager.addIceCandidate(
      sdp,
      candidateMessage,
      initialBundleTag,
    );
    this.recordAppliedRemoteIceCandidate(
      this.sdpManager._remoteDescription,
      appliedCandidate,
    );
  }

  private recordAppliedRemoteIceCandidate(
    remoteDescription: SessionDescription | undefined,
    appliedCandidate:
      | Awaited<ReturnType<SecureTransportManager["addIceCandidate"]>>
      | undefined,
  ) {
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
      if (
        this.pendingRemoteOfferPlan &&
        !this.pendingRemoteOfferPlan.committed
      ) {
        await this.stageRemoteIceCandidate(candidate ?? null);
      } else {
        await this.applyRemoteIceCandidate(candidate ?? null);
      }
    }
  }

  private async connect() {
    log("start connect");

    if (this.isClosed) return;

    if (this.config.sped === true && !peerConfigHasDtls13(this.config)) {
      throw new Error(
        "PeerConfig.sped requires DTLS 1.3 in dtls.protocolVersions",
      );
    }
    if (this.config.sped === true && this.config.dtls.helloRetryRequest) {
      throw new Error(
        "PeerConfig.sped cannot be combined with dtls.helloRetryRequest",
      );
    }
    if (
      this.config.warp.allowEarlyServerData === true &&
      (this.config.sped !== true || !peerConfigHasDtls13(this.config))
    ) {
      throw new Error(
        "warp.allowEarlyServerData requires PeerConfig.sped and DTLS 1.3",
      );
    }

    // The transport set for this connect attempt must remain stable.  A
    // connection-state callback may add a transceiver while the attempt is
    // settling; its new, unnegotiated transport belongs to a later offer.
    const connectTransports = this.dtlsTransports.filter(
      (dtlsTransport) =>
        dtlsTransport.state !== "closed" && dtlsTransport.state !== "failed",
    );
    const epoch = ++this.connectEpoch;
    const res = await Promise.allSettled(
      connectTransports.map(async (dtlsTransport) => {
        const { iceTransport } = dtlsTransport;
        const ownsSctp =
          this.sctpTransport?.dtlsTransport.id === dtlsTransport.id;
        // Gathering sets Connection.state to "completed" before any remote
        // checks. Only "connected" means ICE has a nominated pair.
        // ICE restart leaves DTLS connected while ICE returns to "new"/gather
        // "completed"; skip ICE start only when ICE is already connected.
        if (
          iceTransport.state === "connected" &&
          dtlsTransport.state === "connected"
        ) {
          if (ownsSctp) {
            await this.sctpManager.connectSctp();
          }
          return;
        }

        this.secureManager.setConnectionState("connecting");

        if (this.config.sped === true) {
          if (dtlsTransport.state === "connected") {
            if (iceTransport.state !== "connected") {
              await iceTransport.start();
            }
            if (ownsSctp) {
              await this.sctpManager.connectSctp();
            }
            return;
          }
          const dtlsPromise = dtlsTransport.start();
          // The DTLS client is the passive SCTP endpoint.  Arm it before
          // authentication so an early server INIT cannot establish SCTP
          // before RTCSctpTransport has assigned its stream-id parity.
          const earlyWritePromise =
            this.config.warp.allowEarlyServerData &&
            dtlsTransport.role === "server"
              ? dtlsTransport.waitForWriteReady()
              : Promise.resolve();
          const earlySctpPromise = (
            ownsSctp && dtlsTransport.role === "client"
              ? this.sctpManager.connectSctp()
              : ownsSctp && this.config.warp.allowEarlyServerData
                ? earlyWritePromise.then(() =>
                    dtlsTransport.isEarlyServerWriteAllowed()
                      ? this.sctpManager.connectSctp()
                      : undefined,
                  )
                : Promise.resolve()
          ).catch((error) => {
            // Early SCTP is an optimization. Policy revocation, generation
            // changes, or a temporarily unavailable candidate path may close
            // this fresh association; SctpTransportManager clears its cached
            // promise so the authenticated path below can create and retry a
            // new association.
            log(
              "early SCTP start cancelled; retry after authentication",
              error,
            );
          });
          const icePromise =
            iceTransport.state === "connected"
              ? Promise.resolve()
              : iceTransport.start();
          await Promise.all([icePromise, dtlsPromise]).catch((err) => {
            log("sped ice/dtls start failed", err);
            throw err;
          });
          await earlySctpPromise;
        } else {
          if (iceTransport.state !== "connected") {
            await iceTransport.start().catch((err) => {
              log("iceTransport.start failed", err);
              throw err;
            });
          }

          if (dtlsTransport.state === "connected") {
            if (ownsSctp) {
              await this.sctpManager.connectSctp();
            }
            return;
          }

          await dtlsTransport.start().catch((err) => {
            log("dtlsTransport.start failed", err);
            throw err;
          });
        }

        if (
          this.sctpTransport &&
          this.sctpTransport.dtlsTransport.id === dtlsTransport.id
        ) {
          await this.sctpManager.connectSctp();
        }
      }),
    );

    if (this.isClosed || epoch !== this.connectEpoch) {
      return;
    }

    const transportStates = connectTransports.map(
      (dtlsTransport) => dtlsTransport.state,
    );
    const transportFailed = transportStates.some((state) => state === "failed");
    const transportNotConnected = transportStates.some(
      (state) => state !== "connected" && state !== "closed",
    );

    // A transport can fail asynchronously while an older connect() is still
    // settling (for example, a re-negotiation can reject a new fingerprint).
    // Promise fulfillment alone is not enough to publish PeerConnection
    // success; the current transport state remains the authentication boundary.
    if (
      res.find((r) => r.status === "rejected") ||
      transportFailed ||
      transportNotConnected
    ) {
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

    if (sessionDescription.type === "rollback") {
      this.sdpManager.setRemoteDescription(
        sessionDescription,
        this.signalingState,
      );
      await this.discardPendingRemoteOfferPlan();
      this.pendingInitialBundleRouting = undefined;
      this.setSignalingState("stable");
      if (this.shouldNegotiationneeded) {
        this.needNegotiation();
      }
      this.invalidateLastCreatedDescriptions();
      return;
    }

    const needsImplicitLocalRollback =
      sessionDescription.type === "offer" &&
      ["have-local-offer", "have-local-pranswer"].includes(this.signalingState);
    if (needsImplicitLocalRollback) {
      await this.discardPendingLocalOfferPlan();
      this.sdpManager.rollbackLocalDescription(this.signalingState);
      this.shouldNegotiationneeded = true;
      this.setSignalingState("stable");
      await Promise.resolve();
    }

    // A new offer replaces a previous pending offer only after its staged
    // graph has been discarded.  The current negotiated graph is untouched.
    if (sessionDescription.type === "offer" && this.pendingRemoteOfferPlan) {
      await this.discardPendingRemoteOfferPlan();
    }

    const previousSignalingState = this.signalingState;
    const wasBundleEstablished = this.sdpManager.isBundleEstablished();
    const establishedBundle = this.sdpManager.getEstablishedBundleGroup();
    const hasCurrentNegotiatedSession = !!(
      this.sdpManager.currentLocalDescription ||
      this.sdpManager.currentRemoteDescription
    );
    const graphSnapshot = this.capturePeerGraph();
    const createdTransports = new Set<RTCDtlsTransport>();
    let remoteSdp: SessionDescription | undefined;

    try {
      // # parse and stage description
      remoteSdp = this.sdpManager.setRemoteDescription(
        sessionDescription,
        this.signalingState,
      );
      if (!remoteSdp) {
        return;
      }

      const bundleGroup = this.sdpManager.getRemoteBundleGroup();
      const remoteMediaBindings: RemoteMediaBinding[] = [];

      const matchTransceiverWithMedia = (
        transceiver: RTCRtpTransceiver,
        media: MediaDescription,
      ) =>
        transceiver.kind === media.kind &&
        [null, media.rtp.muxId].includes(transceiver.mid);

      // First pass: create the proposed m-line graph without rebinding an
      // already negotiated transceiver.  Group-outside m-lines get an
      // independent transport even when another section is bundled.
      remoteSdp.media.forEach((remoteMedia, i) => {
        const offeredBundleMember =
          bundleGroup?.items.includes(remoteMedia.rtp.muxId ?? "") ?? false;

        if (["audio", "video"].includes(remoteMedia.kind)) {
          let transceiver = this.transceiverManager
            .getTransceivers()
            .find((t) => matchTransceiverWithMedia(t, remoteMedia));
          if (!transceiver) {
            const dtlsTransport =
              bundleGroup && !offeredBundleMember
                ? this.createIndependentTransport()
                : this.findOrCreateTransport(remoteMedia.rtp.muxId);
            transceiver = this.transceiverManager.addTransceiver(
              remoteMedia.kind,
              dtlsTransport,
              { direction: "recvonly" },
              { reuseInactiveMLine: false },
            );
            transceiver.mid = remoteMedia.rtp.muxId ?? null;
            transceiver.createdByRemoteDescription = true;
            this.secureManager.updateIceConnectionState();
            this.needNegotiation();
            this.onRemoteTransceiverAdded.execute(transceiver);
          } else if (
            transceiver.direction === "inactive" &&
            transceiver.stopping
          ) {
            transceiver.stopped = true;

            if (remoteSdp!.type === "answer") {
              transceiver.setCurrentDirection("inactive");
            }
            return;
          }
          if (!transceiver.mid) {
            transceiver.mid = remoteMedia.rtp.muxId ?? null;
          }
          transceiver.mLineIndex = i;
          if (remoteSdp!.type === "offer") {
            transceiver.offerDirection = reverseDirection(
              remoteMedia.direction ?? "inactive",
            );
          }

          const mappedTransceiver = transceiver;
          remoteMediaBindings.push({
            remoteMedia,
            index: i,
            isBundleMember: offeredBundleMember,
            isBundleTag: false,
            transceiver: mappedTransceiver,
            currentTransport: mappedTransceiver.dtlsTransport,
            targetTransport: mappedTransceiver.dtlsTransport,
            rebind: (transport) =>
              mappedTransceiver.setDtlsTransport(transport),
            shouldEmitTrack: false,
            rejectTransport: remoteMedia.port === 0,
            applyRemote: () =>
              this.transceiverManager.setRemoteRTP(
                mappedTransceiver,
                remoteMedia,
                remoteSdp!.type,
                i,
                {
                  emitTrack: mappedTransceiver.receiver.tracks.length === 0,
                  setupTWCC: !hasCurrentNegotiatedSession,
                  applyReceive:
                    remoteSdp!.type !== "offer" || !hasCurrentNegotiatedSession,
                },
              ),
          });
        } else if (remoteMedia.kind === "application") {
          let sctpTransport = this.sctpTransport;
          if (!sctpTransport) {
            const dtlsTransport =
              bundleGroup && !offeredBundleMember
                ? this.createIndependentTransport()
                : undefined;
            sctpTransport = this.createSctpTransport(dtlsTransport);
          }
          if (!sctpTransport.mid) {
            sctpTransport.mid = remoteMedia.rtp.muxId;
          }
          if (sctpTransport.mLineIndex === undefined) {
            sctpTransport.mLineIndex = i;
          }

          const mappedSctpTransport = sctpTransport;
          remoteMediaBindings.push({
            remoteMedia,
            index: i,
            isBundleMember: offeredBundleMember,
            isBundleTag: false,
            sctpTransport: mappedSctpTransport,
            currentTransport: mappedSctpTransport.dtlsTransport,
            targetTransport: mappedSctpTransport.dtlsTransport,
            rebind: (transport) =>
              mappedSctpTransport.setDtlsTransport(transport),
            shouldEmitTrack: false,
            rejectTransport: remoteMedia.port === 0,
            applyRemote: () => {
              if (remoteMedia.port !== 0) {
                this.sctpManager.validateRemoteSctp(remoteMedia);
              }
            },
          });
        } else {
          throw new Error("invalid media kind");
        }
      });

      const eligibleBundleMids = new Set(
        remoteMediaBindings
          .filter(({ remoteMedia, transceiver }) => {
            if (!remoteMedia.rtp.muxId || remoteMedia.port === 0) return false;
            if (transceiver?.stopping || transceiver?.stopped) return false;
            return true;
          })
          .map(({ remoteMedia }) => remoteMedia.rtp.muxId!)
          .filter((mid) => bundleGroup?.items.includes(mid)),
      );
      const bundleInfo =
        this.sdpManager.getRemoteBundleInfo(eligibleBundleMids);
      const bundleTag = bundleInfo?.tag;
      const acceptedBundleMids = new Set(bundleInfo?.items ?? []);
      const pendingLocalPlan =
        remoteSdp.type === "answer" ? this.pendingLocalOfferPlan : undefined;
      const bundleTransport = bundleTag
        ? (pendingLocalPlan?.transportByMid.get(bundleTag) ??
          remoteMediaBindings.find(
            (binding) => binding.remoteMedia.rtp.muxId === bundleTag,
          )?.currentTransport)
        : undefined;
      const previousBundleMids = new Set(establishedBundle?.items ?? []);

      for (const binding of remoteMediaBindings) {
        const mid = binding.remoteMedia.rtp.muxId;
        binding.isBundleMember = !!mid && acceptedBundleMids.has(mid);
        binding.isBundleTag = binding.isBundleMember && mid === bundleTag;
        const localTarget = mid
          ? pendingLocalPlan?.transportByMid.get(mid)
          : undefined;
        const localOfferProposedBundle =
          !!mid && pendingLocalPlan?.proposedBundleMids.has(mid);

        if (binding.isBundleMember && bundleTransport) {
          binding.targetTransport = bundleTransport;
        } else if (localTarget && !localOfferProposedBundle) {
          // A local subsequent offer may already have staged the transport
          // needed for a BUNDLE addition or split.  Reuse that exact target
          // when the remote answer accepts the proposed graph.
          binding.targetTransport = localTarget;
        } else if (
          mid &&
          binding.remoteMedia.port !== 0 &&
          !binding.isBundleMember &&
          (bundleGroup === undefined || bundleTag !== undefined) &&
          (previousBundleMids.has(mid) ||
            (bundleGroup !== undefined &&
              !wasBundleEstablished &&
              binding.currentTransport === bundleTransport))
        ) {
          // A former shared m-section, or a preallocated m-section that was
          // accidentally placed on the initial tag transport, must receive a
          // fresh transport before its own ICE/DTLS properties are applied.
          binding.targetTransport = this.createIndependentTransport();
          createdTransports.add(binding.targetTransport);
        }
      }

      // RFC 8842: compare last-stable remote SDP with the pending description.
      // Runtime DTLS state is not the source of truth; a connecting
      // association can still be asked to yield to a new fingerprint/tls-id.
      // Offers decline unimplemented replacement by rejecting the m-line.
      // Answers that request a new association are rejected before live
      // transport role/fingerprint mutation.
      const currentRemote = this.sdpManager.currentRemoteDescription;
      const transportsNeedingNewAssociation = new Set<RTCDtlsTransport>();
      for (const binding of remoteMediaBindings) {
        const shouldApplyTransportParams =
          !binding.isBundleMember ||
          binding.isBundleTag ||
          bundleTag === undefined;
        if (
          !shouldApplyTransportParams ||
          !binding.remoteMedia.dtlsParams ||
          binding.remoteMedia.port === 0
        ) {
          continue;
        }
        const currentMedia =
          currentRemote?.media.find(
            (media) =>
              !!media.rtp.muxId &&
              media.rtp.muxId === binding.remoteMedia.rtp.muxId,
          ) ?? currentRemote?.media[binding.index];
        if (
          dtlsParametersIndicateNewAssociation(
            currentMedia?.dtlsParams,
            binding.remoteMedia.dtlsParams,
          )
        ) {
          if (remoteSdp.type === "answer") {
            throw createWebRtcDomException(
              "NotSupportedError",
              "DTLS association replacement is not implemented",
            );
          }
          transportsNeedingNewAssociation.add(binding.targetTransport);
        }
      }
      if (remoteSdp.type === "offer") {
        for (const binding of remoteMediaBindings) {
          if (transportsNeedingNewAssociation.has(binding.targetTransport)) {
            binding.requiresNewDtlsAssociation = true;
          }
        }
      }

      const previousTransports = new Set<RTCDtlsTransport>(
        graphSnapshot.transceivers
          .map((transceiver) => transceiver.dtlsTransport)
          .concat(
            graphSnapshot.sctpTransport
              ? [graphSnapshot.sctpTransport.dtlsTransport]
              : [],
          ),
      );
      this.dtlsTransports.forEach((transport) => {
        if (!previousTransports.has(transport)) {
          createdTransports.add(transport);
        }
      });

      const replacedTransports = new Set(
        remoteMediaBindings
          .filter(
            (binding) => binding.currentTransport !== binding.targetTransport,
          )
          .map((binding) => binding.currentTransport),
      );
      const transportByMid = new Map<string, RTCDtlsTransport>();
      remoteMediaBindings.forEach((binding) => {
        if (binding.remoteMedia.rtp.muxId) {
          transportByMid.set(
            binding.remoteMedia.rtp.muxId,
            binding.targetTransport,
          );
        }
      });
      const pendingTransceiverNotifications: RTCRtpTransceiver[] = [];
      const sctpBinding = remoteMediaBindings.find(
        (binding) => binding.sctpTransport !== undefined,
      );
      const plan: PendingRemoteOfferPlan = {
        remoteDescription: remoteSdp,
        bindings: remoteMediaBindings,
        transportByMid,
        replacedTransports,
        createdTransports,
        pendingTransceiverNotifications,
        snapshot: graphSnapshot,
        bundleEstablished: wasBundleEstablished,
        committed: false,
        deferReceiveParameters: hasCurrentNegotiatedSession,
        pendingSctp: sctpBinding
          ? this.buildPendingSctp(
              sctpBinding.remoteMedia,
              sctpBinding.index,
              remoteSdp.type === "answer"
                ? this.pendingLocalAdvertisedSctpPort
                : undefined,
            )
          : undefined,
      };

      // A remote answer must be completely authenticated before any current
      // transport receives its new SDP parameters.  A mismatched answer is
      // rejected without mutating the live association; the pending local
      // offer can still roll back.
      if (remoteSdp.type === "answer") {
        for (const binding of remoteMediaBindings) {
          const shouldApplyTransportParams =
            !binding.isBundleMember ||
            binding.isBundleTag ||
            bundleTag === undefined;
          if (
            !shouldApplyTransportParams ||
            binding.targetTransport.state !== "connected" ||
            !binding.remoteMedia.dtlsParams
          ) {
            continue;
          }
          binding.targetTransport.validateRemoteFingerprint(
            binding.remoteMedia.dtlsParams,
          );
        }
      }

      // Second pass validates codecs and surfaces receiver/track state.  A
      // first negotiation may provisionally rebind to the planned BUNDLE
      // transport so ontrack sees the shared owner; ICE/DTLS parameters still
      // wait for the local answer.  A current session is never rebound here.
      if (remoteSdp.type === "offer" && !hasCurrentNegotiatedSession) {
        for (const binding of remoteMediaBindings) {
          if (binding.currentTransport !== binding.targetTransport) {
            binding.rebind?.(binding.targetTransport);
          }
        }
        // Do not install ICE ufrag/password or DTLS fingerprints on a live
        // transport while the answer is still pending.  Lite STUN and DTLS
        // would otherwise start before SLD, racing SPED and the fingerprint
        // gate.  Only the ice-lite role hint is application-visible here.
        this.applyInitialRemoteIceLiteHints(plan, bundleTag);
      }
      remoteMediaBindings.forEach((binding) => binding.applyRemote());

      if (remoteSdp.type === "offer") {
        this.pendingRemoteOfferPlan = plan;
        this.setSignalingState("have-remote-offer");
      } else {
        await this.commitRemoteTransportPlan(plan, remoteSdp, bundleTag);
        // Apply pre-SRD candidates before publishing the answer/current SDP so
        // a candidate parse or transport error remains rollbackable.
        await this.flushPendingRemoteCandidates();
        this.sdpManager.commitPendingDescriptions();
        await this.stopReplacedTransports(plan.replacedTransports);
        this.pendingRemoteOfferPlan = undefined;
        this.pendingLocalOfferPlan = undefined;
        this.pendingLocalTransportByMid = undefined;
        this.pendingInitialBundleRouting = undefined;
        this.pendingLocalAdvertisedSctpPort = undefined;

        const removedTransceivers = this.transceiverManager
          .getTransceivers()
          .filter(
            (transceiver) =>
              remoteSdp!.media.find((media) =>
                matchTransceiverWithMedia(transceiver, media),
              ) === undefined,
          );
        if (remoteSdp.type === "answer") {
          for (const transceiver of removedTransceivers) {
            transceiver.stop();
            transceiver.stopped = true;
          }
        }

        this.setSignalingState(
          remoteSdp.type === "answer" ? "stable" : "have-remote-pranswer",
        );
      }

      if (this.isClosed) {
        return;
      }

      // Candidates buffered before a remote offer are validated against that
      // pending description and staged.  They reach the live ICE agent only
      // when the matching answer commits the transport plan.
      if (remoteSdp.type === "offer") {
        await this.flushPendingRemoteCandidates();
      }
      if (this.isClosed) {
        return;
      }

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
    } catch (error) {
      // No SDP or transport mutation from this attempt is allowed to escape a
      // rejected SRD.  In particular, an old current transport must remain
      // usable after a malformed BUNDLE offer or remote-answer failure.
      this.sdpManager.discardPendingRemoteDescription();
      await this.restorePeerGraph(graphSnapshot);
      await this.stopPendingTransports(createdTransports);
      this.pendingRemoteOfferPlan = undefined;
      if (remoteSdp?.type !== "answer") {
        this.pendingLocalTransportByMid = undefined;
      }
      this.pendingInitialBundleRouting = undefined;
      this.setSignalingState(previousSignalingState);
      throw error;
    }
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

    const rejectedMids = new Set(
      this.pendingRemoteOfferPlan?.bindings
        .filter(
          (binding) =>
            binding.requiresNewDtlsAssociation || binding.rejectTransport,
        )
        .map((binding) => binding.remoteMedia.rtp.muxId)
        .filter((mid): mid is string => !!mid) ?? [],
    );
    const pendingSctp = this.pendingRemoteOfferPlan?.pendingSctp;
    const description = this.sdpManager.buildAnswerSdp({
      transceivers: this.transceiverManager.getTransceivers(),
      sctpTransport: this.sctpTransport,
      signalingState: this.signalingState,
      dtlsTransportByMid: this.pendingRemoteOfferPlan?.transportByMid,
      rejectedMids,
      sctpPort: pendingSctp?.closeAssociation ? 0 : pendingSctp?.localPort,
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
    if (this.isClosed && state !== "closed") {
      return;
    }
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
    // Invalidate every in-flight connect() continuation before lower layers
    // reject their pending waits.  A close must remain the terminal state.
    this.connectEpoch++;
    this.pendingRemoteCandidates.length = 0;
    this.pendingRemoteOfferPlan = undefined;
    this.pendingLocalOfferPlan = undefined;
    this.pendingLocalTransportByMid = undefined;
    this.pendingInitialBundleRouting = undefined;
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
  /**
   * Opt-in SPED (DTLS handshake embedded in ICE Binding).
   * Omit or false: ICE completes, then DTLS starts (current serial path).
   * true: this PeerConnection only overlaps ICE checks with DTLS 1.3 handshake.
   * Requires explicit DTLS 1.3 in `dtls.protocolVersions`
   * (`dtls.protocolVersions` defaults to empty / DTLS 1.2 only).
   * Cannot be combined with `dtls.helloRetryRequest: true`
   * (SPED uses ICE-authenticated address validation, not a DTLS cookie).
   */
  sped?: boolean;
  /** Experimental WARP traffic policy. Early outbound remains opt-in. */
  warp?: {
    allowEarlyServerData?: boolean;
    earlyMediaPolicy?: "drop" | "buffer";
  };
  dtls: Partial<{
    keys: DtlsKeys;
    /**
     * DTLS protocol versions in preference order.
     * Unspecified / empty keeps DTLS 1.2 only. DTLS 1.3 requires explicit opt-in.
     * Independent of {@link PeerConfig.sped} (SPED also requires DTLS 1.3 at connect()).
     */
    protocolVersions: readonly DtlsVersion[];
    /**
     * DTLS 1.3 HelloRetryRequest cookie exchange.
     * Default false: ICE-authenticated path omits cookie HRR and saves 1 RTT.
     * true: send a cookie-bearing HRR (mapped internally to addressValidation: "dtls-cookie").
     * Group-only HRR for key_share correction is independent of this option.
     * Cannot be combined with {@link PeerConfig.sped} `true`.
     */
    helloRetryRequest?: boolean;
  }>;
  icePasswordPrefix: string | undefined;
  bundlePolicy: BundlePolicy;
  rtcpMuxPolicy: "require";
  iceCandidatePoolSize: number;
  certificates: RTCCertificate[];
  debug: DebugConfig;
  midSuffix: boolean;
  /** Advertised local SCTP max-message-size in SDP. Use 0 for unlimited. */
  maxMessageSize: number;
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

function peerConfigHasDtls13(config: PeerConfig): boolean {
  const versions = config.dtls.protocolVersions;
  if (!versions || versions.length === 0) {
    return false;
  }
  return versions.some((version) => version === "1.3");
}

function generateDefaultPeerConfig(): Required<PeerConfig> {
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
    turnTransport: undefined,
    turnTlsOptions: undefined,
    iceFilterStunResponse: undefined,
    iceFilterCandidatePair: undefined,
    icePasswordPrefix: undefined,
    iceUseLinkLocalAddress: undefined,
    dtls: {},
    sped: false,
    warp: {
      allowEarlyServerData: false,
      earlyMediaPolicy: "drop",
    },
    bundlePolicy: "max-compat",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 0,
    certificates: [],
    debug: {},
    midSuffix: false,
    forceTurnTCP: false,
    maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE,
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

  if ("sped" in input) {
    normalizedConfig.sped = input.sped === true;
  }

  if ("warp" in input) {
    if (
      input.warp?.earlyMediaPolicy !== undefined &&
      input.warp.earlyMediaPolicy !== "drop" &&
      input.warp.earlyMediaPolicy !== "buffer"
    ) {
      throw createWebRtcTypeError(
        'warp.earlyMediaPolicy must be "drop" or "buffer"',
      );
    }
    normalizedConfig.warp = {};
    if (input.warp?.allowEarlyServerData !== undefined) {
      normalizedConfig.warp.allowEarlyServerData =
        input.warp.allowEarlyServerData === true;
    }
    if (input.warp?.earlyMediaPolicy !== undefined) {
      normalizedConfig.warp.earlyMediaPolicy = input.warp.earlyMediaPolicy;
    }
  }

  return normalizedConfig;
}

function dtlsProtocolVersionsKey(versions: readonly DtlsVersion[] | undefined) {
  return (versions ?? []).join(",");
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
    dtls: {
      ...config.dtls,
      protocolVersions: config.dtls.protocolVersions
        ? [...config.dtls.protocolVersions]
        : undefined,
      helloRetryRequest: config.dtls.helloRetryRequest,
    },
    warp: config.warp ? { ...config.warp } : undefined,
    certificates: [...config.certificates],
    debug: { ...config.debug },
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
