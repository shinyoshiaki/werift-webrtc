import { randomUUID } from "crypto";
import { SCTP_STATE } from "../../sctp/src";

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
import { NegotiationTransaction } from "./negotiationTransaction";
import { SctpTransportManager } from "./sctpManager";
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
  RTCCertificate,
  RTCDtlsTransport,
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
import { andDirection, deepMerge } from "./utils";

const log = debug("werift:packages/webrtc/src/peerConnection.ts");

function fingerprintKey(params: NonNullable<MediaDescription["dtlsParams"]>) {
  return params.fingerprints
    .map(
      ({ algorithm, value }) =>
        `${algorithm.toLowerCase()}:${value.replaceAll(":", "").toLowerCase()}`,
    )
    .sort()
    .join("|");
}

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
  private readonly negotiation: NegotiationTransaction;
  private isClosed = false;
  private applyingIceRestart = false;
  private descriptionTail: Promise<void> = Promise.resolve();
  private shouldNegotiationneeded = false;
  private lastCreatedAnswer?: RTCSessionDescription;
  private lastCreatedOffer?: RTCSessionDescription;
  private readonly pendingRemoteCandidates: Array<
    RTCIceCandidate | RTCIceCandidateInit | null
  > = [];

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
    this.negotiation = new NegotiationTransaction(
      this.sdpManager,
      this.transceiverManager,
      this.router,
      this.sctpManager,
    );
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
    if (this.negotiation.transportByMid.size > 0) {
      await this.negotiation.discardPreparedTransports();
    }
    if (this.signalingState === "stable") this.negotiation.begin();
    const restartRequested = !!iceRestart || this.needRestart;
    if (restartRequested) {
      this.needRestart = false;
      if (
        this.sdpManager.currentLocalDescription &&
        this.sdpManager.currentRemoteDescription
      ) {
        this.secureManager.stageIceRestart();
      } else {
        this.secureManager.restartIce();
      }
    } else {
      this.secureManager.rollbackStagedIceRestart();
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
    if (
      restartRequested &&
      this.sdpManager.currentRemoteDescription &&
      this.sctpTransport?.sctp?.associationState !== SCTP_STATE.ESTABLISHED
    ) {
      const pending = this.findOrCreateTransport(true);
      pending.iceTransport.iceRestarts =
        Math.max(
          ...this.iceTransports.map((transport) => transport.iceRestarts),
        ) + 1;
      pending.iceTransport.connection.generation = this.iceGeneration + 1;
      try {
        const firstMid = description.media.find(
          (media) => media.port !== 0 && media.rtp.muxId,
        )?.rtp.muxId;
        if (firstMid) {
          this.negotiation.prepareTransport(
            description,
            firstMid,
            pending,
            true,
          );
        }
        await pending.iceTransport.gather();
        for (const media of description.media) {
          if (media.port === 0 || !media.rtp.muxId) continue;
          this.negotiation.prepareTransport(
            description,
            media.rtp.muxId,
            pending,
            true,
          );
          media.iceParams = pending.iceTransport.localParameters;
          media.iceCandidates = [...pending.iceTransport.localCandidates];
          media.iceCandidatesComplete = true;
          media.dtlsParams = pending.localParameters;
        }
        this.secureManager.rollbackStagedIceRestart();
      } catch (error) {
        await this.negotiation.discardPreparedTransports();
        throw error;
      }
    }
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

  private async enqueueDescriptionOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.descriptionTail;
    let release!: () => void;
    this.descriptionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private findOrCreateTransport(forceNew = false) {
    const existingDtlsTransport = this.dtlsTransports.find(
      (transport) => transport.state !== "closed",
    );
    const existing = existingDtlsTransport?.iceTransport;

    // Gather ICE candidates for only one track. If the remote endpoint is not bundle-aware, negotiate only one media track.
    // https://w3c.github.io/webrtc-pc/#rtcbundlepolicy-enum
    if (
      !forceNew &&
      (this.sdpManager.bundlePolicy === "max-bundle" ||
        (this.sdpManager.bundlePolicy !== "disable" && this.remoteIsBundled))
    ) {
      if (existingDtlsTransport) {
        return existingDtlsTransport;
      }
    }

    const dtlsTransport = this.secureManager.createTransport(forceNew);
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
      if (
        this.applyingIceRestart ||
        this.negotiation.isPendingOnlyTransport(iceTransport.id)
      )
        return;
      if (!this.localDescription) {
        log("localDescription not found when ice candidate was gathered");
        return;
      }
      if (!candidate) {
        this.sdpManager.setLocal(
          this._localDescription!,
          this.transceiverManager.getTransceivers(),
          this.sctpTransport,
          this.negotiation.transportByMid,
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

      this.secureManager.handleNewIceCandidate({
        candidate,
        bundlePolicy: this.sdpManager.bundlePolicy,
        remoteIsBundled: !!this.sdpManager.remoteIsBundled?.items.some(
          (mid) =>
            this.transceiverManager
              .getTransceivers()
              .some(
                (t) =>
                  t.dtlsTransport.iceTransport.id === iceTransport.id &&
                  t.mid === mid,
              ) ||
            (this.sctpTransport?.dtlsTransport.iceTransport.id ===
              iceTransport.id &&
              this.sctpTransport.mid === mid),
        ),
        media:
          this._localDescription.media.find(
            (media) =>
              media.rtp.muxId === this.sdpManager.remoteIsBundled?.items[0],
          ) ?? this._localDescription.media[0],
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

  async setLocalDescription(sessionDescription: {
    type: "rollback";
  }): Promise<void>;
  async setLocalDescription(
    sessionDescription?: RTCLocalSessionDescriptionInit,
  ): Promise<SessionDescription>;
  async setLocalDescription(
    sessionDescription?: RTCLocalSessionDescriptionInit,
  ): Promise<SessionDescription | void> {
    return this.enqueueDescriptionOperation(async () => {
      // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/setLocalDescription#type
      const implicitOfferState: RTCSignalingState[] = [
        "stable",
        "have-local-offer",
        "have-remote-pranswer",
      ];

      await this.waitForPendingDescriptionTask();

      if (sessionDescription?.type === "rollback") {
        this.negotiation.retireRemoteGeneration(
          this.sdpManager.pendingRemoteDescription,
        );
        this.sdpManager.rollbackLocalDescription(this.signalingState);
        this.secureManager.rollbackStagedIceRestart();
        await this.negotiation.rollback();
        await this.cleanupInitialProvisionalTransport();
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
      for (const media of description.media) {
        if (media.port === 0 || !media.iceParams) continue;
        const transport =
          ((description.type === "answer" ||
            description.type === "pranswer" ||
            description.type === "offer") &&
            media.rtp.muxId &&
            this.negotiation.transportByMid.get(media.rtp.muxId)) ||
          (media.kind === "application"
            ? this.sctpTransport?.dtlsTransport
            : this.transceiverManager
                .getTransceivers()
                .find((transceiver) => transceiver.mid === media.rtp.muxId)
                ?.dtlsTransport);
        if (
          transport &&
          (transport.iceTransport.localParameters.usernameFragment !==
            media.iceParams.usernameFragment ||
            transport.iceTransport.localParameters.password !==
              media.iceParams.password)
        ) {
          throw createWebRtcDomException(
            "InvalidModificationError",
            "Local SDP must use prepared ICE credentials",
          );
        }
      }
      if (
        description.type === "offer" &&
        this.signalingState === "have-remote-pranswer"
      ) {
        this.negotiation.retireRemoteGeneration(
          this.sdpManager.pendingRemoteDescription,
        );
        this.sdpManager.setRemoteDescription(
          { type: "rollback" },
          this.signalingState,
        );
        this.secureManager.rollbackStagedIceRestart();
        await this.negotiation.rollback();
        await this.cleanupInitialProvisionalTransport();
        this.setSignalingState("stable");
      }
      if (description.type === "offer") {
        if (this.signalingState === "have-local-offer") {
          await this.negotiation.replace();
          this.sdpManager.pendingLocalDescription = undefined;
        } else {
          this.negotiation.begin();
        }
      }
      this.negotiation.validate();
      this.negotiation.prepare();
      if (description.type === "offer") {
        await this.prepareLocalOfferTopology(description);
      }

      if (
        description.type === "answer" &&
        this.sdpManager.currentRemoteDescription
      ) {
        this.applyPendingBundleTopology();
        await this.commitStagedIceRestart();
        await this.activatePendingRemoteTransport();
        for (const transceiver of this.transceiverManager.getTransceivers()) {
          if (transceiver.mid && transceiver.codecs.length > 0) {
            transceiver.sender.prepareSend(
              this.transceiverManager.getLocalRtpParams(transceiver),
            );
          }
        }
      }
      if (
        description.type === "pranswer" &&
        this.sdpManager.currentRemoteDescription
      ) {
        await this.activatePendingRemoteTransport(true);
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
      const role = description.media.find((media) => media.dtlsParams)
        ?.dtlsParams?.role;

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
      if (description.type === "answer") {
        for (const media of description.media.filter(
          (media) => media.port === 0,
        )) {
          const rejected = this.transceiverManager
            .getTransceivers()
            .find((t) => t.mid === media.rtp.muxId);
          if (rejected) {
            this.router.unregisterTransceiver(rejected);
            rejected.forceStop();
          }
        }
      }

      // for trickle ice
      this.sdpManager.setLocal(
        description,
        this.transceiverManager.getTransceivers(),
        this.sctpTransport,
        this.negotiation.transportByMid,
      );

      if (description.type === "offer") {
        this.setSignalingState("have-local-offer");
      } else if (description.type === "answer") {
        this.setSignalingState("stable");
      } else if (description.type === "pranswer") {
        this.setSignalingState("have-local-pranswer");
      }

      if (description.type === "offer") {
        this.secureManager.emitStagedIceCandidates();
      } else if (description.type === "answer") {
        this.secureManager.emitCommittedIceCandidates();
      }

      if (["offer", "answer", "pranswer"].includes(description.type)) {
        const prepared = this.negotiation.takePreparedCandidateTransports();
        for (const transport of prepared) {
          const mediaIndex = description.media.findIndex(
            (media) =>
              this.negotiation.transportByMid.get(media.rtp.muxId ?? "") ===
              transport,
          );
          if (mediaIndex < 0) continue;
          for (const candidate of transport.iceTransport.localCandidates) {
            candidate.sdpMid = description.media[mediaIndex].rtp.muxId;
            candidate.sdpMLineIndex = mediaIndex;
            if (
              candidate.foundation &&
              !candidate.foundation.startsWith("candidate:")
            ) {
              candidate.foundation = `candidate:${candidate.foundation}`;
            }
            this.secureManager.onIceCandidate.execute(candidate);
          }
        }
        if (prepared.length > 0) {
          this.secureManager.onIceCandidate.execute(undefined);
        }
      }

      if (description.type === "answer") await this.negotiation.commit();

      await this.gatherCandidates().catch((e) => {
        log("gatherCandidates failed", e);
      });

      // connect transports
      if (description.type === "answer" || description.type === "pranswer") {
        if (description.type === "pranswer") {
          this.connectPending().catch((err) =>
            log("pending connect failed", err),
          );
        }
        this.connect().catch((err) => {
          log("connect failed", err);
          this.secureManager.setConnectionState("failed");
        });
      }

      this.sdpManager.setLocal(
        description,
        this.transceiverManager.getTransceivers(),
        this.sctpTransport,
        this.negotiation.transportByMid,
      );

      if (this.shouldNegotiationneeded) {
        this.needNegotiation();
      }

      this.invalidateLastCreatedDescriptions();
      return description;
    });
  }

  private async gatherCandidates() {
    await this.secureManager.gatherCandidates();
  }

  private async commitStagedIceRestart() {
    this.applyingIceRestart = true;
    try {
      await this.secureManager.commitStagedIceRestart();
    } finally {
      this.applyingIceRestart = false;
    }
  }

  /** Retire a first negotiation's provisional connection without losing app objects. */
  private async cleanupInitialProvisionalTransport() {
    if (
      this.sdpManager.currentLocalDescription ||
      this.sdpManager.currentRemoteDescription
    ) {
      return;
    }
    const transports = [...this.dtlsTransports];
    if (
      !transports.some(
        (dtls) =>
          dtls.state !== "new" ||
          !["new", "closed"].includes(dtls.iceTransport.state),
      )
    ) {
      return;
    }
    if (this.sctpTransport) {
      await this.sctpTransport.stop();
      this.sctpManager.sctpRemotePort = undefined;
    }
    await Promise.all(transports.map((dtls) => dtls.stop()));
    for (const transceiver of this.transceiverManager.getTransceivers()) {
      transceiver.setDtlsTransport(this.findOrCreateTransport());
    }
    if (this.sctpTransport) {
      this.sctpTransport.setDtlsTransport(this.findOrCreateTransport());
    }
    this.secureManager.updateIceConnectionState();
  }

  /** Activate a re-offer's staged transport parameters at its final answer. */
  private async activatePendingRemoteTransport(pendingOnly = false) {
    const offer = this.sdpManager.pendingRemoteDescription;
    if (!offer || offer.type !== "offer") return;
    const bundleItems =
      offer.group.find((group) => group.semantic === "BUNDLE")?.items ?? [];
    const bundledMids = new Set(bundleItems);
    const candidatesByTransport = new Map<
      RTCIceTransport,
      Map<string, (typeof offer.media)[number]["iceCandidates"][number]>
    >();
    const eoc = new Set<RTCIceTransport>();
    for (const [index, media] of offer.media.entries()) {
      if (media.port === 0) continue;
      const dtls =
        (media.rtp.muxId &&
          this.negotiation.transportByMid.get(media.rtp.muxId)) ||
        (media.kind === "application"
          ? this.sctpTransport?.dtlsTransport
          : this.transceiverManager
              .getTransceivers()
              .find((t) => t.mid === media.rtp.muxId)?.dtlsTransport);
      if (!dtls) continue;
      const bundledNonTag =
        bundledMids.has(media.rtp.muxId ?? "") &&
        media.rtp.muxId !== bundleItems[0];
      if (
        pendingOnly &&
        !this.negotiation.isPendingOnlyTransport(dtls.iceTransport.id)
      ) {
        // A restart on a transport that keeps its SCTP association checks the
        // new generation beside the selected current pair.
        if (!bundledNonTag) {
          await this.applyProvisionalIce(dtls.iceTransport, media);
        }
        continue;
      }
      if (media.kind === "application") {
        this.sctpManager.setRemoteSCTP(media, index);
      }
      if (bundledNonTag) continue;
      if (media.iceParams) dtls.iceTransport.setRemoteParams(media.iceParams);
      if (media.dtlsParams) dtls.setRemoteParams(media.dtlsParams);
      const candidates =
        candidatesByTransport.get(dtls.iceTransport) ?? new Map();
      for (const candidate of media.iceCandidates) {
        candidates.set(candidate.toJSON().candidate, candidate);
      }
      candidatesByTransport.set(dtls.iceTransport, candidates);
      if (media.iceCandidatesComplete) eoc.add(dtls.iceTransport);
    }
    for (const [transport, candidates] of candidatesByTransport) {
      for (const candidate of candidates.values()) {
        await transport.addRemoteCandidate(candidate);
      }
      if (eoc.has(transport)) await transport.addRemoteCandidate(undefined);
    }
  }

  private async applyProvisionalIce(
    iceTransport: RTCIceTransport,
    media: MediaDescription,
  ) {
    if (!iceTransport.hasStagedRestart || !media.iceParams) return;
    iceTransport.setProvisionalRemoteParams(media.iceParams);
    for (const candidate of media.iceCandidates) {
      await iceTransport.addProvisionalRemoteCandidate(candidate);
    }
    if (media.iceCandidatesComplete) {
      await iceTransport.addProvisionalRemoteCandidate(undefined);
    }
  }

  private currentTransportForMid(mid: string) {
    return (
      this.negotiation.transportByMid.get(mid) ??
      this.transceiverManager
        .getTransceivers()
        .find((transceiver) => transceiver.mid === mid)?.dtlsTransport ??
      (this.sctpTransport?.mid === mid
        ? this.sctpTransport.dtlsTransport
        : undefined)
    );
  }

  private async prepareLocalOfferTopology(offer: SessionDescription) {
    if (this.negotiation.transportByMid.size > 0) return;
    if (this.negotiation.preparedDescription === offer) return;
    const bundle =
      this.sdpManager.bundlePolicy === "disable"
        ? undefined
        : offer.group.find((group) => group.semantic === "BUNDLE");
    const bundledMids = new Set(bundle?.items ?? []);
    const ownerByMid = new Map<string, string>();
    for (const media of offer.media) {
      if (media.port === 0 || !media.rtp.muxId) continue;
      ownerByMid.set(
        media.rtp.muxId,
        bundledMids.has(media.rtp.muxId) ? bundle!.items[0] : media.rtp.muxId,
      );
    }
    const currentByMid = new Map<string, RTCDtlsTransport>();
    for (const transceiver of this.transceiverManager.getTransceivers()) {
      if (transceiver.mid)
        currentByMid.set(transceiver.mid, transceiver.dtlsTransport);
    }
    if (this.sctpTransport?.mid) {
      currentByMid.set(
        this.sctpTransport.mid,
        this.sctpTransport.dtlsTransport,
      );
    }
    const assignedOwner = new Map<RTCDtlsTransport, string>();
    try {
      for (const [mid, owner] of ownerByMid) {
        let transport = currentByMid.get(mid);
        if (
          !transport ||
          (assignedOwner.has(transport) &&
            assignedOwner.get(transport) !== owner)
        ) {
          transport = this.findOrCreateTransport(true);
          this.negotiation.prepareTransport(offer, mid, transport, true);
          await transport.iceTransport.gather();
        }
        assignedOwner.set(transport, owner);
        this.negotiation.prepareTransport(offer, mid, transport);
      }
    } catch (error) {
      await this.negotiation.discardPreparedTransports();
      throw error;
    }
  }

  /**
   * Decide which live transport each proposed BUNDLE owner of a re-offer would
   * reuse. `undefined` means the owner needs a new pending transport.
   */
  private planPendingBundleTopology(offer: SessionDescription) {
    const current = this.sdpManager.currentRemoteDescription;
    const bundle =
      this.sdpManager.bundlePolicy === "disable"
        ? undefined
        : offer.group.find((group) => group.semantic === "BUNDLE");
    const bundleMids = new Set(bundle?.items ?? []);
    const ownerByMid = new Map<string, string>();
    for (const media of offer.media) {
      if (media.port === 0 || !media.rtp.muxId) continue;
      if (
        (media.kind === "audio" || media.kind === "video") &&
        this.transceiverManager
          .getTransceivers()
          .find((transceiver) => transceiver.mid === media.rtp.muxId)?.codecs
          .length === 0
      )
        continue;
      ownerByMid.set(
        media.rtp.muxId,
        bundleMids.has(media.rtp.muxId) ? bundle!.items[0] : media.rtp.muxId,
      );
    }

    const currentByMid = new Map<string, RTCDtlsTransport>();
    for (const transceiver of this.transceiverManager.getTransceivers()) {
      if (transceiver.mid)
        currentByMid.set(transceiver.mid, transceiver.dtlsTransport);
    }
    if (this.sctpTransport?.mid) {
      currentByMid.set(
        this.sctpTransport.mid,
        this.sctpTransport.dtlsTransport,
      );
    }
    const owners = new Map<
      string,
      {
        reuse?: RTCDtlsTransport;
        restarted?: boolean;
        current?: RTCDtlsTransport;
      }
    >();
    const used = new Set<RTCDtlsTransport>();
    for (const owner of new Set(ownerByMid.values())) {
      const transport = currentByMid.get(owner);
      const proposedMedia = offer.media.find(
        (media) => media.rtp.muxId === owner,
      );
      const currentMedia = current?.media.find(
        (media) => media.rtp.muxId === owner,
      );
      const restarted =
        !!proposedMedia?.iceParams &&
        !!currentMedia?.iceParams &&
        proposedMedia.iceParams.usernameFragment !==
          currentMedia.iceParams.usernameFragment;
      const connectedSctpOwner =
        this.sctpTransport?.sctp?.associationState === SCTP_STATE.ESTABLISHED &&
        ownerByMid.get(this.sctpTransport.mid ?? "") === owner;
      if (
        !transport ||
        used.has(transport) ||
        (restarted && !connectedSctpOwner)
      ) {
        owners.set(owner, { restarted, current: transport });
      } else {
        owners.set(owner, { reuse: transport });
        used.add(transport);
      }
    }
    return { ownerByMid, owners };
  }

  /** Reject a re-offer whose topology would move a connected SCTP association. */
  private assertPendingSctpBinding(offer: SessionDescription) {
    const sctp = this.sctpTransport;
    if (
      !this.sdpManager.currentRemoteDescription ||
      !sctp?.mid ||
      sctp.sctp?.associationState !== SCTP_STATE.ESTABLISHED
    )
      return;
    const { ownerByMid, owners } = this.planPendingBundleTopology(offer);
    const owner = ownerByMid.get(sctp.mid);
    if (owner === undefined) return;
    if (owners.get(owner)?.reuse !== sctp.dtlsTransport) {
      throw createWebRtcDomException(
        "InvalidModificationError",
        "Moving a connected SCTP association to another DTLS transport is unsupported",
      );
    }
  }

  /** Keep a re-offer's proposed BUNDLE owners separate from the live bindings. */
  private async preparePendingBundleTopology() {
    const offer = this.sdpManager.pendingRemoteDescription;
    if (
      !offer ||
      offer.type !== "offer" ||
      this.negotiation.preparedDescription === offer
    )
      return;
    if (!this.sdpManager.currentRemoteDescription) return;

    this.assertPendingSctpBinding(offer);
    const { ownerByMid, owners } = this.planPendingBundleTopology(offer);
    try {
      const ownerTransports = new Map<string, RTCDtlsTransport>();
      for (const [owner, plan] of owners) {
        let transport = plan.reuse;
        if (!transport) {
          transport = this.findOrCreateTransport(true);
          if (plan.restarted) {
            const previous = plan.current?.iceTransport;
            transport.iceTransport.iceRestarts =
              (previous?.iceRestarts ?? 0) + 1;
            transport.iceTransport.connection.generation =
              (previous?.connection.generation ?? 0) + 1;
          }
          this.negotiation.prepareTransport(offer, owner, transport, true);
          await transport.iceTransport.gather();
        }
        ownerTransports.set(owner, transport);
      }
      for (const [mid, owner] of ownerByMid) {
        this.negotiation.prepareTransport(
          offer,
          mid,
          ownerTransports.get(owner)!,
        );
      }
    } catch (error) {
      await this.negotiation.discardPreparedTransports();
      throw error;
    }
  }

  private applyPendingBundleTopology() {
    const transports = this.negotiation.transportByMid;
    if (transports.size === 0) return;
    for (const transceiver of this.transceiverManager.getTransceivers()) {
      const transport = transceiver.mid && transports.get(transceiver.mid);
      if (transport) transceiver.setDtlsTransport(transport);
    }
    if (this.sctpTransport?.mid) {
      const transport = transports.get(this.sctpTransport.mid);
      if (transport) this.sctpTransport.setDtlsTransport(transport);
    }
  }

  async addIceCandidate(
    candidateMessage: RTCIceCandidate | RTCIceCandidateInit | null = {},
  ) {
    return this.enqueueDescriptionOperation(async () => {
      if (this.isClosed) {
        throw createWebRtcDomException("InvalidStateError", "is closed");
      }

      if (!this.remoteDescription || !this.sdpManager._remoteDescription) {
        const ufrag =
          candidateMessage?.usernameFragment ??
          candidateMessage?.candidate?.match(/\bufrag\s+(\S+)/)?.[1];
        if (this.negotiation.isRetiredRemoteUfrag(ufrag)) {
          throw createWebRtcDomException(
            "OperationError",
            "ICE generation was rolled back or replaced",
          );
        }
        this.pendingRemoteCandidates.push(candidateMessage);
        return;
      }
      await this.applyRemoteIceCandidate(candidateMessage);
    });
  }

  private async applyRemoteIceCandidate(
    candidateMessage: RTCIceCandidate | RTCIceCandidateInit | null,
  ) {
    const current = this.sdpManager.currentRemoteDescription;
    const pending = this.sdpManager.pendingRemoteDescription;
    const ufrag = candidateMessage?.usernameFragment;
    const matchesUfrag = (description: SessionDescription) =>
      description.media.some(
        (media) => media.iceParams?.usernameFragment === ufrag,
      );
    const sdp =
      ufrag &&
      current &&
      matchesUfrag(current) &&
      (!pending || !matchesUfrag(pending))
        ? current
        : (pending ?? current);
    if (!sdp) {
      return;
    }
    // A new remote generation is only a proposal during a re-offer. Keep its
    // trickle data in the pending SDP until the final answer activates it.
    const stageOnly =
      sdp === pending &&
      !!current &&
      (pending?.type === "offer" || pending?.type === "pranswer");
    const appliedCandidate = await this.secureManager.addIceCandidate(
      sdp,
      candidateMessage,
      !stageOnly,
    );
    const remoteDescription = sdp;
    if (!remoteDescription || !appliedCandidate) {
      return;
    }
    if (stageOnly) {
      const targets = new Set(
        appliedCandidate.mediaIndices
          .map((index) =>
            this.negotiation.transportByMid.get(
              remoteDescription.media[index]?.rtp.muxId ?? "",
            ),
          )
          .filter(
            (transport): transport is RTCDtlsTransport =>
              !!transport &&
              this.negotiation.isPendingOnlyTransport(
                transport.iceTransport.id,
              ),
          ),
      );
      for (const transport of targets) {
        await transport.iceTransport.addRemoteCandidate(
          appliedCandidate.kind === "end-of-candidates"
            ? undefined
            : appliedCandidate.candidate,
        );
      }
      if (
        this.signalingState === "have-local-pranswer" ||
        this.signalingState === "have-remote-pranswer"
      ) {
        const provisional = new Set(
          appliedCandidate.mediaIndices
            .map(
              (index) =>
                this.currentTransportForMid(
                  remoteDescription.media[index]?.rtp.muxId ?? "",
                )?.iceTransport,
            )
            .filter(
              (transport): transport is RTCIceTransport =>
                !!transport?.hasStagedRestart &&
                !this.negotiation.isPendingOnlyTransport(transport.id),
            ),
        );
        for (const transport of provisional) {
          await transport.addProvisionalRemoteCandidate(
            appliedCandidate.kind === "end-of-candidates"
              ? undefined
              : appliedCandidate.candidate,
          );
        }
      }
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

    const res = await Promise.allSettled(
      this.dtlsTransports.map(async (dtlsTransport) => {
        const { iceTransport } = dtlsTransport;
        if (
          iceTransport.state === "connected" &&
          dtlsTransport.state === "connected"
        ) {
          return;
        }
        const checkDtlsConnected = () => dtlsTransport.state === "connected";

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

  /** Connect a provisional ICE/DTLS generation without changing live bindings. */
  private async connectPending() {
    const pending = [
      ...new Set(this.negotiation.transportByMid.values()),
    ].filter((transport) =>
      this.negotiation.isPendingOnlyTransport(transport.iceTransport.id),
    );
    for (const iceTransport of this.iceTransports) {
      if (!this.negotiation.isPendingOnlyTransport(iceTransport.id)) {
        iceTransport.startProvisionalChecks();
      }
    }
    await Promise.all(
      pending.map(async (transport) => {
        transport.iceTransport.connection.iceControlling =
          this.signalingState === "have-remote-pranswer";
        await transport.iceTransport.start();
        if (transport.state !== "connected") await transport.start();
      }),
    );
  }

  restartIce() {
    this.needRestart = true;
    this.needNegotiation();
  }

  async setRemoteDescription(sessionDescription: RTCSessionDescriptionInit) {
    return this.enqueueDescriptionOperation(async () => {
      if (sessionDescription instanceof SessionDescription) {
        sessionDescription = sessionDescription.toSdp();
      }

      await this.waitForPendingDescriptionTask();

      if (sessionDescription.type === "rollback") {
        this.negotiation.retireRemoteGeneration(
          this.sdpManager.pendingRemoteDescription,
        );
        this.sdpManager.setRemoteDescription(
          sessionDescription,
          this.signalingState,
        );
        this.secureManager.rollbackStagedIceRestart();
        await this.negotiation.rollback();
        await this.cleanupInitialProvisionalTransport();
        this.setSignalingState("stable");
        if (this.shouldNegotiationneeded) this.needNegotiation();
        this.invalidateLastCreatedDescriptions();
        return;
      }

      if (!sessionDescription.type || !sessionDescription.sdp) {
        throw createWebRtcDomException(
          "OperationError",
          "Invalid remote description",
        );
      }
      const previousPending = this.sdpManager.pendingRemoteDescription;
      if (
        previousPending?.type === sessionDescription.type &&
        previousPending.toJSON().sdp === sessionDescription.sdp
      ) {
        return;
      }

      // Validate the whole proposal before implicit rollback, publication or any
      // media/transport mutation. A rejected proposal leaves the old transaction.
      const remoteSdp = this.sdpManager.parseSdp({
        sdp: sessionDescription.sdp,
        isLocal: false,
        signalingState: this.signalingState,
        type: sessionDescription.type,
      });
      for (const [mediaIndex, media] of remoteSdp.media.entries()) {
        if (!["audio", "video", "application"].includes(media.kind)) {
          throw createWebRtcDomException(
            "OperationError",
            "Unsupported media kind",
          );
        }
        if (media.kind === "application" && media.port !== 0) {
          if (!media.sctpPort || media.sctpPort < 1 || media.sctpPort > 65535) {
            throw createWebRtcDomException(
              "OperationError",
              "Invalid SCTP port",
            );
          }
          if (
            this.sctpManager.sctpRemotePort &&
            this.sctpManager.sctpRemotePort !== media.sctpPort
          ) {
            throw createWebRtcDomException(
              "InvalidModificationError",
              "Changing the port of an existing SCTP association is unsupported",
            );
          }
        }
        if (
          remoteSdp.type !== "offer" &&
          media.port !== 0 &&
          media.kind !== "application" &&
          !media.rtp.codecs.some((codec) =>
            (this.config.codecs[media.kind] ?? []).some((local) =>
              findCodecByMimeType([local], codec),
            ),
          )
        ) {
          throw createWebRtcDomException(
            "OperationError",
            "No supported codec in answer",
          );
        }
        if (media.port !== 0 && this.sdpManager.currentRemoteDescription) {
          const currentMedia =
            this.sdpManager.currentRemoteDescription.media[mediaIndex];
          const transport =
            media.kind === "application"
              ? this.sctpTransport?.dtlsTransport
              : this.transceiverManager
                  .getTransceivers()
                  .find((t) => t.mid === media.rtp.muxId)?.dtlsTransport;
          if (
            transport?.state === "connected" &&
            currentMedia?.dtlsParams &&
            media.dtlsParams
          ) {
            if (
              fingerprintKey(currentMedia.dtlsParams) !==
              fingerprintKey(media.dtlsParams)
            ) {
              throw createWebRtcDomException(
                "InvalidModificationError",
                "Changing the fingerprint of a connected DTLS association is unsupported",
              );
            }
          }
        }
        if (
          media.port !== 0 &&
          this.sdpManager.pendingRemoteDescription?.type === "pranswer" &&
          !this.sdpManager.currentRemoteDescription
        ) {
          const provisional =
            this.sdpManager.pendingRemoteDescription.media[mediaIndex];
          const transport =
            media.kind === "application"
              ? this.sctpTransport?.dtlsTransport
              : this.transceiverManager
                  .getTransceivers()
                  .find((transceiver) => transceiver.mid === media.rtp.muxId)
                  ?.dtlsTransport;
          if (
            transport?.state === "connected" &&
            provisional?.dtlsParams &&
            media.dtlsParams &&
            fingerprintKey(provisional.dtlsParams) !==
              fingerprintKey(media.dtlsParams)
          ) {
            throw createWebRtcDomException(
              "InvalidModificationError",
              "Changing the fingerprint of a provisional DTLS association is unsupported",
            );
          }
        }
      }
      if (
        remoteSdp.type === "answer" &&
        this.sctpTransport?.sctp?.associationState === SCTP_STATE.ESTABLISHED
      ) {
        const application = remoteSdp.media.find(
          (media) => media.kind === "application" && media.port !== 0,
        );
        if (application?.rtp.muxId) {
          const bundle = remoteSdp.group.find(
            (group) =>
              group.semantic === "BUNDLE" &&
              group.items.includes(application.rtp.muxId!),
          );
          const owner = bundle?.items[0] ?? application.rtp.muxId;
          const desired =
            this.negotiation.transportByMid.get(owner) ??
            this.transceiverManager
              .getTransceivers()
              .find((transceiver) => transceiver.mid === owner)
              ?.dtlsTransport ??
            (this.sctpTransport.mid === owner
              ? this.sctpTransport.dtlsTransport
              : undefined);
          if (desired && desired !== this.sctpTransport.dtlsTransport) {
            throw createWebRtcDomException(
              "InvalidModificationError",
              "Moving a connected SCTP association to another DTLS transport is unsupported",
            );
          }
        }
      }

      if (remoteSdp.type === "offer") {
        // Checked before a replacement retires the previous pending offer.
        this.assertPendingSctpBinding(remoteSdp);
      }

      const needsImplicitLocalRollback =
        sessionDescription.type === "offer" &&
        ["have-local-offer", "have-local-pranswer"].includes(
          this.signalingState,
        );
      if (needsImplicitLocalRollback) {
        this.negotiation.retireRemoteGeneration(
          this.sdpManager.pendingRemoteDescription,
        );
        this.sdpManager.rollbackLocalDescription(this.signalingState);
        this.secureManager.rollbackStagedIceRestart();
        await this.negotiation.rollback();
        await this.cleanupInitialProvisionalTransport();
        this.shouldNegotiationneeded = true;
        this.setSignalingState("stable");
        await Promise.resolve();
      }
      if (
        remoteSdp.type === "offer" &&
        this.signalingState === "have-remote-offer"
      ) {
        // A replacement offer retires the old proposal before it can donate
        // transceivers, routes or candidates to the new revision.
        this.negotiation.retireRemoteGeneration(
          this.sdpManager.pendingRemoteDescription,
        );
        await this.negotiation.replace();
        this.secureManager.rollbackStagedIceRestart();
        this.sdpManager.pendingRemoteDescription = undefined;
      }
      if (
        remoteSdp.type === "offer" &&
        this.signalingState !== "have-remote-offer"
      ) {
        this.negotiation.begin();
      }
      this.negotiation.validate();
      this.negotiation.prepare();

      if (remoteSdp.type === "answer") {
        this.applyPendingBundleTopology();
        await this.commitStagedIceRestart();
      }

      const bundleItems =
        this.sdpManager.bundlePolicy === "disable"
          ? []
          : (remoteSdp.group.find((group) => group.semantic === "BUNDLE")
              ?.items ?? []);
      const bundledMids = new Set(bundleItems);
      const bundleTag = bundleItems[0];
      let bundleTransport: RTCDtlsTransport | undefined =
        this.transceiverManager
          .getTransceivers()
          .find((transceiver) => transceiver.mid === bundleTag)
          ?.dtlsTransport ??
        (bundleTag && this.sctpTransport?.mid === bundleTag
          ? this.sctpTransport.dtlsTransport
          : undefined);
      const preserveCurrentTransport =
        (remoteSdp.type === "offer" || remoteSdp.type === "pranswer") &&
        !!this.sdpManager.currentRemoteDescription;

      // # apply description

      const provisionalIce: [RTCIceTransport, MediaDescription][] = [];
      const matchTransceiverWithMedia = (
        transceiver: RTCRtpTransceiver,
        media: MediaDescription,
      ) =>
        transceiver.kind === media.kind &&
        [null, media.rtp.muxId].includes(transceiver.mid);

      let transports = remoteSdp.media.map((remoteMedia, i) => {
        let dtlsTransport: RTCDtlsTransport;
        const preparedTransport = remoteMedia.rtp.muxId
          ? this.negotiation.transportByMid.get(remoteMedia.rtp.muxId)
          : undefined;
        const pendingTransport =
          preparedTransport &&
          this.negotiation.isPendingOnlyTransport(
            preparedTransport.iceTransport.id,
          )
            ? preparedTransport
            : undefined;

        if (remoteMedia.port === 0) {
          if (remoteSdp.type === "answer") {
            const rejected = this.transceiverManager
              .getTransceivers()
              .find((t) => t.mid === remoteMedia.rtp.muxId);
            if (rejected) {
              this.router.unregisterTransceiver(rejected);
              rejected.forceStop();
            }
          }
          return;
        }

        if (["audio", "video"].includes(remoteMedia.kind)) {
          let transceiver = this.transceiverManager
            .getTransceivers()
            .find((t) => matchTransceiverWithMedia(t, remoteMedia));
          if (!transceiver) {
            // create remote transceiver
            transceiver = this.addTransceiver(remoteMedia.kind, {
              direction: "recvonly",
            });
            transceiver.mid = remoteMedia.rtp.muxId ?? null;
            this.transceiverManager.replaceStoppedTransceiverAtMLineIndex(
              transceiver,
              i,
            );
            this.negotiation.rememberRemoteTransceiver(transceiver);
            this.onRemoteTransceiverAdded.execute(transceiver);
          } else {
            if (transceiver.direction === "inactive" && transceiver.stopping) {
              transceiver.stopped = true;

              if (sessionDescription.type === "answer") {
                transceiver.setCurrentDirection("inactive");
              }
              return;
            }
          }

          if (bundledMids.has(remoteMedia.rtp.muxId ?? "")) {
            if (!bundleTransport) {
              bundleTransport = transceiver.dtlsTransport;
            } else {
              if (!preserveCurrentTransport || !transceiver.currentDirection) {
                transceiver.setDtlsTransport(bundleTransport);
              }
            }
          }

          dtlsTransport =
            preserveCurrentTransport && pendingTransport
              ? pendingTransport
              : transceiver.dtlsTransport;

          this.transceiverManager.setRemoteRTP(
            transceiver,
            remoteMedia,
            remoteSdp.type,
            i,
          );
        } else if (remoteMedia.kind === "application") {
          let sctpTransport = this.sctpTransport;
          if (!sctpTransport) {
            sctpTransport = this.createSctpTransport();
            sctpTransport.mid = remoteMedia.rtp.muxId;
          }

          if (bundledMids.has(remoteMedia.rtp.muxId ?? "")) {
            if (!bundleTransport) {
              bundleTransport = sctpTransport.dtlsTransport;
            } else {
              if (
                !preserveCurrentTransport ||
                !this.sctpManager.sctpRemotePort
              ) {
                sctpTransport.setDtlsTransport(bundleTransport);
              }
            }
          }

          dtlsTransport =
            preserveCurrentTransport && pendingTransport
              ? pendingTransport
              : sctpTransport.dtlsTransport;

          if (!preserveCurrentTransport || !this.sctpManager.sctpRemotePort) {
            this.sctpManager.setRemoteSCTP(remoteMedia, i);
          }
        } else {
          throw new Error("invalid media kind");
        }

        const iceTransport = dtlsTransport.iceTransport;
        const bundledNonTag =
          bundledMids.has(remoteMedia.rtp.muxId ?? "") &&
          remoteMedia.rtp.muxId !== bundleTag;

        if (
          remoteMedia.iceParams &&
          (!preserveCurrentTransport || !!pendingTransport) &&
          !bundledNonTag
        ) {
          const renomination = remoteSdp.media.some(
            (media) => media.direction === "inactive",
          );
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
        if (
          remoteMedia.dtlsParams &&
          (!preserveCurrentTransport || !!pendingTransport) &&
          !bundledNonTag
        ) {
          dtlsTransport.setRemoteParams(remoteMedia.dtlsParams);
        }

        // # add ICE candidates
        if (
          (!preserveCurrentTransport || !!pendingTransport) &&
          !bundledNonTag
        ) {
          remoteMedia.iceCandidates.forEach(iceTransport.addRemoteCandidate);
        }

        if (
          remoteMedia.iceCandidatesComplete &&
          (!preserveCurrentTransport || !!pendingTransport) &&
          !bundledNonTag
        ) {
          iceTransport.addRemoteCandidate(undefined);
        }

        if (
          remoteSdp.type === "pranswer" &&
          preserveCurrentTransport &&
          !pendingTransport &&
          !bundledNonTag &&
          iceTransport.hasStagedRestart
        ) {
          provisionalIce.push([iceTransport, remoteMedia]);
        }

        // # set DTLS role
        if (
          (remoteSdp.type === "answer" || remoteSdp.type === "pranswer") &&
          remoteMedia.dtlsParams?.role &&
          !bundledNonTag
        ) {
          dtlsTransport.role =
            remoteMedia.dtlsParams.role === "client" ? "server" : "client";
        }
        return iceTransport;
      }) as RTCIceTransport[];

      // filter out inactive transports
      transports = transports.filter((iceTransport) => !!iceTransport);
      for (const [iceTransport, media] of provisionalIce) {
        await this.applyProvisionalIce(iceTransport, media);
      }

      const removedTransceivers = this.transceiverManager
        .getTransceivers()
        .filter(
          (t) =>
            remoteSdp.media.find((m) => matchTransceiverWithMedia(t, m)) ==
            undefined,
        );

      if (sessionDescription.type === "answer") {
        for (const transceiver of removedTransceivers) {
          // todo: handle answer side transceiver removal work.
          // event should trigger to notify media source to stop.
          transceiver.stopping = true;
          transceiver.stopped = true;
        }
      }

      if (remoteSdp.type === "offer") {
        this.sdpManager.applyRemoteDescription(remoteSdp);
        this.setSignalingState("have-remote-offer");
      } else if (remoteSdp.type === "answer") {
        this.sdpManager.applyRemoteDescription(remoteSdp);
        await this.negotiation.commit();
        this.setSignalingState("stable");
      } else if (remoteSdp.type === "pranswer") {
        this.sdpManager.applyRemoteDescription(remoteSdp);
        this.setSignalingState("have-remote-pranswer");
      }

      await this.flushPendingRemoteCandidates();

      // connect transports
      if (remoteSdp.type === "answer" || remoteSdp.type === "pranswer") {
        log("caller start connect");
        if (remoteSdp.type === "pranswer") {
          this.connectPending().catch((err) =>
            log("pending connect failed", err),
          );
        }
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
    });
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

    const currentRemote = this.sdpManager.currentRemoteDescription;
    const pendingOffer = this.sdpManager.pendingRemoteDescription;
    if (currentRemote && pendingOffer?.type === "offer") {
      const remoteRestart = pendingOffer.media.some((media, index) => {
        const previous = currentRemote.media[index];
        return (
          media.port !== 0 &&
          previous?.iceParams?.usernameFragment &&
          media.iceParams?.usernameFragment !==
            previous.iceParams.usernameFragment
        );
      });
      if (remoteRestart) {
        if (
          this.sctpTransport?.sctp?.associationState === SCTP_STATE.ESTABLISHED
        ) {
          this.secureManager.stageIceRestart();
        } else {
          this.secureManager.rollbackStagedIceRestart();
        }
      }
    }

    await this.preparePendingBundleTopology();

    const description = this.sdpManager.buildAnswerSdp({
      transceivers: this.transceiverManager.getTransceivers(),
      sctpTransport: this.sctpTransport,
      signalingState: this.signalingState,
      transportByMid: this.negotiation.transportByMid,
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
