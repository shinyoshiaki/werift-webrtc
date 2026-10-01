import { randomUUID } from "crypto";
import { BundleTopology } from "./bundleTopology";
import type { RTCDataChannel } from "./dataChannel";
import { DescriptionValidation } from "./descriptionValidation";
import { createWebRtcDomException } from "./errors";
import { EventTarget, enumerate } from "./helper";
import { IceRestartRequest } from "./iceRestartRequest";
import { Event, debug } from "./imports/common";
import {
  type MediaStream,
  type MediaStreamTrack,
  type RTCRtpSender,
  type RTCRtpTransceiver,
  RtpRouter,
  TransceiverManager,
  type TransceiverOptions,
} from "./media";
import {
  type RTCPeerConnectionStats,
  type RTCStats,
  type RTCStatsReport,
  buildStatsReport,
  generateStatsId,
  getStatsTimestamp,
} from "./media/stats";
import { NegotiationNeeded } from "./negotiationNeeded";
import { NegotiationTransaction } from "./negotiationTransaction";
import {
  type PeerConfig,
  type RTCPeerConnectionConfig,
  clonePeerConfiguration,
  generateDefaultPeerConfig,
  mergePeerConfiguration,
} from "./peerConfig";
import {
  type PeerConnectionEventHandlers,
  type RTCDataChannelEvent,
  type RTCPeerConnectionIceEvent,
  RTCTrackEvent,
} from "./peerConnectionEvents";
import { RemoteCandidates, normalizeCandidateUfrag } from "./remoteCandidates";
import { RemoteMediaApplication } from "./remoteMediaApplication";
import { SctpTransportManager } from "./sctpManager";
import { type RTCSessionDescription, SessionDescription } from "./sdp";
import { type RTCSessionDescriptionInit, SDPManager } from "./sdpManager";
import { SecureTransportManager } from "./secureTransportManager";
import type { DtlsRole, RTCDtlsTransport } from "./transport/dtls";
import type {
  IceGathererState,
  RTCIceCandidate,
  RTCIceCandidateInit,
  RTCIceConnectionState,
  RTCIceTransport,
} from "./transport/ice";
import { TransportActivation } from "./transportActivation";
import type { ConnectionState, Kind, RTCSignalingState } from "./types/domain";
import type { Callback, CallbackWithValue } from "./types/util";
import { andDirection } from "./utils";

