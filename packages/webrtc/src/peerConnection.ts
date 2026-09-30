import { randomUUID } from "crypto";
import { SCTP_STATE } from "../../sctp/src";

import { DEFAULT_SCTP_MTU, validateSctpMtu } from "../../sctp/src";
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
  negotiateRemoteCodecs,
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
  type GroupDescription,
  type MediaDescription,
  type RTCSessionDescription,
  SessionDescription,
} from "./sdp";
import {
  type MLineReuse,
  type RTCSessionDescriptionInit,
  SDPManager,
} from "./sdpManager";
import { SecureTransportManager } from "./secureTransportManager";
import type {
  DtlsKeys,
  DtlsRole,
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

/**
 * The ICE generation of a candidate is its ufrag, given either as the
 * `usernameFragment` property or as the `ufrag` token of the candidate
 * string. Both forms route the same way; conflicting values are rejected.
 */
function normalizeCandidateUfrag(
  message: RTCIceCandidate | RTCIceCandidateInit | null,
): RTCIceCandidate | RTCIceCandidateInit | null {
  if (!message) return message;
  const fromString = message.candidate?.match(/\bufrag\s+(\S+)/)?.[1];
  const fromProperty = message.usernameFragment ?? undefined;
  if (fromString && fromProperty && fromString !== fromProperty) {
    throw createWebRtcDomException(
      "OperationError",
      "Candidate ufrag does not match usernameFragment",
    );
  }
  if (!fromString || fromProperty) return message;
  const init = "toJSON" in message ? message.toJSON() : { ...message };
  return { ...init, usernameFragment: fromString };
}

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
  /**
   * W3C [[LocalIceCredentialsToReplace]]: local ufrags of the current and the
   * pending local description when `restartIce()` was called. The request stays until a negotiation commits
   * local credentials outside this set (rollback or glare keep it).
   */
  private iceCredentialsToReplace = new Set<string>();
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
  /**同じ tick の複数の変更で negotiationneeded を重複発火しないための予約フラグ */
  private negotiationneededScheduled = false;
  /**交渉が必要な変更の通し番号 */
  private negotiationChangeSeq = 0;
  /**answer まで確定した local offer が反映している変更の通し番号 */
  private negotiatedChangeSeq = 0;
  /**適用中の local offer が反映している変更の通し番号 (rollback で破棄) */
  private pendingOfferChangeSeq?: number;
  /**最後に作った offer が反映している変更の通し番号 */
  private createdOfferChangeSeq = 0;
  private lastCreatedAnswer?: RTCSessionDescription;
  /** Reusable by a parameterless setLocalDescription while still valid. */
  private lastCreatedOffer?: RTCSessionDescription;
  /**
   * W3C [[LastCreatedOffer]]: the SDP of this peer's latest createOffer. Only
   * createOffer replaces it; an explicit local offer must match it.
   */
  private createdOfferSdp?: string;
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
      normalizedConfig.mLineReuse !== undefined &&
      !MLineReuseModes.includes(normalizedConfig.mLineReuse)
    ) {
      throw createWebRtcTypeError(
        `mLineReuse must be one of ${MLineReuseModes.join(", ")}`,
      );
    }

    if (
      isReconfiguration &&
      normalizedConfig.mLineReuse !== undefined &&
      normalizedConfig.mLineReuse !== this.config.mLineReuse
    ) {
      throw createWebRtcDomException(
        "InvalidModificationError",
        "mLineReuse cannot be changed",
      );
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

    if (normalizedConfig.sctp !== undefined) {
      const requestedSctpMtu = normalizedConfig.sctp.mtu ?? DEFAULT_SCTP_MTU;
      validateSctpMtu(requestedSctpMtu);
      if (
        this.sctpManager?.sctpTransport &&
        requestedSctpMtu !== this.config.sctp.mtu
      ) {
        throw new Error(
          "sctp.mtu cannot be changed after SCTP transport creation",
        );
      }
    }

    deepMerge(this.config, normalizedConfig as Partial<PeerConfig>);
    this.config.sctp = {
      mtu: this.config.sctp?.mtu ?? DEFAULT_SCTP_MTU,
    };

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
        this.needRestart = false;
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
    this.createdOfferChangeSeq = this.negotiationChangeSeq;
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
    this.negotiationChangeSeq++;
    this.scheduleNegotiationneeded();
  };

  /**未交渉の変更が残っていれば negotiationneeded を予約する (stable 復帰時の再判定にも使う) */
  private scheduleNegotiationneeded() {
    this.invalidateLastCreatedDescriptions();
    this.shouldNegotiationneeded = true;
    if (
      this.negotiationneeded ||
      this.negotiationneededScheduled ||
      this.signalingState !== "stable"
    ) {
      return;
    }
    this.shouldNegotiationneeded = false;
    this.negotiationneededScheduled = true;
    setImmediate(() => {
      this.negotiationneededScheduled = false;
      if (this.isClosed) return;
      if (this.negotiatedChangeSeq >= this.negotiationChangeSeq) {
        // 発火前に適用された local offer が変更をすべて含んでいる
        return;
      }
      if (this.signalingState !== "stable") {
        // stable に戻った時点で改めて判定する
        this.shouldNegotiationneeded = true;
        return;
      }
      this.negotiationneeded = true;
      this.onNegotiationneeded.execute();
      if (this.onnegotiationneeded) {
        this.onnegotiationneeded(new globalThis.Event("negotiationneeded"));
      }
      this.emit("negotiationneeded");
    });
  }

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
        await this.cleanupInitialProvisionalTransport();
        this.setSignalingState("stable");
        this.pendingOfferChangeSeq = undefined;
        // An unsatisfied restartIce() request makes negotiation needed again.
        if (this.shouldNegotiationneeded || this.needRestart) {
          this.scheduleNegotiationneeded();
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
      for (const media of description.media) {
        if (media.port === 0 || !media.iceParams) continue;
        const prepared =
          media.rtp.muxId &&
          this.negotiation.transportByMid.get(media.rtp.muxId);
        const live =
          media.kind === "application"
            ? this.sctpTransport?.dtlsTransport
            : this.transceiverManager
                .getTransceivers()
                .find((transceiver) => transceiver.mid === media.rtp.muxId)
                ?.dtlsTransport;
        const matches = (transport?: RTCDtlsTransport) =>
          transport?.iceTransport.localParameters.usernameFragment ===
            media.iceParams!.usernameFragment &&
          transport.iceTransport.localParameters.password ===
            media.iceParams!.password;
        // An answer must use the transport prepared for it. A (replacement)
        // offer is built from the live transports; re-applying the previous
        // pending offer may carry its prepared credentials instead.
        const acceptable =
          description.type === "offer"
            ? [prepared, live].filter(Boolean)
            : [prepared || live].filter(Boolean);
        if (
          acceptable.length > 0 &&
          !acceptable.some((transport) => matches(transport || undefined))
        ) {
          throw createWebRtcDomException(
            "InvalidModificationError",
            "Local SDP must use prepared ICE credentials",
          );
        }
        // Like a remote one, a local answer or pranswer keeps the DTLS role
        // of a live association (RFC 8842 section 5.5); an edited a=setup is
        // refused before it can change the running transport.
        const bundledNonTag = this.isBundledNonTag(
          description,
          media.rtp.muxId,
        );
        const localRole = media.dtlsParams?.role;
        if (
          description.type !== "offer" &&
          !bundledNonTag &&
          localRole &&
          localRole !== "auto" &&
          live &&
          (!prepared || prepared === live) &&
          ["connecting", "connected"].includes(live.state) &&
          live.role !== "auto" &&
          live.role !== localRole
        ) {
          throw createWebRtcDomException(
            "InvalidModificationError",
            "Changing the DTLS role of a connected association is unsupported",
          );
        }
      }
      // Stage the offer's transports before retiring anything pending.
      const stagedOfferTopology =
        description.type === "offer"
          ? await this.stageLocalOfferTopology(description)
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
          await this.cleanupInitialProvisionalTransport();
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
          this.installLocalOfferTopology(description, stagedOfferTopology);
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
        const transport = this.currentTransportForMid(media.rtp.muxId ?? "");
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
        this.pendingOfferChangeSeq = this.createdOfferChangeSeq;
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

      if (description.type === "answer") this.settleIceRestartRequest();
      // answerer の stop() は次の自分の offer で交渉する
      const hasUnnegotiatedStop =
        description.type === "answer" && this.settleStoppingTransceivers();
      if (this.shouldNegotiationneeded || hasUnnegotiatedStop) {
        this.scheduleNegotiationneeded();
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

  /**
   * Local codecs `setRemoteRTP` will negotiate an m-line against, including a
   * sender track codec it adopts, without mutating the configuration.
   */
  private localCodecsFor(media: MediaDescription) {
    const kind = media.kind as "audio" | "video";
    const trackCodec = this.transceiverManager
      .getTransceivers()
      .find((t) => t.mid === media.rtp.muxId)?.sender.track?.codec;
    return [
      ...(this.config.codecs[kind] ?? []),
      ...(trackCodec && trackCodec.mimeType.split("/")[0].toLowerCase() === kind
        ? [trackCodec]
        : []),
    ];
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
      const bundledNonTag = this.isBundledNonTag(offer, media.rtp.muxId);
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

  /**
   * Prepare the transports a local offer needs without touching the pending
   * transaction. A replacement offer is staged here first, so a failure (for
   * example ICE gathering of a new BUNDLE owner) stops only what was staged
   * and leaves the previous pending offer, its transports and the signaling
   * state as they were.
   */
  private async stageLocalOfferTopology(offer: SessionDescription) {
    const ownerByMid = new Map<string, string>();
    for (const media of offer.media) {
      if (media.port === 0 || !media.rtp.muxId) continue;
      ownerByMid.set(
        media.rtp.muxId,
        this.bundleTagOf(offer, media.rtp.muxId) ?? media.rtp.muxId,
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

    // Select one transport per proposed owner, starting with the transport
    // already bound to the BUNDLE tag. Every member then follows that owner.
    const ownerTransport = new Map<
      string,
      { transport: RTCDtlsTransport; pendingOnly: boolean }
    >();
    const used = new Set<RTCDtlsTransport>();
    const created: RTCDtlsTransport[] = [];
    try {
      for (const owner of new Set(ownerByMid.values())) {
        let transport = currentByMid.get(owner);
        let pendingOnly = false;
        if (!transport || used.has(transport)) {
          transport = this.findOrCreateTransport(true);
          created.push(transport);
          pendingOnly = true;
          await transport.iceTransport.gather();
        }
        used.add(transport);
        ownerTransport.set(owner, { transport, pendingOnly });
      }
    } catch (error) {
      await Promise.allSettled(created.map((transport) => transport.stop()));
      throw error;
    }

    return [...ownerByMid].map(([mid, owner]) => ({
      mid,
      ...ownerTransport.get(owner)!,
    }));
  }

  /** Hand staged local-offer transports to the pending transaction. */
  private installLocalOfferTopology(
    offer: SessionDescription,
    staged: Awaited<ReturnType<RTCPeerConnection["stageLocalOfferTopology"]>>,
  ) {
    for (const { mid, transport, pendingOnly } of staged) {
      if (pendingOnly) {
        this.negotiation.prepareTransport(offer, mid, transport, true);
      }
      this.negotiation.prepareTransport(offer, mid, transport);
    }
  }

  /**
   * Decide which live transport each proposed BUNDLE owner of a re-offer would
   * reuse. `undefined` means the owner needs a new pending transport.
   */
  private planPendingBundleTopology(offer: SessionDescription) {
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
        this.bundleTagOf(offer, media.rtp.muxId) ?? media.rtp.muxId,
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
    // An ICE restart alone keeps the owner's DTLS transport; its new ICE
    // generation is staged on that transport's ICE connection.
    const owners = new Map<string, { reuse?: RTCDtlsTransport }>();
    const used = new Set<RTCDtlsTransport>();
    for (const owner of new Set(ownerByMid.values())) {
      const transport = currentByMid.get(owner);
      if (!transport || used.has(transport)) {
        owners.set(owner, {});
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

      candidateMessage = normalizeCandidateUfrag(candidateMessage);
      if (!this.remoteDescription || !this.sdpManager._remoteDescription) {
        const ufrag = candidateMessage?.usernameFragment;
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
    // The generation is decided by the m-line the candidate targets: with a
    // partial BUNDLE split one m-line may keep the current ufrag while another
    // moves to a new one within the same pending description.
    const sdpMid = candidateMessage?.sdpMid;
    const sdpMLineIndex = candidateMessage?.sdpMLineIndex;
    const targetMedia = (description: SessionDescription) =>
      typeof sdpMid === "string"
        ? description.media.filter((media) => media.rtp.muxId === sdpMid)
        : typeof sdpMLineIndex === "number"
          ? description.media.slice(sdpMLineIndex, sdpMLineIndex + 1)
          : description.media;
    const matchesUfrag = (description: SessionDescription) =>
      targetMedia(description).some(
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
      if (current) {
        await this.deliverSameGenerationCandidate(
          remoteDescription,
          current,
          appliedCandidate,
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
      // A pending SDP becomes current at the answer, so it is aligned too.
      this.completeSharedTransportMedia(
        remoteDescription,
        appliedCandidate.mediaIndices,
      );
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

  /**
   * A re-offer or pranswer that keeps the current transports may still carry
   * new candidates or end-of-candidates for an m-line whose ufrag is
   * unchanged. They belong to the live generation too, so they reach the live
   * checklist and the current SDP (once, and not after its end-of-candidates),
   * exactly like trickled ones. A pending-only transport receives its own.
   */
  private async deliverSameGenerationDescription(proposal: SessionDescription) {
    const current = this.sdpManager.currentRemoteDescription;
    if (!current) return;
    const shared = [...proposal.media.entries()].filter(([, media]) => {
      if (media.port === 0) return false;
      const prepared = this.negotiation.transportByMid.get(
        media.rtp.muxId ?? "",
      );
      return !(
        prepared &&
        this.negotiation.isPendingOnlyTransport(prepared.iceTransport.id)
      );
    });
    // Candidates first (a non-tag BUNDLE member carries none of its own),
    // then end-of-candidates from any m-line, since it ends the shared
    // generation for the whole group.
    for (const [index, media] of shared) {
      if (this.isBundledNonTag(proposal, media.rtp.muxId)) continue;
      for (const candidate of media.iceCandidates) {
        await this.deliverSameGenerationCandidate(proposal, current, {
          kind: "candidate",
          candidate,
          mediaIndices: [index],
        });
      }
    }
    for (const [index, media] of shared) {
      if (!media.iceCandidatesComplete) continue;
      await this.deliverSameGenerationCandidate(proposal, current, {
        kind: "end-of-candidates",
        mediaIndices: [index],
      });
    }
  }

  /**
   * A candidate trickled for a pending re-offer whose m-line keeps the current
   * ufrag belongs to the live ICE generation as well. Besides the pending SDP,
   * it is recorded in the current SDP and handed to the live checklist once,
   * so the committed session can use it while the proposal is pending.
   */
  /**
   * End-of-candidates ends an ICE generation on its transport, not one
   * m-line: every m-line of `sdp` on the same finished transport with the
   * same ufrag as `completed` (the rest of its BUNDLE group) is marked
   * complete, so the SDP never promises more candidates to it.
   */
  private completeSharedTransportMedia(
    sdp: SessionDescription,
    completed: number[],
  ) {
    const generations = completed
      .map((index) => {
        const media = sdp.media[index];
        const transport = this.currentTransportForMid(
          media?.rtp.muxId ?? "",
        )?.iceTransport;
        const ufrag = media?.iceParams?.usernameFragment;
        // Only the generation that actually ended on the transport counts; a
        // pending restart ufrag on the same transport is still open.
        return transport?.connection.remoteCandidatesEnd &&
          transport.connection.remoteUsername === ufrag
          ? { transport, ufrag }
          : undefined;
      })
      .filter((generation) => !!generation?.ufrag);
    for (const media of sdp.media) {
      const transport = this.currentTransportForMid(
        media.rtp.muxId ?? "",
      )?.iceTransport;
      if (
        generations.some(
          (generation) =>
            generation?.transport === transport &&
            generation?.ufrag === media.iceParams?.usernameFragment,
        )
      ) {
        media.iceCandidatesComplete = true;
      }
    }
  }

  private async deliverSameGenerationCandidate(
    pending: SessionDescription,
    current: SessionDescription,
    applied: NonNullable<
      Awaited<ReturnType<SecureTransportManager["addIceCandidate"]>>
    >,
  ) {
    for (const index of applied.mediaIndices) {
      const mid = pending.media[index]?.rtp.muxId;
      const ufrag = pending.media[index]?.iceParams?.usernameFragment;
      const currentMedia = current.media.find(
        (media) => media.rtp.muxId === mid,
      );
      const iceTransport = mid
        ? this.currentTransportForMid(mid)?.iceTransport
        : undefined;
      if (
        !ufrag ||
        !currentMedia ||
        currentMedia.iceParams?.usernameFragment !== ufrag ||
        !iceTransport ||
        this.negotiation.isPendingOnlyTransport(iceTransport.id) ||
        iceTransport.connection.remoteUsername !== ufrag ||
        // RFC 8838: a generation that signalled end-of-candidates is complete,
        // whichever BUNDLE m-line of the shared transport carried it.
        currentMedia.iceCandidatesComplete ||
        iceTransport.connection.remoteCandidatesEnd
      ) {
        continue;
      }
      if (applied.kind === "end-of-candidates") {
        currentMedia.iceCandidatesComplete = true;
        await iceTransport.addRemoteCandidate(undefined);
        this.completeSharedTransportMedia(current, [
          current.media.indexOf(currentMedia),
        ]);
        continue;
      }
      const text = applied.candidate.toJSON().candidate;
      if (
        currentMedia.iceCandidates.some(
          (existing) => existing.toJSON().candidate === text,
        )
      ) {
        continue;
      }
      currentMedia.iceCandidates.push(applied.candidate);
      await iceTransport.addRemoteCandidate(applied.candidate);
    }
  }

  /**
   * Candidates queued before any remote description are checked against the
   * description during validation, so a bad one rejects setRemoteDescription
   * before any state changes and before any application event fires. The rejected
   * candidates leave the queue: their addIceCandidate already resolved, and a
   * retry of the same description must not fail on them again.
   */
  private async validatePendingRemoteCandidates(sdp: SessionDescription) {
    let firstError: unknown;
    for (const candidate of [...this.pendingRemoteCandidates]) {
      try {
        await this.secureManager.addIceCandidate(sdp, candidate ?? null, false);
      } catch (error) {
        firstError ??= error;
        this.pendingRemoteCandidates.splice(
          this.pendingRemoteCandidates.indexOf(candidate),
          1,
        );
      }
    }
    if (firstError) throw firstError;
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
    this.iceCredentialsToReplace = new Set([
      ...this.localUfrags(this.sdpManager.currentLocalDescription),
      ...this.localUfrags(this.sdpManager.pendingLocalDescription),
    ]);
    this.needNegotiation();
  }

  private localUfrags(description?: SessionDescription) {
    return (description?.media ?? [])
      .filter((media) => media.port !== 0)
      .map((media) => media.iceParams?.usernameFragment)
      .filter((ufrag): ufrag is string => !!ufrag);
  }

  /**
   * An answer committed: a `restartIce()` request is satisfied once no current
   * local credentials are among those it asked to replace.
   */
  private settleIceRestartRequest() {
    if (!this.needRestart) return;
    if (
      this.localUfrags(this.sdpManager.currentLocalDescription).some((ufrag) =>
        this.iceCredentialsToReplace.has(ufrag),
      )
    ) {
      return;
    }
    this.needRestart = false;
    this.iceCredentialsToReplace.clear();
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
        this.pendingOfferChangeSeq = undefined;
        if (this.shouldNegotiationneeded || this.needRestart) {
          this.scheduleNegotiationneeded();
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
      this.sdpManager.validateRemoteDescription(remoteSdp);
      this.assertAnswerKeepsSharedTransports(remoteSdp);
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
          negotiateRemoteCodecs(this.localCodecsFor(media), media).length === 0
        ) {
          throw createWebRtcDomException(
            "InvalidAccessError",
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
          // An answer or pranswer keeps the DTLS role of a live association
          // (RFC 8842 section 5.5); only a new association, such as a BUNDLE
          // split owner prepared for this proposal, may take another role.
          // A non-tag BUNDLE member never sets a role, so it is not checked.
          const prepared = this.negotiation.transportByMid.get(
            media.rtp.muxId ?? "",
          );
          const bundledNonTag = this.isBundledNonTag(
            remoteSdp,
            media.rtp.muxId,
          );
          const remoteRole = media.dtlsParams?.role;
          if (
            remoteSdp.type !== "offer" &&
            !bundledNonTag &&
            remoteRole &&
            transport &&
            ["connecting", "connected"].includes(transport.state) &&
            transport.role !== "auto" &&
            (!prepared || prepared === transport) &&
            (remoteRole === "client" ? "server" : "client") !== transport.role
          ) {
            throw createWebRtcDomException(
              "InvalidModificationError",
              "Changing the DTLS role of a connected association is unsupported",
            );
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

      // Queued candidates are placed against the parsed proposal before any
      // state changes or application events (track, transceiver) fire.
      // Only a non-empty queue awaits, so ordinary offers keep their timing.
      if (this.pendingRemoteCandidates.length > 0) {
        await this.validatePendingRemoteCandidates(remoteSdp);
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
        this.pendingOfferChangeSeq = undefined;
        this.shouldNegotiationneeded = true;
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
          this.applyPendingBundleTopology();
        }

        const bundleGroups =
          this.sdpManager.bundlePolicy === "disable"
            ? []
            : remoteSdp.group.filter((group) => group.semantic === "BUNDLE");
        const groupOfMid = (mid: string | undefined) =>
          mid == undefined
            ? undefined
            : bundleGroups.find((group) => group.items.includes(mid));
        const preserveCurrentTransport =
          (remoteSdp.type === "offer" || remoteSdp.type === "pranswer") &&
          !!this.sdpManager.currentRemoteDescription;
        const isRemoteOffer = remoteSdp.type === "offer";

        // # apply description

        const provisionalIce: [RTCIceTransport, MediaDescription][] = [];
        // Live transport and media stop operations run only after every
        // m-line applied without error, so a failure above leaves the ICE
        // generation, selected pair and DTLS/SCTP bindings untouched.
        const transportUpdates: (() => void)[] = [];
        const endOfCandidates: RTCIceTransport[] = [];

        // ## associate m-lines with transceivers / sctp
        const associated = new Set<RTCRtpTransceiver>();
        const entries: RemoteMediaEntry[] = remoteSdp.media.map(
          (remoteMedia, i) => {
            if (remoteMedia.kind === "application") {
              if (remoteMedia.port === 0) return { remoteMedia, index: i };
              let sctpTransport = this.sctpTransport;
              if (!sctpTransport) {
                sctpTransport = this.createSctpTransport();
                sctpTransport.mid = remoteMedia.rtp.muxId;
              }
              return { remoteMedia, index: i, sctpTransport };
            }
            if (!["audio", "video"].includes(remoteMedia.kind)) {
              throw new Error("invalid media kind");
            }
            let transceiver = this.findTransceiverForRemoteMedia(
              remoteMedia,
              i,
              associated,
            );
            if (!transceiver) {
              // 未知の MID の拒否済み m-line には transceiver を関連付けない
              if (remoteMedia.port === 0) return { remoteMedia, index: i };
              // JSEP 5.2.2: a new MID on an existing m-line recycles it, so the
              // transceiver that owned it is stopped. The flags are part of the
              // rollback baseline; its sender/receiver stop at the answer.
              const displaced = this.transceiverManager.getTransceivers().find(
                (t) =>
                  !t.stopped &&
                  t.mLineIndex === i &&
                  !!t.mid &&
                  t.mid !== remoteMedia.rtp.muxId &&
                  // Only the transceiver that owns this m-line in the
                  // current session is displaced by its recycling.
                  this.sdpManager.currentRemoteDescription?.media[i]?.rtp
                    .muxId === t.mid,
              );
              if (displaced) {
                displaced.stopping = true;
                displaced.stopped = true;
                this.router.unregisterTransceiver(displaced);
                this.negotiation.rememberDisplacedTransceiver(displaced);
              }
              // create remote transceiver
              // Not an application operation: no negotiationneeded and no
              // takeover of an inactive current transceiver. A stopped
              // transceiver at the same index is replaced, never revived.
              transceiver = this.transceiverManager.addTransceiver(
                remoteMedia.kind,
                this.findOrCreateTransport(),
                { direction: "recvonly" },
                { remoteMLineIndex: i },
              );
              transceiver.mid = remoteMedia.rtp.muxId ?? null;
              this.negotiation.rememberRemoteTransceiver(transceiver);
              this.onRemoteTransceiverAdded.execute(transceiver);
            } else if (transceiver.mid == null) {
              this.transceiverManager.associateMLine(transceiver, i);
            }
            associated.add(transceiver);
            return { remoteMedia, index: i, transceiver };
          },
        );
        if (isRemoteOffer) {
          // 関連付けられなかった未交渉 transceiver の位置の予約を解除する
          this.transceiverManager.releaseUnassociatedReservations(
            associated,
            remoteSdp.media.length,
          );
        }
        const ownerOf = (entry: RemoteMediaEntry) =>
          entry.transceiver ?? entry.sctpTransport;
        // A current owner keeps its transport while a re-offer or pranswer is
        // pending; a staged BUNDLE topology switches it at the answer.
        const keepsCurrent = (entry: RemoteMediaEntry) =>
          preserveCurrentTransport &&
          (entry.transceiver
            ? !!entry.transceiver.currentDirection
            : !!this.sctpManager.sctpRemotePort);

        // ## transport ownership
        // BUNDLE group ごとに 1 つの transport を共有する。remote offer の所有関係は
        // bundlePolicy によらず offer の group だけで決まり (max-bundle は自分の offer にだけ効く)、
        // 異なる group や group 外の m-line とは共有しない。
        const liveTransport = (transport: RTCDtlsTransport | undefined) =>
          !!transport && transport.state !== "closed";
        const claimed = new Set<RTCDtlsTransport>();
        // A transport that inherited another owner's ICE credentials is the
        // same ICE session on the wire, so it counts as claimed as well.
        const ufragOf = (transport: RTCDtlsTransport) =>
          transport.iceTransport.localParameters.usernameFragment;
        const isClaimed = (transport: RTCDtlsTransport) =>
          claimed.has(transport) ||
          [...claimed].some((other) => ufragOf(other) === ufragOf(transport));
        if (preserveCurrentTransport) {
          // A re-offer or pranswer on a live session keeps every current
          // owner on its transport: a new BUNDLE topology (split, merge, a new
          // owner outside the group) is prepared for the answer and switches
          // only at the commit. New members join their group tag's transport.
          for (const group of bundleGroups) {
            const members = entries.filter(
              (entry) =>
                !!ownerOf(entry) &&
                entry.remoteMedia.port !== 0 &&
                group.items.includes(entry.remoteMedia.rtp.muxId!),
            );
            const tag =
              members.find(
                (entry) => entry.remoteMedia.rtp.muxId === group.items[0],
              ) ?? members[0];
            const shared = tag && ownerOf(tag)!.dtlsTransport;
            for (const entry of members) {
              const owner = ownerOf(entry)!;
              if (
                shared &&
                !keepsCurrent(entry) &&
                owner.dtlsTransport !== shared
              ) {
                owner.setDtlsTransport(shared);
              }
            }
          }
        } else {
          for (const group of bundleGroups) {
            const members = entries.filter(
              (entry) =>
                !!ownerOf(entry) &&
                entry.remoteMedia.port !== 0 &&
                group.items.includes(entry.remoteMedia.rtp.muxId!),
            );
            if (members.length === 0) continue;
            // The tag's transport first, then any other member's.
            const preferred = [
              ...members.filter(
                (entry) => entry.remoteMedia.rtp.muxId === group.items[0],
              ),
              ...members,
            ];
            let shared = preferred
              .map((entry) => ownerOf(entry)!.dtlsTransport)
              .find(
                (transport) =>
                  liveTransport(transport) &&
                  (!isRemoteOffer || !isClaimed(transport)),
              );
            if (!shared) shared = this.createOwnerTransport();
            claimed.add(shared);
            for (const entry of members) {
              const owner = ownerOf(entry)!;
              if (owner.dtlsTransport !== shared)
                owner.setDtlsTransport(shared);
            }
          }
          if (isRemoteOffer) {
            // group 外 (group のない offer を含む) で受け入れる m-line は、max-bundle でも
            // 独立した transport と ICE credentials を持つ
            for (const entry of entries) {
              const owner = ownerOf(entry);
              if (
                !owner ||
                entry.remoteMedia.port === 0 ||
                groupOfMid(entry.remoteMedia.rtp.muxId)
              ) {
                continue;
              }
              if (
                !liveTransport(owner.dtlsTransport) ||
                isClaimed(owner.dtlsTransport)
              ) {
                owner.setDtlsTransport(this.createOwnerTransport());
              }
              claimed.add(owner.dtlsTransport);
            }
          }
        }

        // ## apply RTP / SCTP (受け入れ判定)
        const acceptedEntries = new Set<RemoteMediaEntry>();
        for (const entry of entries) {
          const { remoteMedia, index: i, transceiver } = entry;
          if (transceiver) {
            if (remoteMedia.port !== 0) {
              if (
                this.transceiverManager.setRemoteRTP(
                  transceiver,
                  remoteMedia,
                  remoteSdp.type,
                  i,
                )
              ) {
                acceptedEntries.add(entry);
              }
              continue;
            }
            // remote port 0: an offer or pranswer only marks the rejection
            // (the current pipeline keeps running until the answer); an
            // answer stops it once every fallible step has passed.
            transceiver.mLineIndex = i;
            if (transceiver.stopped) continue;
            if (remoteSdp.type === "answer") {
              transportUpdates.push(() =>
                transceiver.commitStopped({ rejected: !transceiver.stopping }),
              );
            } else if (!transceiver.stopping) {
              transceiver.pendingRejection = true;
            }
          } else if (entry.sctpTransport) {
            if (!preserveCurrentTransport || !this.sctpManager.sctpRemotePort) {
              this.sctpManager.setRemoteSCTP(remoteMedia, i);
            }
            acceptedEntries.add(entry);
          }
        }

        // ICE / DTLS パラメータは group で最初に受け入れた member (通常は tag) から適用する
        // (codec 不一致で拒否した member のパラメータは使わない)
        const groupParamSources = new Map<GroupDescription, RemoteMediaEntry>();
        for (const group of bundleGroups) {
          for (const mid of group.items) {
            const entry = entries.find(
              (e) =>
                e.remoteMedia.rtp.muxId === mid &&
                e.remoteMedia.port !== 0 &&
                acceptedEntries.has(e),
            );
            if (entry) {
              groupParamSources.set(group, entry);
              break;
            }
          }
        }

        // ## apply transport parameters
        for (const entry of entries) {
          const { remoteMedia } = entry;
          const owner = ownerOf(entry);
          const group = groupOfMid(remoteMedia.rtp.muxId);
          if (
            !owner ||
            remoteMedia.port === 0 ||
            // group 外の拒否 section の transport は使わない
            (!acceptedEntries.has(entry) && !group)
          ) {
            continue;
          }
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
          const dtlsTransport =
            preserveCurrentTransport && pendingTransport
              ? pendingTransport
              : owner.dtlsTransport;
          if (!liveTransport(dtlsTransport)) continue;
          const iceTransport = dtlsTransport.iceTransport;
          const bundledNonTag =
            !!group && groupParamSources.get(group) !== entry;

          transportUpdates.push(() => {
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
              remoteMedia.iceCandidates.forEach(
                iceTransport.addRemoteCandidate,
              );
            }

            // End-of-candidates ends the shared generation whichever BUNDLE
            // m-line carries it; it runs after every m-line's candidates.
            if (
              remoteMedia.iceCandidatesComplete &&
              (!preserveCurrentTransport || !!pendingTransport)
            ) {
              endOfCandidates.push(iceTransport);
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
          });
        }

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
          await this.deliverSameGenerationDescription(remoteSdp);
        }
        // A description that repeats an ICE generation which already ended
        // on its transport records that end too, so it cannot become current
        // promising candidates the live transport no longer accepts.
        this.completeSharedTransportMedia(
          remoteSdp,
          remoteSdp.media.map((_, index) => index),
        );
        for (const [iceTransport, media] of provisionalIce) {
          await this.applyProvisionalIce(iceTransport, media);
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
          await this.cleanupInitialProvisionalTransport();
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
      if (
        remoteSdp.type === "answer" &&
        this.pendingOfferChangeSeq != undefined
      ) {
        // 確定した local offer が反映していた変更は交渉済みになる
        this.negotiatedChangeSeq = Math.max(
          this.negotiatedChangeSeq,
          this.pendingOfferChangeSeq,
        );
        this.pendingOfferChangeSeq = undefined;
      }
      if (remoteSdp.type === "answer") this.settleIceRestartRequest();
      const hasUnnegotiatedStop =
        remoteSdp.type === "answer" && this.settleStoppingTransceivers();
      if (this.shouldNegotiationneeded || hasUnnegotiatedStop) {
        this.scheduleNegotiationneeded();
      }
      this.invalidateLastCreatedDescriptions();
    });
  }

  /**
   * remote answer / pranswer の検証 (offerer 側、状態を変更する前に実行する)。
   * local offer で 1 つの transport を共有した m-line を、answer が同じ BUNDLE group に置かずに
   * 異なる ICE credentials で受け入れることはできない (RFC 8843 7.3.2)。共有 transport は分割できず、
   * 新しい transport を作ると offer で渡した ICE credentials とも一致しなくなる。
   * group の記述が MID と一致しなくても remote の ICE credentials が同じなら、同じ transport のまま扱う。
   */
  private assertAnswerKeepsSharedTransports(answer: SessionDescription) {
    if (
      !["answer", "pranswer"].includes(answer.type) ||
      !["have-local-offer", "have-remote-pranswer"].includes(
        this.signalingState,
      ) ||
      this.config.bundlePolicy === "disable"
    ) {
      return;
    }
    const answerGroups = answer.group.filter((g) => g.semantic === "BUNDLE");
    const byTransport = new Map<
      RTCDtlsTransport,
      { group?: GroupDescription; credentials: string }
    >();
    for (const media of answer.media) {
      const mid = media.rtp.muxId;
      if (media.port === 0 || mid == undefined) {
        continue;
      }
      const owner =
        media.kind === "application"
          ? this.sctpTransport?.mid === mid
            ? this.sctpTransport
            : undefined
          : this.transceiverManager
              .getTransceivers()
              .find((t) => t.mid === mid && !t.stopped);
      // local offer 用に準備した transport があれば、それが offer での所有 transport
      const transport =
        this.negotiation.transportByMid.get(mid) ?? owner?.dtlsTransport;
      if (!transport) {
        continue;
      }
      const current = {
        group: answerGroups.find((g) => g.items.includes(mid)),
        credentials: `${media.iceParams?.usernameFragment}:${media.iceParams?.password}`,
      };
      const first = byTransport.get(transport);
      if (!first) {
        byTransport.set(transport, current);
        continue;
      }
      const sameGroup = !!current.group && current.group === first.group;
      if (!sameGroup && current.credentials !== first.credentials) {
        throw createWebRtcDomException(
          "InvalidAccessError",
          `mid=${mid} shares a transport in the local offer but the remote ${answer.type} moves it out of that BUNDLE group`,
        );
      }
    }
  }

  /**
   * BUNDLE tag (first MID) of the group of `description` that contains `mid`.
   * Every group counts, not only the first one (RFC 8843 allows several).
   */
  private bundleTagOf(description: SessionDescription, mid?: string | null) {
    if (this.sdpManager.bundlePolicy === "disable" || mid == undefined) return;
    return description.group.find(
      (group) => group.semantic === "BUNDLE" && group.items.includes(mid),
    )?.items[0];
  }

  /** `mid` is a BUNDLE member that shares its group tag's transport. */
  private isBundledNonTag(
    description: SessionDescription,
    mid?: string | null,
  ) {
    const tag = this.bundleTagOf(description, mid);
    return tag !== undefined && tag !== mid;
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

  /**
   * remote m-line に対応する transceiver を探す。MID の一致を優先し、
   * 未関連付け transceiver は同じ offer 内で異なる m-line に割り当てる。
   */
  private findTransceiverForRemoteMedia(
    remoteMedia: MediaDescription,
    index: number,
    associated: Set<RTCRtpTransceiver>,
  ) {
    const candidates = this.transceiverManager
      .getTransceivers()
      .filter((t) => !associated.has(t) && t.kind === remoteMedia.kind);
    const mid = remoteMedia.rtp.muxId;
    const byMid =
      mid != undefined ? candidates.find((t) => t.mid === mid) : undefined;
    if (byMid) {
      return byMid;
    }
    if (remoteMedia.port === 0) {
      return;
    }
    const unassociated = candidates.filter(
      (t) => t.mid == null && !t.stopping && !t.stopped,
    );
    return unassociated.find((t) => t.mLineIndex === index) ?? unassociated[0];
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
      for (const [owner, plan] of this.planPendingBundleTopology(pendingOffer)
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
  /** SCTP outbound packet MTU used for DATA chunk fragmentation. */
  sctp: { mtu: number };
  /**
   * Queue outbound RTP on each sender until DTLS is connected.
   * Disabled by default. Pass `true` or `{ enabled: true, maxLength }` to buffer.
   */
  pendingRtp: NonNullable<RTCRtpSenderOptions["pendingRtp"]>;
  /**
   * How local SDP marks inactive / stopped m-lines. Cannot be changed after construction.
   * - `"compatible"` (default): an accepted `inactive` m-line keeps a non-zero port.
   *   Only rejected (no common codec / remote port 0) or stopped m-lines use port 0,
   *   and only those negotiated port 0 positions are reused by new transceivers.
   * - `"aggressive"`: legacy behavior. `inactive` m-lines are also written with port 0.
   */
  mLineReuse: MLineReuse;
}

const MLineReuseModes: readonly MLineReuse[] = ["compatible", "aggressive"];

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

export interface RTCSctpConfiguration {
  /** SCTP outbound packet MTU used for DATA chunk fragmentation. Defaults to 1191. */
  mtu?: number;
}

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
    | "bundlePolicy"
    | "rtcpMuxPolicy"
    | "iceCandidatePoolSize"
    | "certificates"
    | "sctp"
  >
> &
  RTCPeerConnectionRTCConfiguration & { sctp?: RTCSctpConfiguration };

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
    sctp: { mtu: DEFAULT_SCTP_MTU },
    pendingRtp: false,
    mLineReuse: "compatible",
  };
}
export const defaultPeerConfig: PeerConfig = generateDefaultPeerConfig();

function normalizePeerConfiguration(
  config: RTCPeerConnectionConfig,
): Partial<PeerConfig> & { sctp?: RTCSctpConfiguration } {
  const input = Object(config ?? {}) as RTCPeerConnectionConfig;
  const normalizedConfig = { ...input } as Partial<PeerConfig> & {
    sctp?: RTCSctpConfiguration;
  };

  if (input.sctp !== undefined) {
    normalizedConfig.sctp = { ...input.sctp } as PeerConfig["sctp"];
  }

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
    sctp: { ...config.sctp },
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

type RemoteMediaEntry = {
  remoteMedia: MediaDescription;
  index: number;
  transceiver?: RTCRtpTransceiver;
  sctpTransport?: RTCSctpTransport;
};

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
