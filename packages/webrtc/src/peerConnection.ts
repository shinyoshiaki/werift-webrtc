import cloneDeep from "lodash/cloneDeep.js";
import isEqual from "lodash/isEqual.js";
import * as uuid from "uuid";

import { ReceiverDirection, SRTP_PROFILE, SenderDirections } from "./const";
import { RTCDataChannel, RTCDataChannelParameters } from "./dataChannel";
import { EventTarget, enumerate } from "./helper";
import {
  type Address,
  Event,
  type InterfaceAddresses,
  debug,
} from "./imports/common";
import type { CandidatePair, Message, Protocol } from "./imports/ice";
import type { SrtpProfile } from "./imports/rtp";
import {
  MediaStream,
  type MediaStreamTrack,
  Recvonly,
  type RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  type RTCRtpHeaderExtensionParameters,
  type RTCRtpParameters,
  type RTCRtpReceiveParameters,
  RTCRtpReceiver,
  RTCRtpRtxParameters,
  RTCRtpSender,
  RTCRtpTransceiver,
  RtpRouter,
  Sendonly,
  Sendrecv,
  type TransceiverOptions,
  useOPUS,
  usePCMU,
  useVP8,
} from "./media";
import {
  type MediaDescription,
  SessionDescription,
  codecParametersFromString,
} from "./sdp";
import { SDPHandler } from "./sdpHandler";
import {
  type DtlsKeys,
  RTCCertificate,
  RTCDtlsTransport,
} from "./transport/dtls";
import {
  IceCandidate,
  type IceGathererState,
  type RTCIceCandidate,
  type RTCIceCandidateInit,
  type RTCIceConnectionState,
  RTCIceGatherer,
  RTCIceTransport,
} from "./transport/ice";
import { RTCSctpTransport } from "./transport/sctp";
import type { ConnectionState, Kind, RTCSignalingState } from "./types/domain";
import type { Callback, CallbackWithValue } from "./types/util";
import {
  andDirection,
  deepMerge,
  parseIceServers,
  reverseDirection,
} from "./utils";

const log = debug("werift:packages/webrtc/src/peerConnection.ts");

export class RTCPeerConnection extends EventTarget {
  readonly cname = uuid.v4();
  sdpHandler = new SDPHandler();
  config: Required<PeerConfig> = cloneDeep<PeerConfig>(defaultPeerConfig);
  connectionState: ConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: IceGathererState = "new";
  signalingState: RTCSignalingState = "stable";
  negotiationneeded = false;
  needRestart = false;
  sctpRemotePort?: number;
  sctpTransport?: RTCSctpTransport;
  private readonly transceivers: RTCRtpTransceiver[] = [];
  private readonly router = new RtpRouter();
  private certificate?: RTCCertificate;
  private seenMid = new Set<string>();
  private currentLocalDescription?: SessionDescription;
  private currentRemoteDescription?: SessionDescription;
  private pendingLocalDescription?: SessionDescription;
  private pendingRemoteDescription?: SessionDescription;
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