export {
  type DebugConfig,
  type PeerConfig,
  type RTCBundlePolicy,
  type RTCConfiguration,
  type RTCIceServer,
  type RTCPeerConnectionConfig,
  type RTCRtcpMuxPolicy,
  type RTCSctpConfiguration,
  adoptSenderTrackCodec,
  defaultPeerConfig,
  findCodecByMimeType,
} from "./peerConfig";
export {
  type RTCDataChannelEvent,
  type RTCPeerConnectionIceEvent,
  RTCTrackEvent,
} from "./peerConnectionEvents";

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
  private readonly negotiationNeed = new NegotiationNeeded({
    signalingState: () => this.signalingState,
    isClosed: () => this.isClosed,
    invalidate: () => this.invalidateLastCreatedDescriptions(),
    fire: () => {
      this.onNegotiationneeded.execute();
      if (this.onnegotiationneeded) {
        this.onnegotiationneeded(new globalThis.Event("negotiationneeded"));
      }
      this.emit("negotiationneeded");
    },
  });
  private readonly iceRestartRequest = new IceRestartRequest();

  /** W3C [[NegotiationNeeded]]. */
  get negotiationneeded() {
    return this.negotiationNeed.flag;
  }
  set negotiationneeded(value: boolean) {
    this.negotiationNeed.flag = value;
  }
  /** A `restartIce()` request that no committed negotiation satisfied yet. */
  get needRestart() {
    return this.iceRestartRequest.requested;
  }
  set needRestart(value: boolean) {
    if (value) this.iceRestartRequest.requested = true;
    else this.iceRestartRequest.clear();
  }
  private readonly router = new RtpRouter();
  private readonly sdpManager: SDPManager;
  private readonly transceiverManager: TransceiverManager;
  private readonly sctpManager: SctpTransportManager;
  private readonly secureManager: SecureTransportManager;
  private readonly negotiation: NegotiationTransaction;
  private readonly topology: BundleTopology;
  private readonly remoteCandidates: RemoteCandidates;
  private readonly validator: DescriptionValidation;
  private readonly remoteMedia: RemoteMediaApplication;
  private readonly activation: TransportActivation;
  private isClosed = false;
  private applyingIceRestart = false;
  private descriptionTail: Promise<void> = Promise.resolve();
  private lastCreatedAnswer?: RTCSessionDescription;
  /** Reusable by a parameterless setLocalDescription while still valid. */
  private lastCreatedOffer?: RTCSessionDescription;
  /**
   * W3C [[LastCreatedOffer]]: the SDP of this peer's latest createOffer. Only
   * createOffer replaces it; an explicit local offer must match it.
   */
  private createdOfferSdp?: string;

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
    this.negotiation = new NegotiationTransaction(
      this.sdpManager,
      this.transceiverManager,
      this.router,
      this.sctpManager,
    );
    this.topology = new BundleTopology(
      this.sdpManager,
      this.transceiverManager,
      this.sctpManager,
      this.negotiation,
      () => this.findOrCreateTransport(true),
    );
    this.remoteMedia = new RemoteMediaApplication(
      this.sdpManager,
      this.transceiverManager,
      this.sctpManager,
      this.router,
      this.negotiation,
      {
        createSctpTransport: () => this.createSctpTransport(),
        createTransport: () => this.findOrCreateTransport(),
        createOwnerTransport: () => this.createOwnerTransport(),
        onRemoteTransceiverAdded: (transceiver) =>
          this.onRemoteTransceiverAdded.execute(transceiver),
      },
    );
    this.validator = new DescriptionValidation(
      this.config,
      this.sdpManager,
      this.transceiverManager,
      this.sctpManager,
      this.negotiation,
      this.topology,
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
    this.remoteCandidates = new RemoteCandidates(
      this.sdpManager,
      this.secureManager,
      this.negotiation,
      this.topology,
      {
        signalingState: () => this.signalingState,
        hasRemoteDescription: () =>
          !!this.remoteDescription && !!this.sdpManager._remoteDescription,
      },
    );
    this.activation = new TransportActivation(
      this.sdpManager,
      this.secureManager,
      this.transceiverManager,
      this.sctpManager,
      this.negotiation,
      this.topology,
      {
        signalingState: () => this.signalingState,
        createTransport: () => this.findOrCreateTransport(),
      },
    );
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
    const isReconfiguration = !!this.sdpManager;
    const normalizedConfig = mergePeerConfiguration(this.config, config, {
      isReconfiguration,
      hasLocalDescription: isReconfiguration && !!this.localDescription,
      hasSctpTransport: !!this.sctpManager?.sctpTransport,
    });

    if (this.sctpManager?.sctpTransport) {
      this.sctpManager.sctpTransport.maxMessageSize =
        this.config.maxMessageSize;
    }

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

  /**
   * W3C operations chain: createOffer runs after every earlier description
   * operation, so an offer it produces cannot invalidate a setLocalDescription
   * that was called before it.
   */
  createOffer(options: { iceRestart?: boolean } = {}) {
    return this.enqueueDescriptionOperation(() => this.createOfferNow(options));
  }

  /** createOffer body; call directly only from inside a queued operation. */
  private async createOfferNow({ iceRestart }: { iceRestart?: boolean } = {}) {
    // Transports prepared for an applied pending offer stay until that offer
    // is replaced or rolled back; setLocalDescription stages new ones first.
    if (this.signalingState === "stable") this.negotiation.snapshotForOffer();
    const restartRequested = !!iceRestart || this.needRestart;
    if (restartRequested) {
      if (
        this.sdpManager.currentLocalDescription &&
        this.sdpManager.currentRemoteDescription
      ) {
        this.secureManager.stageIceRestart();
      } else {
        // No current credentials to replace: fresh ones satisfy restartIce().
        this.iceRestartRequest.clear();
        this.secureManager.restartIce();
      }
    } else if (
      ["stable", "have-local-offer", "have-remote-pranswer"].includes(
        this.signalingState,
      )
    ) {
      // An applied pending offer keeps its restart credentials until it is
      // answered, replaced or rolled back; credentials staged for an answer
      // (have-remote-offer) are not the offerer's to discard.
      this.secureManager.discardUnappliedIceRestart();
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
    this.createdOfferSdp = createdOffer.sdp;
    this.negotiationNeed.noteCreatedOffer();
    return createdOffer;
  }

  private createSctpTransport() {
    const sctp = this.sctpManager.createSctpTransport(
      this.config.maxMessageSize,
      this.config.sctp,
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
    if (this.transceiverManager.removeTrack(sender)) {
      this.needNegotiation();
    }
  }

  /**交渉が必要な変更を記録し、negotiationneeded を予約する */
  private needNegotiation = () => {
    this.negotiationNeed.change();
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
    this.negotiation.noteCreatedTransport(dtlsTransport);
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

      const owner = this.resolveLocalCandidateOwner(iceTransport);
      if (!owner) {
        // 停止 / 拒否した m-line だけが使う transport の候補は通知しない
        log("no accepted m-line owns the ice transport", iceTransport.id);
        return;
      }
      this.secureManager.handleNewIceCandidate({
        candidate,
        sdpMid: owner.mid,
        sdpMLineIndex: owner.index,
      });
    });

    return dtlsTransport;
  }

  /**Resolve candidate metadata from an accepted m-line that owns this transport. */
  private resolveLocalCandidateOwner(iceTransport: RTCIceTransport) {
    const description = this._localDescription;
    if (!description) return;
    const owners = description.media
      .map((media, index) => ({ media, index }))
      .filter(({ media }) => {
        if (media.port === 0) return false;
        const mid = media.rtp.muxId;
        if (media.kind === "application") {
          return (
            !!this.sctpTransport &&
            this.sctpTransport.mid === mid &&
            this.sctpTransport.dtlsTransport?.iceTransport.id ===
              iceTransport.id
          );
        }
        const transceiver = this.transceiverManager
          .getTransceivers()
          .find((t) => t.mid === mid && !t.stopped);
        return transceiver?.dtlsTransport?.iceTransport.id === iceTransport.id;
      });
    const tags = description.group
      .filter((group) => group.semantic === "BUNDLE")
      .map((group) => group.items[0]);
    const owner =
      owners.find(({ media }) => tags.includes(media.rtp.muxId!)) ?? owners[0];
    if (!owner) return;
    return { mid: owner.media.rtp.muxId, index: owner.index };
  }

  /**
   * answer 確定後の stopping transceiver を整理する。
   * @returns port 0 を自分の offer で交渉すべき transceiver が残っているか
   */
  private settleStoppingTransceivers() {
    const negotiatedMids = new Set(
      (this.sdpManager.currentLocalDescription?.media ?? [])
        .filter((media) => media.port !== 0 && media.rtp.muxId)
        .map((media) => media.rtp.muxId!),
    );
    const pending =
      this.transceiverManager.settleStoppingTransceivers(negotiatedMids);
    this.closeIdleTransports();
    return pending;
  }

  /**停止した transceiver の transport のうち、live な利用者がいないものを閉じる */
  private closeIdleTransports(
    candidates: (RTCDtlsTransport | undefined)[] = this.transceiverManager
      .getTransceivers()
      .filter((t) => t.stopped)
      .map((t) => t.dtlsTransport),
  ) {
    const live = new Set(this.dtlsTransports.map((t) => t.id));
    for (const transport of this.negotiation.transportByMid.values()) {
      live.add(transport.id);
    }
    for (const transport of new Set(candidates)) {
      if (
        !transport ||
        transport.state === "closed" ||
        live.has(transport.id)
      ) {
        continue;
      }
      transport.stop().catch((error) => {
        log("failed to close idle transport", error);
      });
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
        await this.activation.cleanupInitialProvisional();
        this.setSignalingState("stable");
        this.negotiationNeed.discardPendingOffer();
        // An unsatisfied restartIce() request makes negotiation needed again.
        if (this.negotiationNeed.recheck || this.needRestart) {
          this.negotiationNeed.schedule();
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
          ? (this.lastCreatedOffer ?? (await this.createOfferNow()))
          : sessionDescription?.type === "answer" ||
              sessionDescription?.type === "pranswer"
            ? (this.lastCreatedAnswer ?? (await this.createAnswerNow()))
            : implicitOfferState.includes(this.signalingState)
              ? (this.lastCreatedOffer ?? (await this.createOfferNow()))
              : (this.lastCreatedAnswer ?? (await this.createAnswerNow()))
        : undefined;

      sessionDescription = {
        type: sessionDescription?.type ?? generatedDescription!.type,
        sdp:
          sessionDescription?.sdp && sessionDescription.sdp.length > 0
            ? sessionDescription.sdp
            : generatedDescription!.sdp,
      };

      // W3C setLocalDescription: an offer must be the last one this peer's
      // createOffer produced. A peer that never created an offer accepts none,
      // so an offer from another peer and local SDP munging (codec,
      // direction, BUNDLE, ICE) are refused before any transaction or live
      // state is touched.
      if (
        sessionDescription.type === "offer" &&
        sessionDescription.sdp !== this.createdOfferSdp
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
      this.validator.validateLocal(description);
      // Stage the offer's transports before retiring anything pending.
      const stagedOfferTopology =
        description.type === "offer"
          ? await this.topology.stageLocalOffer(description)
          : undefined;
      // The offer being applied was created with these MID / m-line
      // assignments. Replacing the pending offer or rolling back a remote
      // pranswer restores the baseline first, so they are re-applied after.
      const offeredMids = new Set(
        description.media.map((media) => media.rtp.muxId),
      );
      const offerAssignments =
        description.type === "offer"
          ? this.transceiverManager
              .getTransceivers()
              .filter((t) => t.mid && offeredMids.has(t.mid))
              .map((t) => [t, t.mid, t.mLineIndex] as const)
          : [];
      try {
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
          await this.activation.cleanupInitialProvisional();
          this.setSignalingState("stable");
        }
        if (description.type === "offer") {
          if (this.signalingState === "have-local-offer") {
            await this.negotiation.replace();
            this.sdpManager.pendingLocalDescription = undefined;
          } else {
            this.negotiation.begin({ fromCreatedOffer: true });
          }
          for (const [transceiver, mid, mLineIndex] of offerAssignments) {
            transceiver.mid = mid;
            transceiver.mLineIndex = mLineIndex;
          }
        }
        this.negotiation.validate();
        this.negotiation.prepare();
        if (stagedOfferTopology) {
          this.topology.installLocalOffer(description, stagedOfferTopology);
        }
      } catch (error) {
        // Staged transports not yet owned by the transaction are stopped.
        await Promise.allSettled(
          (stagedOfferTopology ?? [])
            .filter(
              ({ transport, pendingOnly }) =>
                pendingOnly &&
                !this.negotiation.isPendingOnlyTransport(
                  transport.iceTransport.id,
                ),
            )
            .map(({ transport }) => transport.stop()),
        );
        throw error;
      }

      if (
        description.type === "answer" &&
        this.sdpManager.currentRemoteDescription
      ) {
        this.topology.applyPending();
        await this.commitStagedIceRestart();
        await this.activation.activatePendingRemote();
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
        await this.activation.activatePendingRemote(true);
      }

      // # assign MID
      for (const [i, media] of enumerate(description.media)) {
        const mid = media.rtp.muxId!;
        this.sdpManager.registerMid(mid);
        if (["audio", "video"].includes(media.kind) && media.port !== 0) {
          // 停止済み、別 kind、別 MID の transceiver には割り当てない (MID の一意性を保つ)
          const transceiver = this.transceiverManager
            .getTransceivers()
            .find(
              (t) =>
                t.mLineIndex === i &&
                !t.stopped &&
                t.kind === media.kind &&
                (t.mid == null || t.mid === mid),
            );
          if (transceiver) {
            transceiver.mid = mid;
          }
        }
        if (media.kind === "application" && this.sctpTransport) {
          this.sctpTransport.mid = mid;
        }
      }

      // setup ice,dtls role. Each transport takes the role of its own m-line:
      // a BUNDLE split owner is a new association whose role can differ from
      // the transport the first m-line keeps.
      const fallbackRole = description.media.find((media) => media.dtlsParams)
        ?.dtlsParams?.role;
      const roleByTransport = new Map<RTCDtlsTransport, DtlsRole>();
      for (const media of description.media) {
        const transport = this.topology.currentTransportForMid(
          media.rtp.muxId ?? "",
        );
        const role = media.dtlsParams?.role;
        if (transport && role && !roleByTransport.has(transport)) {
          roleByTransport.set(transport, role);
        }
      }

      this.secureManager.setLocalRole({
        type: description.type === "offer" ? "offer" : "answer",
        // A transport without an m-line of its own here only takes the
        // fallback while it has no role yet; an established association
        // (such as a BUNDLE split owner) keeps its role.
        role: (transport) =>
          roleByTransport.get(transport) ??
          (transport.role === "auto" ? fallbackRole : undefined),
      });

      // # configure direction
      if (["answer", "pranswer"].includes(description.type)) {
        // Only transceivers with an m-line in this answer are negotiated; one
        // the application added after the offer stays without a direction.
        const answeredMids = new Set(
          description.media.map((media) => media.rtp.muxId),
        );
        for (const t of this.transceiverManager.getTransceivers()) {
          if (!t.mid || !answeredMids.has(t.mid)) continue;
          if (t.stopped || t.pendingRejection) continue;
          const direction = t.stopping
            ? "inactive"
            : andDirection(t.direction, t.offerDirection);
          t.setCurrentDirection(direction);
        }
      }
      if (description.type === "answer") {
        // answer の確定で拒否予定の m-line を停止し、RTP pipeline を解放する
        this.transceiverManager.commitRemoteOffer();
        // port 0 で答えた m-line (aggressive の inactive など) は offerer 側で拒否として
        // 停止が確定する。answerer 側も同じ位置を停止確定にし、offerer が新 MID で再利用できるようにする
        for (const media of description.media) {
          if (!["audio", "video"].includes(media.kind) || media.port !== 0) {
            continue;
          }
          const transceiver = this.transceiverManager
            .getTransceivers()
            .find((t) => t.mid === media.rtp.muxId && !t.stopped);
          transceiver?.commitStopped({ rejected: true });
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
        this.secureManager.markStagedIceRestartApplied();
        this.negotiation.settle();
        // この offer は作成時点までの変更を含む。answer の適用で交渉済みにする
        this.negotiationNeed.noteAppliedOffer();
        this.setSignalingState("have-local-offer");
      } else if (description.type === "answer") {
        this.setSignalingState("stable");
      } else if (description.type === "pranswer") {
        // The final answer reuses the restart credentials this pranswer
        // already signalled.
        this.secureManager.markStagedIceRestartApplied();
        this.negotiation.settle();
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
          this.activation
            .connectPending()
            .catch((err) => log("pending connect failed", err));
        }
        this.activation.connect().catch((err) => {
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

      if (description.type === "answer")
        this.iceRestartRequest.settle(this.sdpManager.currentLocalDescription);
      // answerer の stop() は次の自分の offer で交渉する
      const hasUnnegotiatedStop =
        description.type === "answer" && this.settleStoppingTransceivers();
      if (this.negotiationNeed.recheck || hasUnnegotiatedStop) {
        this.negotiationNeed.schedule();
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

  async addIceCandidate(
    candidateMessage: RTCIceCandidate | RTCIceCandidateInit | null = {},
  ) {
    return this.enqueueDescriptionOperation(async () => {
      if (this.isClosed) {
        throw createWebRtcDomException("InvalidStateError", "is closed");
      }

      candidateMessage = normalizeCandidateUfrag(candidateMessage);
      if (!this.remoteDescription || !this.sdpManager._remoteDescription) {
        const ufrag = candidateMessage?.usernameFragment;
        if (this.negotiation.isRetiredRemoteUfrag(ufrag)) {
          throw createWebRtcDomException(
            "OperationError",
            "ICE generation was rolled back or replaced",
          );
        }
        this.remoteCandidates.queued.push(candidateMessage);
        return;
      }
      await this.remoteCandidates.apply(candidateMessage);
    });
  }

  restartIce() {
    this.iceRestartRequest.request(
      this.sdpManager.currentLocalDescription,
      this.sdpManager.pendingLocalDescription,
    );
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
        await this.activation.cleanupInitialProvisional();
        this.setSignalingState("stable");
        this.negotiationNeed.discardPendingOffer();
        if (this.negotiationNeed.recheck || this.needRestart) {
          this.negotiationNeed.schedule();
        }
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
      this.validator.validateRemote(remoteSdp, this.signalingState);

      // Queued candidates are placed against the parsed proposal before any
      // state changes or application events (track, transceiver) fire.
      // Only a non-empty queue awaits, so ordinary offers keep their timing.
      if (this.remoteCandidates.queued.length > 0) {
        await this.remoteCandidates.validateQueued(remoteSdp);
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
        await this.activation.cleanupInitialProvisional();
        this.negotiationNeed.discardPendingOffer();
        this.negotiationNeed.recheck = true;
        this.setSignalingState("stable");
        // The implicit rollback's "stable" is observable on its own: yield a
        // task so handlers run before the offer moves to have-remote-offer.
        await new Promise<void>((resolve) => setImmediate(resolve));
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

      // Pre-validation rejects every known failure before this point. Should
      // applying still throw, undo this operation's own changes so no partial
      // application stays. An offer rolls its transaction back to stable (a
      // replacement offer has already released the previous proposal); an
      // answer or pranswer returns to the checkpoint of its pending offer.
      const openedHere = remoteSdp.type === "offer";
      const checkpoint = this.negotiation.checkpoint();
      try {
        if (remoteSdp.type === "answer" || remoteSdp.type === "pranswer") {
          this.negotiation.discardStagedRemoteAnswer();
        }
        if (remoteSdp.type === "answer") {
          this.topology.applyPending();
        }

        const {
          preserveCurrentTransport,
          transportUpdates,
          endOfCandidates,
          provisionalIce,
          associated,
        } = this.remoteMedia.apply(remoteSdp);

        if (remoteSdp.type === "answer") {
          // The final answer switches a staged ICE restart only now, after
          // every fallible step, and before its remote ICE parameters apply.
          // Only the generation the applied offer carries is switched.
          this.secureManager.discardUnappliedIceRestart();
          await this.commitStagedIceRestart();
        }
        for (const update of transportUpdates) update();
        for (const iceTransport of new Set(endOfCandidates)) {
          iceTransport.addRemoteCandidate(undefined);
        }
        if (preserveCurrentTransport) {
          await this.remoteCandidates.deliverSameGenerationDescription(
            remoteSdp,
          );
        }
        // A description that repeats an ICE generation which already ended
        // on its transport records that end too, so it cannot become current
        // promising candidates the live transport no longer accepts.
        this.remoteCandidates.completeSharedTransportMedia(
          remoteSdp,
          remoteSdp.media.map((_, index) => index),
        );
        for (const [iceTransport, media] of provisionalIce) {
          await this.activation.applyProvisionalIce(iceTransport, media);
        }

        if (remoteSdp.type === "answer") {
          // answer に含まれない既存 m-line は remote 起因の停止として確定する
          for (const transceiver of this.transceiverManager.getTransceivers()) {
            if (
              !associated.has(transceiver) &&
              transceiver.mid != undefined &&
              !transceiver.stopped
            ) {
              transceiver.commitStopped({ rejected: true });
            }
          }
        }
      } catch (error) {
        if (openedHere) {
          this.secureManager.rollbackStagedIceRestart();
          await this.negotiation.rollback();
          await this.activation.cleanupInitialProvisional();
          if (this.signalingState !== "stable")
            this.setSignalingState("stable");
        } else {
          await this.negotiation.restoreCheckpoint(checkpoint);
        }
        throw error;
      }

      if (remoteSdp.type === "offer") {
        this.sdpManager.applyRemoteDescription(remoteSdp);
        this.negotiation.settle();
        this.setSignalingState("have-remote-offer");
      } else if (remoteSdp.type === "answer") {
        this.sdpManager.applyRemoteDescription(remoteSdp);
        await this.negotiation.commit();
        this.setSignalingState("stable");
      } else if (remoteSdp.type === "pranswer") {
        this.sdpManager.applyRemoteDescription(remoteSdp);
        this.negotiation.settle();
        this.setSignalingState("have-remote-pranswer");
      }

      await this.remoteCandidates.flushQueued();

      // connect transports
      if (remoteSdp.type === "answer" || remoteSdp.type === "pranswer") {
        log("caller start connect");
        if (remoteSdp.type === "pranswer") {
          this.activation
            .connectPending()
            .catch((err) => log("pending connect failed", err));
        }
        this.activation.connect().catch((err) => {
          log("connect failed", err);
          this.secureManager.setConnectionState("failed");
        });
      }

      this.negotiationneeded = false;
      if (remoteSdp.type === "answer") {
        // 確定した local offer が反映していた変更は交渉済みになる
        this.negotiationNeed.commitPendingOffer();
      }
      if (remoteSdp.type === "answer")
        this.iceRestartRequest.settle(this.sdpManager.currentLocalDescription);
      const hasUnnegotiatedStop =
        remoteSdp.type === "answer" && this.settleStoppingTransceivers();
      if (this.negotiationNeed.recheck || hasUnnegotiatedStop) {
        this.negotiationNeed.schedule();
      }
      this.invalidateLastCreatedDescriptions();
    });
  }

  /**
   * remote description の transport 所有で使う独立 transport (別 ICE credentials) を作る。
   * rollback で使われなくなれば transaction が閉じる。
   */
  private createOwnerTransport() {
    const transport = this.findOrCreateTransport(true);
    this.negotiation.rememberOwnerTransport(transport);
    return transport;
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

  /** W3C operations chain: createAnswer is ordered with SLD/SRD calls. */
  createAnswer() {
    return this.enqueueDescriptionOperation(() => this.createAnswerNow());
  }

  /** createAnswer body; call directly only from inside a queued operation. */
  private async createAnswerNow() {
    this.assertNotClosed();

    await this.secureManager.ensureCerts();

    const currentRemote = this.sdpManager.currentRemoteDescription;
    const pendingOffer = this.sdpManager.pendingRemoteDescription;
    if (currentRemote && pendingOffer?.type === "offer") {
      // An ICE restart keeps the DTLS association (RFC 8842): stage the new
      // generation on the existing ICE transport of each BUNDLE owner whose
      // credentials changed. A MID that moves to a new owner (BUNDLE split)
      // brings its credentials to its own pending transport instead, so the
      // transport it leaves is not restarted.
      const restarted = new Set<RTCIceTransport>();
      for (const [owner, plan] of this.topology.planPending(pendingOffer)
        .owners) {
        const live = plan.reuse?.iceTransport;
        const proposed = pendingOffer.media.find(
          (media) => media.rtp.muxId === owner,
        )?.iceParams?.usernameFragment;
        const committed = live?.getRemoteParameters()?.usernameFragment;
        if (live && proposed && committed && proposed !== committed) {
          restarted.add(live);
        }
      }
      this.secureManager.stageIceRestart(restarted);
    }

    await this.topology.preparePending();

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
    this.remoteCandidates.queued.length = 0;
    this.setSignalingState("closed");

    this.transceiverManager.close();

    // SCTP ABORT は DTLS/ICE が生きている間に送る（close は abrupt であり SHUTDOWN ではない）
    await this.sctpManager.close();
    this.negotiation.dispose();
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

export interface RTCLocalSessionDescriptionInit
  extends RTCSessionDescriptionInit {
  type?: Exclude<RTCSessionDescriptionInit["type"], "rollback"> | "rollback";
}
