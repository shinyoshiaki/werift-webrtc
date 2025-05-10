import cloneDeep from "lodash/cloneDeep.js";
import * as uuid from "uuid";

import type { RTCDataChannel } from "./dataChannel";
import { EventTarget, enumerate } from "./helper";
import {
  type Address,
  Event,
  type InterfaceAddresses,
  debug,
} from "./imports/common";
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
import type { BundlePolicy, MediaDescription, SessionDescription } from "./sdp";
import { type RTCSessionDescriptionInit, SDPManager } from "./sdpManager";
import type { DtlsKeys, RTCDtlsTransport } from "./transport/dtls";
import type {
  IceGathererState,
  RTCIceCandidate,
  RTCIceCandidateInit,
  RTCIceConnectionState,
  RTCIceTransport,
} from "./transport/ice";
import { SctpTransportManager } from "./sctpManager";
import { SecureTransportManager } from "./secureTransportManager";
import type { ConnectionState, Kind, RTCSignalingState } from "./types/domain";
import type { Callback, CallbackWithValue } from "./types/util";
import { andDirection, deepMerge } from "./utils";

const log = debug("werift:packages/webrtc/src/peerConnection.ts");

export class RTCPeerConnection extends EventTarget {
  readonly cname = uuid.v4();

  config: Required<PeerConfig> = cloneDeep<PeerConfig>(defaultPeerConfig);
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

  ondatachannel?: CallbackWithValue<RTCDataChannelEvent>;
  onicecandidate?: CallbackWithValue<RTCPeerConnectionIceEvent>;
  onnegotiationneeded?: CallbackWithValue<any>;
  onsignalingstatechange?: CallbackWithValue<any>;
  ontrack?: CallbackWithValue<RTCTrackEvent>;
  onconnectionstatechange?: Callback;
  oniceconnectionstatechange?: Callback;

  constructor(config: Partial<PeerConfig> = {}) {
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
      ({ track, stream, transceiver }) => {
        const event: RTCTrackEvent = {
          track,
          streams: [stream],
          transceiver,
          receiver: transceiver.receiver,
        };
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
      const event: RTCDataChannelEvent = { channel };
      this.ondatachannel?.(event);
      this.emit("datachannel", event);
    });
    this.secureManager = new SecureTransportManager({
      config: this.config,
      router: this.router,
      sctpHandler: this.sctpManager,
      transceiverManager: this.transceiverManager,
    });
    this.secureManager.iceGatheringStateChange.pipe(
      this.iceGatheringStateChange,
    );
    this.secureManager.iceConnectionStateChange.subscribe((state) => {
      if (state === "closed") {
        this.close();
      }
      this.iceConnectionStateChange.execute(state);
    });
    this.secureManager.connectionStateChange.subscribe((state) => {
      this.connectionStateChange.execute(state);
      this.onconnectionstatechange?.();
      this.emit("connectionstatechange");
    });
    this.secureManager.onIceCandidate.subscribe((candidate) => {
      const iceCandidate = candidate ? candidate.toJSON() : undefined;
      this.onIceCandidate.execute(iceCandidate);
      this.onicecandidate?.({ candidate: iceCandidate });
      this.emit("icecandidate", { candidate: iceCandidate });
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
  get dtlsTransports() {
    return this.secureManager.dtlsTransports;
  }
  get sctpTransport() {
    return this.sctpManager.sctpTransport;
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
    return this.sdpManager.localDescription;
  }
  get remoteDescription() {
    return this.sdpManager.remoteDescription;
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

  setConfiguration(config: Partial<PeerConfig>) {
    deepMerge(this.config, config);

    if (this.config.icePortRange) {
      const [min, max] = this.config.icePortRange;
      if (min === max) throw new Error("should not be same value");
      if (min >= max) throw new Error("The min must be less than max");
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
      ...(this.config.headerExtensions.video || []),
    ].forEach((v, i) => {
      v.id = 1 + i;
    });
  }

  getConfiguration() {
    return this.config;
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
    return description.toJSON();
  }

  private createSctpTransport() {
    const sctp = this.sctpManager.createSctpTransport();
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
      throw new Error("peer closed");
    }
    this.transceiverManager.removeTrack(sender);
    this.needNegotiation();
  }

  private needNegotiation = async () => {
    this.shouldNegotiationneeded = true;
    if (this.negotiationneeded || this.signalingState !== "stable") {
      return;
    }
    this.shouldNegotiationneeded = false;
    setImmediate(() => {
      this.negotiationneeded = true;
      this.onNegotiationneeded.execute();
      if (this.onnegotiationneeded) this.onnegotiationneeded({});
    });
  };

  private findOrCreateTransport() {
    const [existing] = this.iceTransports;

    // Gather ICE candidates for only one track. If the remote endpoint is not bundle-aware, negotiate only one media track.
    // https://w3c.github.io/webrtc-pc/#rtcbundlepolicy-enum
    if (this.sdpManager.bundlePolicy === "max-bundle") {
      if (existing) {
        return this.dtlsTransports[0];
      }
    }

    const dtlsTransport = this.secureManager.createTransport();
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

      this.secureManager.handleNewIceCandidate({
        candidate,
        bundlePolicy: this.sdpManager.bundlePolicy,
        remoteIsBundled: !!this.sdpManager.remoteIsBundled,
        media: this._localDescription.media[0],
        transceiver: this.transceiverManager
          .getTransceivers()
          .find((t) => t.dtlsTransport.iceTransport.id === iceTransport.id),
        sctpTransport:
          this.sctpTransport?.dtlsTransport.iceTransport.id === iceTransport.id
            ? this.sctpTransport
            : undefined,
      });
    });

    return dtlsTransport;
  }