    this.iceConnectionStateChange.subscribe((state) => {
      switch (state) {
        case "disconnected":
          this.setConnectionState("disconnected");
          break;
        case "closed":
          this.close();
          break;
      }
    });
  }

  get dtlsTransports() {
    const transports = this.transceivers.map((t) => t.dtlsTransport);
    if (this.sctpTransport) {
      transports.push(this.sctpTransport.dtlsTransport);
    }
    return transports.reduce((acc: RTCDtlsTransport[], cur) => {
      if (!acc.map((d) => d.id).includes(cur.id)) {
        acc.push(cur);
      }
      return acc;
    }, []);
  }
  get iceTransports() {
    return this.dtlsTransports.map((d) => d.iceTransport);
  }

  get extIdUriMap() {
    return this.router.extIdUriMap;
  }

  get iceGeneration() {
    return this.iceTransports[0].connection.generation;
  }

  get localDescription() {
    if (!this._localDescription) {
      return undefined;
    }
    return this._localDescription.toJSON();
  }

  get remoteDescription() {
    if (!this._remoteDescription) {
      return undefined;
    }
    return this._remoteDescription.toJSON();
  }

  /**@private */
  get _localDescription() {
    return this.pendingLocalDescription || this.currentLocalDescription;
  }

  /**@private */
  get _remoteDescription() {
    return this.pendingRemoteDescription || this.currentRemoteDescription;
  }

  private pushTransceiver(t: RTCRtpTransceiver) {
    this.transceivers.push(t);
  }
  private replaceTransceiver(t: RTCRtpTransceiver, index: number) {
    this.transceivers[index] = t;
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

    if (this.config.dtls) {
      const { keys } = this.config.dtls;

      if (keys) {
        this.certificate = new RTCCertificate(
          keys.keyPem,
          keys.certPem,
          keys.signatureHash,
        );
      }
    }
    this.sdpHandler.bundlePolicy = this.config.bundlePolicy;
  }

  private getTransceiverByMLineIndex(index: number) {
    return this.transceivers.find(
      (transceiver) => transceiver.mLineIndex === index,
    );
  }

  getConfiguration() {
    return this.config;
  }

  async createOffer({ iceRestart }: { iceRestart?: boolean } = {}) {
    if (iceRestart || this.needRestart) {
      this.needRestart = false;
      for (const t of this.iceTransports) {
        t.restart();
      }
    }

    await this.ensureCerts();

    this.transceivers.forEach((transceiver) => {
      if (transceiver.codecs.length === 0) {
        this.assignTransceiverCodecs(transceiver);
      }
      if (transceiver.headerExtensions.length === 0) {
        transceiver.headerExtensions =
          this.config.headerExtensions[transceiver.kind] ?? [];
      }
    });

    const description = this.sdpHandler.buildOfferSdp(
      this.transceivers,
      this.sctpTransport,
      this.cname,
      this.currentLocalDescription,
    );
    return description.toJSON();
  }

  private assignTransceiverCodecs(transceiver: RTCRtpTransceiver) {
    const codecs = (
      this.config.codecs[transceiver.kind] as RTCRtpCodecParameters[]
    ).filter((codecCandidate) => {
      switch (codecCandidate.direction) {
        case "recvonly": {
          if (ReceiverDirection.includes(transceiver.direction)) return true;
          return false;
        }
        case "sendonly": {
          if (SenderDirections.includes(transceiver.direction)) return true;
          return false;
        }
        case "sendrecv": {
          if ([Sendrecv, Recvonly, Sendonly].includes(transceiver.direction))
            return true;
          return false;
        }
        case "all": {
          return true;
        }
        default:
          return false;
      }
    });
    transceiver.codecs = codecs;
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
    const base: typeof options = {
      protocol: "",
      ordered: true,
      negotiated: false,
    };
    const settings: Required<typeof base> = { ...base, ...options } as any;

    if (settings.maxPacketLifeTime && settings.maxRetransmits) {
      throw new Error("can not select both");
    }

    if (!this.sctpTransport) {
      this.sctpTransport = this.createSctpTransport();
      this.needNegotiation();
    }

    const parameters = new RTCDataChannelParameters({
      id: settings.id,
      label,
      maxPacketLifeTime: settings.maxPacketLifeTime,
      maxRetransmits: settings.maxRetransmits,
      negotiated: settings.negotiated,
      ordered: settings.ordered,
      protocol: settings.protocol,
    });

    const channel = new RTCDataChannel(this.sctpTransport, parameters);
    return channel;
  }

  removeTrack(sender: RTCRtpSender) {
    if (this.isClosed) throw new Error("peer closed");
    if (!this.getSenders().find(({ ssrc }) => sender.ssrc === ssrc)) {
      throw new Error("unExist");
    }

    const transceiver = this.transceivers.find(
      ({ sender: { ssrc } }) => sender.ssrc === ssrc,
    );
    if (!transceiver) throw new Error("unExist");

    sender.stop();

    if (transceiver.currentDirection === "recvonly") {
      this.needNegotiation();
      return;
    }

    if (transceiver.stopping || transceiver.stopped) {
      transceiver.setDirection("inactive");
    } else {
      if (transceiver.direction === "sendrecv") {
        transceiver.setDirection("recvonly");
      } else if (
        transceiver.direction === "sendonly" ||
        transceiver.direction === "recvonly"
      ) {
        transceiver.setDirection("inactive");
      }
    }
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

  private createTransport(srtpProfiles: SrtpProfile[] = []) {
    const [existing] = this.iceTransports;

    // Gather ICE candidates for only one track. If the remote endpoint is not bundle-aware, negotiate only one media track.
    // https://w3c.github.io/webrtc-pc/#rtcbundlepolicy-enum
    if (this.config.bundlePolicy === "max-bundle") {
      if (existing) {
        return this.dtlsTransports[0];
      }
    }

    const iceGatherer = new RTCIceGatherer({
      ...parseIceServers(this.config.iceServers),
      forceTurn: this.config.iceTransportPolicy === "relay",
      portRange: this.config.icePortRange,
      interfaceAddresses: this.config.iceInterfaceAddresses,
      additionalHostAddresses: this.config.iceAdditionalHostAddresses,
      filterStunResponse: this.config.iceFilterStunResponse,
      filterCandidatePair: this.config.iceFilterCandidatePair,
      localPasswordPrefix: this.config.icePasswordPrefix,
      useIpv4: this.config.iceUseIpv4,
      useIpv6: this.config.iceUseIpv6,
      turnTransport: this.config.forceTurnTCP === true ? "tcp" : "udp",
      useLinkLocalAddress: this.config.iceUseLinkLocalAddress,
    });
    if (existing) {
      iceGatherer.connection.localUsername = existing.connection.localUsername;
      iceGatherer.connection.localPassword = existing.connection.localPassword;
    }
    iceGatherer.onGatheringStateChange.subscribe(() => {
      this.updateIceGatheringState();
    });
    this.updateIceGatheringState();
    const iceTransport = new RTCIceTransport(iceGatherer);
    iceTransport.onStateChange.subscribe(() => {
      this.updateIceConnectionState();
    });
    iceTransport.onNegotiationNeeded.subscribe(() => {
      this.needNegotiation();
    });
    iceTransport.onIceCandidate.subscribe((candidate) => {
      if (!this.localDescription) {
        log("localDescription not found when ice candidate was gathered");
        return;
      }
      if (!candidate) {
        this.setLocal(this._localDescription!);
        this.onIceCandidate.execute(undefined);
        if (this.onicecandidate) {
          this.onicecandidate({ candidate: undefined });
        }
        this.emit("icecandidate", { candidate: undefined });
        return;
      }

      if (this.config.bundlePolicy === "max-bundle" || this.remoteIsBundled) {
        candidate.sdpMLineIndex = 0;
        const media = this._localDescription?.media[0];
        if (media) {
          candidate.sdpMid = media.rtp.muxId;
        }
      } else {
        const transceiver = this.transceivers.find(
          (t) => t.dtlsTransport.iceTransport.id === iceTransport.id,
        );
        if (transceiver) {
          candidate.sdpMLineIndex = transceiver.mLineIndex;
          candidate.sdpMid = transceiver.mid;
        }
        if (
          this.sctpTransport?.dtlsTransport.iceTransport.id === iceTransport.id
        ) {
          candidate.sdpMLineIndex = this.sctpTransport.mLineIndex;
          candidate.sdpMid = this.sctpTransport.mid;
        }
      }

      candidate.foundation = "candidate:" + candidate.foundation;

      this.onIceCandidate.execute(candidate.toJSON());
      if (this.onicecandidate) {
        this.onicecandidate({ candidate: candidate.toJSON() });
      }
      this.emit("icecandidate", { candidate });
    });

    const dtlsTransport = new RTCDtlsTransport(
      this.config,
      iceTransport,
      this.router,
      this.certificate,
      srtpProfiles,
    );

    return dtlsTransport;
  }

  private createSctpTransport() {
    const dtlsTransport = this.createTransport([
      SRTP_PROFILE.SRTP_AEAD_AES_128_GCM, // prefer
      SRTP_PROFILE.SRTP_AES128_CM_HMAC_SHA1_80,
    ]);
    const sctp = new RTCSctpTransport();
    sctp.setDtlsTransport(dtlsTransport);
    sctp.mid = undefined;

    sctp.onDataChannel.subscribe((channel) => {
      this.onDataChannel.execute(channel);

      const event: RTCDataChannelEvent = { channel };
      if (this.ondatachannel) this.ondatachannel(event);
      this.emit("datachannel", event);
    });

    this.sctpTransport = sctp;
    this.updateIceConnectionState();

    return sctp;
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
    const description = SessionDescription.parse(sessionDescription.sdp);
    description.type = sessionDescription.type;
    this.validateDescription(description, true);

    // # update signaling state
    if (description.type === "offer") {
      this.setSignalingState("have-local-offer");
    } else if (description.type === "answer") {
      this.setSignalingState("stable");
    }

    // # assign MID
    for (const [i, media] of enumerate(description.media)) {
      const mid = media.rtp.muxId!;
      this.seenMid.add(mid);
      if (["audio", "video"].includes(media.kind)) {
        const transceiver = this.getTransceiverByMLineIndex(i);
        if (transceiver) {
          transceiver.mid = mid;
        }
      }
      if (media.kind === "application" && this.sctpTransport) {
        this.sctpTransport.mid = mid;
      }
    }

    // setup ice,dtls role
    for (const dtlsTransport of this.dtlsTransports) {
      const iceTransport = dtlsTransport.iceTransport;

      // # set ICE role
      if (description.type === "offer") {
        iceTransport.connection.iceControlling = true;
      } else {
        iceTransport.connection.iceControlling = false;
      }
      // One agent full, one lite:  The full agent MUST take the controlling role, and the lite agent MUST take the controlled role
      // RFC 8445 S6.1.1
      if (iceTransport.connection.remoteIsLite) {
        iceTransport.connection.iceControlling = true;
      }

      // # set DTLS role for mediasoup
      if (description.type === "answer") {
        const role = description.media.find((media) => media.dtlsParams)
          ?.dtlsParams?.role;
        if (role) {
          dtlsTransport.role = role;
        }
      }
    }

    // # configure direction
    if (["answer", "pranswer"].includes(description.type)) {
      for (const t of this.transceivers) {
        const direction = andDirection(t.direction, t.offerDirection);
        t.setCurrentDirection(direction);
      }
    }

    // for trickle ice
    this.setLocal(description);

    await this.gatherCandidates().catch((e) => {
      log("gatherCandidates failed", e);
    });

    // connect transports
    if (description.type === "answer") {
      this.connect().catch((err) => {
        log("connect failed", err);
        this.setConnectionState("failed");
      });
    }

    this.setLocal(description);

    if (this.shouldNegotiationneeded) {
      this.needNegotiation();
    }

    return description;
  }

  private async gatherCandidates() {
    // # gather candidates
    const connected = this.iceTransports.find(
      (transport) =>
        transport.state === "connected" || transport.state === "completed",
    );
    if (this.remoteIsBundled && connected) {
      // no need to gather ice candidates on an existing bundled connection
    } else {
      await Promise.allSettled(
        this.iceTransports.map((iceTransport) => iceTransport.gather()),
      );
    }
  }

  private setLocal(description: SessionDescription) {
    description.media
      .filter((m) => ["audio", "video"].includes(m.kind))
      .forEach((m, i) => {
        this.sdpHandler.addTransportDescription(
          m,
          this.transceivers[i].dtlsTransport,
        );
      });
    const sctpMedia = description.media.find((m) => m.kind === "application");
    if (this.sctpTransport && sctpMedia) {
      this.sdpHandler.addTransportDescription(
        sctpMedia,
        this.sctpTransport.dtlsTransport,
      );
    }

    if (description.type === "answer") {
      this.currentLocalDescription = description;
      this.pendingLocalDescription = undefined;
    } else {
      this.pendingLocalDescription = description;
    }
  }

  private getTransportByMid(mid: string) {
    let iceTransport: RTCIceTransport | undefined;

    const transceiver = this.transceivers.find((t) => t.mid === mid);
    if (transceiver) {
      iceTransport = transceiver.dtlsTransport.iceTransport;
    } else if (!iceTransport && this.sctpTransport?.mid === mid) {
      iceTransport = this.sctpTransport?.dtlsTransport.iceTransport;
    }

    return iceTransport;
  }

  private getTransportByMLineIndex(index: number) {
    const sdp = this.sdpHandler.buildOfferSdp(
      this.transceivers,
      this.sctpTransport,
      this.cname,
      this.currentLocalDescription,
    );
    const media = sdp.media[index];
    if (!media) {
      return;
    }
    const transport = this.getTransportByMid(media.rtp.muxId!);

    return transport;
  }

  async addIceCandidate(
    candidateMessage: RTCIceCandidate | RTCIceCandidateInit,
  ) {
    const candidate = IceCandidate.fromJSON(candidateMessage);
    if (!candidate) {
      return;
    }

    let iceTransport: RTCIceTransport | undefined;

    if (typeof candidate.sdpMid === "number") {
      iceTransport = this.getTransportByMid(candidate.sdpMid);
    }

    if (!iceTransport && typeof candidate.sdpMLineIndex === "number") {
      iceTransport = this.getTransportByMLineIndex(candidate.sdpMLineIndex);
    }

    if (!iceTransport) {
      iceTransport = this.iceTransports[0];
    }

    if (iceTransport) {
      await iceTransport.addRemoteCandidate(candidate);
    } else {
      log("iceTransport not found", candidate);
    }
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

        this.setConnectionState("connecting");

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
          this.sctpRemotePort &&
          this.sctpTransport.dtlsTransport.id === dtlsTransport.id
        ) {
          await this.sctpTransport.start(this.sctpRemotePort);
          await this.sctpTransport.sctp.stateChanged.connected.asPromise();
          log("sctp connected");
        }
      }),
    );

    if (res.find((r) => r.status === "rejected")) {
      this.setConnectionState("failed");
    } else {
      this.setConnectionState("connected");
    }
  }

  private getLocalRtpParams(transceiver: RTCRtpTransceiver): RTCRtpParameters {
    if (transceiver.mid == undefined) throw new Error("mid not assigned");

    const rtp: RTCRtpParameters = {
      codecs: transceiver.codecs,
      muxId: transceiver.mid,
      headerExtensions: transceiver.headerExtensions,
      rtcp: { cname: this.cname, ssrc: transceiver.sender.ssrc, mux: true },
    };
    return rtp;
  }

  private getRemoteRtpParams(
    media: MediaDescription,
    transceiver: RTCRtpTransceiver,
  ): RTCRtpReceiveParameters {
    const receiveParameters: RTCRtpReceiveParameters = {
      muxId: media.rtp.muxId,
      rtcp: media.rtp.rtcp,
      codecs: transceiver.codecs,
      headerExtensions: transceiver.headerExtensions,
      encodings: Object.values(
        transceiver.codecs.reduce(
          (acc: { [pt: number]: RTCRtpCodingParameters }, codec) => {
            if (codec.name.toLowerCase() === "rtx") {
              const params = codecParametersFromString(codec.parameters ?? "");
              const apt = acc[params["apt"]];
              if (apt && media.ssrc.length === 2) {
                apt.rtx = new RTCRtpRtxParameters({ ssrc: media.ssrc[1].ssrc });
              }
              return acc;
            }
            acc[codec.payloadType] = new RTCRtpCodingParameters({
              ssrc: media.ssrc[0]?.ssrc,
              payloadType: codec.payloadType,
            });
            return acc;
          },
          {},
        ),
      ),
    };

    return receiveParameters;
  }

  get remoteIsBundled() {
    const remoteSdp = this._remoteDescription;
    if (!remoteSdp) {
      return undefined;
    }
    const bundle = remoteSdp.group.find(
      (g) => g.semantic === "BUNDLE" && this.config.bundlePolicy !== "disable",
    );
    return bundle;
  }

  restartIce() {
    this.needRestart = true;
    this.needNegotiation();
  }

  async setRemoteDescription(sessionDescription: RTCSessionDescriptionInit) {
    if (
      !sessionDescription.sdp ||
      !sessionDescription.type ||
      sessionDescription.type === "rollback" ||
      sessionDescription.type === "pranswer"
    ) {
      throw new Error("invalid sessionDescription");
    }

    // # parse and validate description
    const remoteSdp = SessionDescription.parse(sessionDescription.sdp);
    remoteSdp.type = sessionDescription.type;
    this.validateDescription(remoteSdp, false);

    if (remoteSdp.type === "answer") {
      this.currentRemoteDescription = remoteSdp;
      this.pendingRemoteDescription = undefined;
    } else {
      this.pendingRemoteDescription = remoteSdp;
    }

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
        let transceiver = this.transceivers.find((t) =>
          matchTransceiverWithMedia(t, remoteMedia),
        );
        if (!transceiver) {
          // create remote transceiver
          transceiver = this._addTransceiver(remoteMedia.kind, {
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

        if (this.remoteIsBundled) {
          if (!bundleTransport) {
            bundleTransport = transceiver.dtlsTransport;
          } else {
            transceiver.setDtlsTransport(bundleTransport);
          }
        }

        dtlsTransport = transceiver.dtlsTransport;

        this.setRemoteRTP(transceiver, remoteMedia, remoteSdp.type, i);
      } else if (remoteMedia.kind === "application") {
        if (!this.sctpTransport) {
          this.sctpTransport = this.createSctpTransport();
          this.sctpTransport.mid = remoteMedia.rtp.muxId;
        }

        if (this.remoteIsBundled) {
          if (!bundleTransport) {
            bundleTransport = this.sctpTransport.dtlsTransport;
          } else {
            this.sctpTransport.setDtlsTransport(bundleTransport);
          }
        }

        dtlsTransport = this.sctpTransport.dtlsTransport;

        this.setRemoteSCTP(remoteMedia, this.sctpTransport, i);
      } else {
        throw new Error("invalid media kind");
      }

      const iceTransport = dtlsTransport.iceTransport;

      if (remoteMedia.iceParams) {
        const renomination = !!remoteSdp.media.find(
          (m) => m.direction === "inactive",
        );
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

    const removedTransceivers = this.transceivers.filter(
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
        this.setConnectionState("failed");
      });
    }

    this.negotiationneeded = false;
    if (this.shouldNegotiationneeded) {
      this.needNegotiation();
    }
  }

  private setRemoteRTP(
    transceiver: RTCRtpTransceiver,
    remoteMedia: MediaDescription,
    type: "offer" | "answer",
    mLineIndex: number,
  ) {
    if (!transceiver.mid) {
      transceiver.mid = remoteMedia.rtp.muxId;
    }
    transceiver.mLineIndex = mLineIndex;

    // # negotiate codecs
    transceiver.codecs = remoteMedia.rtp.codecs.filter((remoteCodec) => {
      const localCodecs = this.config.codecs[remoteMedia.kind] || [];

      const existCodec = findCodecByMimeType(localCodecs, remoteCodec);
      if (!existCodec) {
        return false;
      }

      if (existCodec?.name.toLowerCase() === "rtx") {
        const params = codecParametersFromString(existCodec.parameters ?? "");
        const pt = params["apt"];
        const origin = remoteMedia.rtp.codecs.find((c) => c.payloadType === pt);
        if (!origin) {
          return false;
        }
        return !!findCodecByMimeType(localCodecs, origin);
      }

      return true;
    });

    log("negotiated codecs", transceiver.codecs);
    if (transceiver.codecs.length === 0) {
      throw new Error("negotiate codecs failed.");
    }
    transceiver.headerExtensions = remoteMedia.rtp.headerExtensions.filter(
      (extension) =>
        (this.config.headerExtensions[remoteMedia.kind as Media] || []).find(
          (v) => v.uri === extension.uri,
        ),
    );

    // # configure direction
    const mediaDirection = remoteMedia.direction ?? "inactive";
    const direction = reverseDirection(mediaDirection);
    if (["answer", "pranswer"].includes(type)) {
      transceiver.setCurrentDirection(direction);
    } else {
      transceiver.offerDirection = direction;
    }
    const localParams = this.getLocalRtpParams(transceiver);
    transceiver.sender.prepareSend(localParams);

    if (["recvonly", "sendrecv"].includes(transceiver.direction)) {
      const remotePrams = this.getRemoteRtpParams(remoteMedia, transceiver);

      // register simulcast receiver
      remoteMedia.simulcastParameters.forEach((param) => {
        this.router.registerRtpReceiverByRid(transceiver, param, remotePrams);
      });

      transceiver.receiver.prepareReceive(remotePrams);
      // register ssrc receiver
      this.router.registerRtpReceiverBySsrc(transceiver, remotePrams);
    }
    if (["sendonly", "sendrecv"].includes(mediaDirection)) {
      if (remoteMedia.msid) {
        const [streamId, trackId] = remoteMedia.msid.split(" ");
        transceiver.receiver.remoteStreamId = streamId;
        transceiver.receiver.remoteTrackId = trackId;
      }

      this.fireOnTrack(
        transceiver.receiver.track,
        transceiver,
        new MediaStream({
          id: transceiver.receiver.remoteStreamId,
          tracks: [transceiver.receiver.track],
        }),
      );
    }

    if (remoteMedia.ssrc[0]?.ssrc) {
      transceiver.receiver.setupTWCC(remoteMedia.ssrc[0].ssrc);
    }
  }

  private setRemoteSCTP(
    remoteMedia: MediaDescription,
    sctpTransport: RTCSctpTransport,
    mLineIndex: number,
  ) {
    // # configure sctp
    this.sctpRemotePort = remoteMedia.sctpPort;
    if (!this.sctpRemotePort) {
      throw new Error("sctpRemotePort not exist");
    }

    sctpTransport.setRemotePort(this.sctpRemotePort);
    sctpTransport.mLineIndex = mLineIndex;
    if (!sctpTransport.mid) {
      sctpTransport.mid = remoteMedia.rtp.muxId;
    }
  }

  private validateDescription(
    description: SessionDescription,
    isLocal: boolean,
  ) {
    if (isLocal) {
      if (description.type === "offer") {
        if (!["stable", "have-local-offer"].includes(this.signalingState))
          throw new Error("Cannot handle offer in signaling state");
      } else if (description.type === "answer") {
        if (
          !["have-remote-offer", "have-local-pranswer"].includes(
            this.signalingState,
          )
        ) {
          throw new Error("Cannot handle answer in signaling state");
        }
      }
    } else {
      if (description.type === "offer") {
        if (!["stable", "have-remote-offer"].includes(this.signalingState)) {
          throw new Error("Cannot handle offer in signaling state");
        }
      } else if (description.type === "answer") {
        if (
          !["have-local-offer", "have-remote-pranswer"].includes(
            this.signalingState,
          )
        ) {
          throw new Error("Cannot handle answer in signaling state");
        }
      }
    }

    description.media.forEach((media) => {
      if (media.direction === "inactive") return;
      if (
        !media.iceParams ||
        !media.iceParams.usernameFragment ||
        !media.iceParams.password
      )
        throw new Error("ICE username fragment or password is missing");
    });

    if (["answer", "pranswer"].includes(description.type || "")) {
      const offer = isLocal ? this._remoteDescription : this._localDescription;
      if (!offer) throw new Error();

      const answerMedia = description.media.map((v, i) => [v.kind, i]);
      const offerMedia = offer.media.map((v, i) => [v.kind, i]);
      if (!isEqual(offerMedia, answerMedia)) {
        throw new Error("Media sections in answer do not match offer");
      }
    }
  }

  private fireOnTrack(
    track: MediaStreamTrack,
    transceiver: RTCRtpTransceiver,
    stream: MediaStream,
  ) {
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
  }

  addTransceiver(
    trackOrKind: Kind | MediaStreamTrack,
    options: Partial<TransceiverOptions> = {},
  ) {
    return this._addTransceiver(trackOrKind, options);
  }

  private _addTransceiver(
    trackOrKind: Kind | MediaStreamTrack,
    options: Partial<TransceiverOptions> = {},
  ) {
    const kind =
      typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;

    const direction = options.direction || "sendrecv";

    const dtlsTransport = this.createTransport([
      SRTP_PROFILE.SRTP_AEAD_AES_128_GCM, // prefer
      SRTP_PROFILE.SRTP_AES128_CM_HMAC_SHA1_80,
    ]);

    const sender = new RTCRtpSender(trackOrKind);
    const receiver = new RTCRtpReceiver(this.config, kind, sender.ssrc);
    const newTransceiver = new RTCRtpTransceiver(
      kind,
      dtlsTransport,
      receiver,
      sender,
      direction,
    );
    newTransceiver.options = options;
    this.router.registerRtpSender(newTransceiver.sender);

    // reuse inactive
    const inactiveTransceiverIndex = this.transceivers.findIndex(
      (t) => t.currentDirection === "inactive",
    );
    const inactiveTransceiver = this.transceivers.find(
      (t) => t.currentDirection === "inactive",
    );
    if (inactiveTransceiverIndex > -1 && inactiveTransceiver) {
      this.replaceTransceiver(newTransceiver, inactiveTransceiverIndex);
      newTransceiver.mLineIndex = inactiveTransceiver.mLineIndex;
      inactiveTransceiver.setCurrentDirection(undefined);
    } else {
      this.pushTransceiver(newTransceiver);
    }
    this.onTransceiverAdded.execute(newTransceiver);

    this.updateIceConnectionState();
    this.needNegotiation();

    return newTransceiver;
  }

  getTransceivers() {
    return this.transceivers;
  }

  getSenders(): RTCRtpSender[] {
    return this.getTransceivers().map((t) => t.sender);
  }

  getReceivers() {
    return this.getTransceivers().map((t) => t.receiver);
  }

  // todo fix
  addTrack(
    track: MediaStreamTrack,
    /**todo impl */
    ms?: MediaStream,
  ) {
    if (this.isClosed) {
      throw new Error("is closed");
    }
    if (this.getSenders().find((sender) => sender.track?.uuid === track.uuid)) {
      throw new Error("track exist");
    }

    const emptyTrackSender = this.transceivers.find(
      (t) =>
        t.sender.track == undefined &&
        t.kind === track.kind &&
        SenderDirections.includes(t.direction) === true,
    );
    if (emptyTrackSender) {
      const sender = emptyTrackSender.sender;
      sender.registerTrack(track);
      this.needNegotiation();
      return sender;
    }

    const notSendTransceiver = this.transceivers.find(
      (t) =>
        t.sender.track == undefined &&
        t.kind === track.kind &&
        SenderDirections.includes(t.direction) === false &&
        !t.usedForSender,
    );
    if (notSendTransceiver) {
      const sender = notSendTransceiver.sender;
      sender.registerTrack(track);
      switch (notSendTransceiver.direction) {
        case "recvonly":
          notSendTransceiver.setDirection("sendrecv");
          break;
        case "inactive":
          notSendTransceiver.setDirection("sendonly");
          break;
      }
      this.needNegotiation();
      return sender;
    } else {
      const transceiver = this._addTransceiver(track, {
        direction: "sendrecv",
      });
      this.needNegotiation();
      return transceiver.sender;
    }
  }

  private async ensureCerts() {
    if (!this.certificate) {
      this.certificate = await RTCDtlsTransport.SetupCertificate();
    }

    for (const dtlsTransport of this.dtlsTransports) {
      dtlsTransport.localCertificate = this.certificate;
    }
  }

  async createAnswer() {
    await this.ensureCerts();

    const description = this.buildAnswer();
    return description.toJSON();
  }

  private buildAnswer() {
    this.assertNotClosed();
    if (
      !["have-remote-offer", "have-local-pranswer"].includes(
        this.signalingState,
      )
    ) {
      throw new Error("createAnswer failed");
    }
    if (!this._remoteDescription) {
      throw new Error("wrong state");
    }

    return this.sdpHandler.buildAnswerSdp(
      this.transceivers,
      this.sctpTransport,
      this.cname,
      this._remoteDescription,
    );
  }

  async close() {
    if (this.isClosed) return;

    this.isClosed = true;
    this.setSignalingState("closed");
    this.setConnectionState("closed");

    this.transceivers.forEach((transceiver) => {
      transceiver.receiver.stop();
      transceiver.sender.stop();
    });

    if (this.sctpTransport) {
      await this.sctpTransport.stop();
    }
    for (const dtlsTransport of this.dtlsTransports) {
      await dtlsTransport.stop();
      await dtlsTransport.iceTransport.stop();
    }

    this.dispose();
    log("peerConnection closed");
  }

  private assertNotClosed() {
    if (this.isClosed) {
      throw new Error("RTCPeerConnection is closed");
    }
  }

  // https://w3c.github.io/webrtc-pc/#dom-rtcicegatheringstate
  private updateIceGatheringState() {
    const all = this.iceTransports;

    function allMatch(...state: IceGathererState[]) {
      return (
        all.filter((check) => state.includes(check.gatheringState)).length ===
        all.length
      );
    }

    let newState: IceGathererState;

    if (all.length && allMatch("complete")) {
      newState = "complete";
    } else if (!all.length || allMatch("new", "complete")) {
      newState = "new";
    } else if (all.map((check) => check.gatheringState).includes("gathering")) {
      newState = "gathering";
    } else {
      newState = "new";
    }

    if (this.iceGatheringState === newState) {
      return;
    }

    log("iceGatheringStateChange", newState);
    this.iceGatheringState = newState;
    this.iceGatheringStateChange.execute(newState);
    this.emit("icegatheringstatechange", newState);
  }

  // https://w3c.github.io/webrtc-pc/#dom-rtciceconnectionstate
  private updateIceConnectionState() {
    const all = this.iceTransports;
    let newState: RTCIceConnectionState;

    function allMatch(...state: RTCIceConnectionState[]) {
      return (
        all.filter((check) => state.includes(check.state)).length === all.length
      );
    }

    if (this.connectionState === "closed") {
      newState = "closed";
    } else if (allMatch("failed")) {
      newState = "failed";
    } else if (allMatch("disconnected")) {
      newState = "disconnected";
    } else if (allMatch("new", "closed")) {
      newState = "new";
    } else if (allMatch("new", "checking")) {
      newState = "checking";
    } else if (allMatch("completed", "closed")) {
      newState = "completed";
    } else if (allMatch("connected", "completed", "closed")) {
      newState = "connected";
    } else {
      // unreachable?
      newState = "new";
    }

    if (this.iceConnectionState === newState) {
      return;
    }

    log("iceConnectionStateChange", newState);
    this.iceConnectionState = newState;
    this.iceConnectionStateChange.execute(newState);
    this.emit("iceconnectionstatechange", newState);
    if (this.oniceconnectionstatechange) {
      this.oniceconnectionstatechange();
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

  private setConnectionState(state: ConnectionState) {
    log("connectionStateChange", state);
    this.connectionState = state;
    this.connectionStateChange.execute(state);
    if (this.onconnectionstatechange) {
      this.onconnectionstatechange();
    }
    this.emit("connectionstatechange");
  }

  private dispose() {
    this.onDataChannel.allUnsubscribe();
    this.iceGatheringStateChange.allUnsubscribe();
    this.iceConnectionStateChange.allUnsubscribe();
    this.signalingStateChange.allUnsubscribe();
    this.onTransceiverAdded.allUnsubscribe();
    this.onRemoteTransceiverAdded.allUnsubscribe();
    this.onIceCandidate.allUnsubscribe();
  }
}

export type BundlePolicy = "max-compat" | "max-bundle" | "disable";

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

type Media = "audio" | "video";

export interface RTCSessionDescriptionInit {
  sdp?: string;
  type: RTCSdpType;
}
export type RTCSdpType = "answer" | "offer" | "pranswer" | "rollback";