  async setLocalDescription(sessionDescription?: {
    type: "offer" | "answer";
    sdp: string;
  }): Promise<SessionDescription> {
    // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/setLocalDescription#type
    const implicitOfferState: RTCSignalingState[] = [
      "stable",
      "have-local-offer",
      "have-remote-pranswer",
    ];
    sessionDescription =
      sessionDescription ??
      (implicitOfferState.includes(this.signalingState)
        ? await this.createOffer()
        : await this.createAnswer());

    // # parse and validate description
    const description = this.sdpManager.parseSdp({
      sdp: sessionDescription.sdp,
      isLocal: true,
      signalingState: this.signalingState,
      type: sessionDescription.type,
    });

    // # update signaling state
    if (description.type === "offer") {
      this.setSignalingState("have-local-offer");
    } else if (description.type === "answer") {
      this.setSignalingState("stable");
    }

    // # assign MID
    for (const [i, media] of enumerate(description.media)) {
      const mid = media.rtp.muxId!;
      this.sdpManager.seenMid.add(mid);
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
      type: description.type,
      role,
    });

    // # configure direction
    if (["answer", "pranswer"].includes(description.type)) {
      for (const t of this.transceiverManager.getTransceivers()) {
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

    return description;
  }

  private async gatherCandidates() {
    await this.secureManager.gatherCandidates(
      !!this.sdpManager.remoteIsBundled,
    );
  }

  async addIceCandidate(
    candidateMessage: RTCIceCandidate | RTCIceCandidateInit,
  ) {
    const sdp = this.sdpManager.buildOfferSdp(
      this.transceiverManager.getTransceivers(),
      this.sctpTransport,
    );
    await this.secureManager.addIceCandidate(sdp, candidateMessage);
  }

  private async connect() {
    log("start connect");

    const res = await Promise.allSettled(
      this.dtlsTransports.map(async (dtlsTransport) => {
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
    // # parse and validate description
    const remoteSdp = this.sdpManager.setRemoteDescription(
      sessionDescription,
      this.signalingState,
    );

    let bundleTransport: RTCDtlsTransport | undefined;

    // # apply description

    const matchTransceiverWithMedia = (
      transceiver: RTCRtpTransceiver,
      media: MediaDescription,
    ) =>
      transceiver.kind === media.kind &&
      [undefined, media.rtp.muxId].includes(transceiver.mid);

    let transports = remoteSdp.media.map((remoteMedia, i) => {
      let dtlsTransport: RTCDtlsTransport;

      if (["audio", "video"].includes(remoteMedia.kind)) {
        let transceiver = this.transceiverManager
          .getTransceivers()
          .find((t) => matchTransceiverWithMedia(t, remoteMedia));
        if (!transceiver) {
          // create remote transceiver
          transceiver = this.addTransceiver(remoteMedia.kind, {
            direction: "recvonly",
          });
          transceiver.mid = remoteMedia.rtp.muxId;
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

        if (this.sdpManager.remoteIsBundled) {
          if (!bundleTransport) {
            bundleTransport = transceiver.dtlsTransport;
          } else {
            transceiver.setDtlsTransport(bundleTransport);
          }
        }

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
          sctpTransport = this.createSctpTransport();
          sctpTransport.mid = remoteMedia.rtp.muxId;
        }

        if (this.sdpManager.remoteIsBundled) {
          if (!bundleTransport) {
            bundleTransport = sctpTransport.dtlsTransport;
          } else {
            sctpTransport.setDtlsTransport(bundleTransport);
          }
        }

        dtlsTransport = sctpTransport.dtlsTransport;

        this.sctpManager.setRemoteSCTP(remoteMedia, i);
      } else {
        throw new Error("invalid media kind");
      }

      const iceTransport = dtlsTransport.iceTransport;

      if (remoteMedia.iceParams) {
        const renomination = !!this.sdpManager.inactiveRemoteMedia;
        iceTransport.setRemoteParams(remoteMedia.iceParams, renomination);

        // One agent full, one lite:  The full agent MUST take the controlling role, and the lite agent MUST take the controlled role
        // RFC 8445 S6.1.1
        if (remoteMedia.iceParams?.iceLite) {
          iceTransport.connection.iceControlling = true;
        }
      }
      if (remoteMedia.dtlsParams) {
        dtlsTransport.setRemoteParams(remoteMedia.dtlsParams);
      }

      // # add ICE candidates
      remoteMedia.iceCandidates.forEach(iceTransport.addRemoteCandidate);

      if (remoteMedia.iceCandidatesComplete) {
        iceTransport.addRemoteCandidate(undefined);
      }

      // # set DTLS role
      if (remoteSdp.type === "answer" && remoteMedia.dtlsParams?.role) {
        dtlsTransport.role =
          remoteMedia.dtlsParams.role === "client" ? "server" : "client";
      }
      return iceTransport;
    }) as RTCIceTransport[];

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
      for (const transceiver of removedTransceivers) {
        // todo: handle answer side transceiver removal work.
        // event should trigger to notify media source to stop.
        transceiver.stop();
        transceiver.stopped = true;
      }
    }

    if (remoteSdp.type === "offer") {
      this.setSignalingState("have-remote-offer");
    } else if (remoteSdp.type === "answer") {
      this.setSignalingState("stable");
    }

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
  addTrack(
    track: MediaStreamTrack,
    /**todo impl */
    ms?: MediaStream,
  ): RTCRtpSender {
    if (this.isClosed) {
      throw new Error("is closed");
    }
    const transceiver = this.transceiverManager.addTrack(track, ms);
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

    const description = this.sdpManager.buildAnswerSdp({
      transceivers: this.transceiverManager.getTransceivers(),
      sctpTransport: this.sctpTransport,
      signalingState: this.signalingState,
    });
    return description.toJSON();
  }

  async close() {
    if (this.isClosed) return;

    this.isClosed = true;
    this.setSignalingState("closed");

    await this.secureManager.close();
    await this.sctpManager.close();
    this.transceiverManager.close();

    this.onDataChannel.allUnsubscribe();
    this.iceGatheringStateChange.allUnsubscribe();
    this.iceConnectionStateChange.allUnsubscribe();
    this.signalingStateChange.allUnsubscribe();
    this.onTransceiverAdded.allUnsubscribe();
    this.onRemoteTransceiverAdded.allUnsubscribe();
    this.onIceCandidate.allUnsubscribe();
    log("peerConnection closed");
  }

  private assertNotClosed() {
    if (this.isClosed) {
      throw new Error("RTCPeerConnection is closed");
    }
  }

  private setSignalingState(state: RTCSignalingState) {
    log("signalingStateChange", state);
    this.signalingState = state;
    this.signalingStateChange.execute(state);
    if (this.onsignalingstatechange) {
      this.onsignalingstatechange({});
    }
  }
}

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
  debug: Partial<{
    /**% */
    inboundPacketLoss: number;
    /**% */
    outboundPacketLoss: number;
    /**ms */
    receiverReportDelay: number;
    disableSendNack: boolean;
    disableRecvRetransmit: boolean;
  }>;
  midSuffix: boolean;
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
  urls: string;
  username?: string;
  credential?: string;
};

export const defaultPeerConfig: PeerConfig = {
  codecs: {
    audio: [useOPUS(), usePCMU()],
    video: [useVP8()],
  },
  headerExtensions: {
    audio: [],
    video: [],
  },
  iceTransportPolicy: "all",
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  icePortRange: undefined,
  iceInterfaceAddresses: undefined,
  iceAdditionalHostAddresses: undefined,
  iceUseIpv4: true,
  iceUseIpv6: true,
  iceFilterStunResponse: undefined,
  iceFilterCandidatePair: undefined,
  icePasswordPrefix: undefined,
  iceUseLinkLocalAddress: undefined,
  dtls: {},
  bundlePolicy: "max-compat",
  debug: {},
  midSuffix: false,
  forceTurnTCP: false,
};

export interface RTCTrackEvent {
  track: MediaStreamTrack;
  streams: MediaStream[];
  transceiver: RTCRtpTransceiver;
  receiver: RTCRtpReceiver;
}

export interface RTCDataChannelEvent {
  channel: RTCDataChannel;
}

export interface RTCPeerConnectionIceEvent {
  candidate?: RTCIceCandidate;
}
