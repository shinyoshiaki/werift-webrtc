import { isEqual, cloneDeep } from "lodash";
import Event from "rx.mini";
import * as uuid from "uuid";
import { enumerate } from "./helper";
import { ConnectionState, Kind, SignalingState } from "./types/domain";
import { IceOptions } from "../../ice/src";
import {
  DISCARD_HOST,
  DISCARD_PORT,
  SenderDirections,
  SRTP_PROFILE,
} from "./const";
import { RTCDataChannel, RTCDataChannelParameters } from "./dataChannel";
import {
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpParameters,
  RTCRtpReceiveParameters,
  RTCRtpSimulcastParameters,
} from "./media/parameters";
import { RtpRouter } from "./media/router";
import { RTCRtpReceiver } from "./media/rtpReceiver";
import { RTCRtpSender } from "./media/rtpSender";
import {
  Direction,
  RTCRtpTransceiver,
  TransceiverOptions,
} from "./media/rtpTransceiver";
import {
  addSDPHeader,
  GroupDescription,
  MediaDescription,
  RTCSessionDescription,
  SessionDescription,
  SsrcDescription,
} from "./sdp";
import {
  RTCCertificate,
  RTCDtlsParameters,
  RTCDtlsTransport,
} from "./transport/dtls";
import {
  IceGathererState,
  IceTransportState,
  RTCIceCandidate,
  RTCIceCandidateJSON,
  RTCIceGatherer,
  RTCIceParameters,
  RTCIceTransport,
} from "./transport/ice";
import { RTCSctpTransport } from "./transport/sctp";
import {
  andDirection,
  reverseDirection,
  reverseSimulcastDirection,
} from "./utils";
import debug from "debug";
import { MediaStreamTrack } from "./media/track";

const log = debug("werift/webrtc/peerConnection");

export class RTCPeerConnection {
  readonly cname = uuid.v4();
  dtlsTransport?: RTCDtlsTransport;
  sctpTransport?: RTCSctpTransport;
  masterTransportEstablished = false;
  configuration: Required<PeerConfig> = cloneDeep<PeerConfig>(
    defaultPeerConfig
  );
  connectionState: ConnectionState = "new";
  iceConnectionState: IceTransportState = "new";
  iceGatheringState: IceGathererState = "new";
  signalingState: SignalingState = "stable";
  negotiationneeded = false;
  readonly transceivers: RTCRtpTransceiver[] = [];
  readonly iceGatheringStateChange = new Event<[IceGathererState]>();
  readonly iceConnectionStateChange = new Event<[IceTransportState]>();
  readonly signalingStateChange = new Event<[SignalingState]>();
  readonly connectionStateChange = new Event<[ConnectionState]>();
  readonly onDataChannel = new Event<[RTCDataChannel]>();
  readonly onTransceiver = new Event<[RTCRtpTransceiver]>();
  readonly onIceCandidate = new Event<[RTCIceCandidate]>();
  readonly onnegotiationneeded = new Event<[]>();

  private readonly router = new RtpRouter();
  private readonly certificates: RTCCertificate[] = [];
  private sctpRemotePort?: number;
  private remoteDtls?: RTCDtlsParameters;
  private remoteIce?: RTCIceParameters;
  private seenMid = new Set<string>();
  private currentLocalDescription?: SessionDescription;
  private currentRemoteDescription?: SessionDescription;
  private pendingLocalDescription?: SessionDescription;
  private pendingRemoteDescription?: SessionDescription;
  private isClosed = false;

  constructor({
    codecs,
    headerExtensions,
    iceConfig,
  }: Partial<PeerConfig> = {}) {
    if (iceConfig) this.configuration.iceConfig = iceConfig;
    if (codecs?.audio) {
      this.configuration.codecs.audio = codecs.audio;
    }
    if (codecs?.video) {
      this.configuration.codecs.video = codecs.video;
    }
    [
      ...(this.configuration.codecs.audio || []),
      ...(this.configuration.codecs.video || []),
    ].forEach((v, i) => {
      v.payloadType = 96 + i;
    });
    if (headerExtensions?.audio) {
      this.configuration.headerExtensions.audio = headerExtensions.audio;
    }
    if (headerExtensions?.video) {
      this.configuration.headerExtensions.video = headerExtensions.video;
    }
    [
      ...(this.configuration.headerExtensions.audio || []),
      ...(this.configuration.headerExtensions.video || []),
    ].forEach((v, i) => {
      v.id = 1 + i;
    });

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

  get localDescription() {
    if (!this._localDescription) return;
    return wrapSessionDescription(this._localDescription);
  }

  get remoteDescription() {
    if (!this._remoteDescription) return;
    return wrapSessionDescription(this._remoteDescription);
  }

  private get _localDescription() {
    return this.pendingLocalDescription || this.currentLocalDescription;
  }

  private get _remoteDescription() {
    return this.pendingRemoteDescription || this.currentRemoteDescription;
  }

  private getTransceiverByMid(mid: string) {
    return this.transceivers.find((transceiver) => transceiver.mid === mid);
  }

  private getTransceiverByMLineIndex(index: number) {
    return this.transceivers.find(
      (transceiver) => transceiver.mLineIndex === index
    );
  }

  async createOffer() {
    if (
      (!this.sctpTransport && this.transceivers.length === 0) ||
      !this.dtlsTransport
    )
      throw new Error(
        "Cannot create an offer with no media and no data channels"
      );

    if (this.certificates.length === 0) {
      await this.dtlsTransport.setupCertificate();
    }

    this.transceivers.forEach((transceiver) => {
      transceiver.codecs = this.configuration.codecs[transceiver.kind];
      transceiver.headerExtensions = this.configuration.headerExtensions[
        transceiver.kind
      ];
    });

    const description = new SessionDescription();
    addSDPHeader("offer", description);

    // # handle existing transceivers / sctp

    const currentMedia = this._localDescription
      ? this._localDescription.media
      : [];

    currentMedia.forEach((m, i) => {
      const mid = m.rtp.muxId;
      if (!mid) {
        log("mid missing", m);
        return;
      }
      if (m.kind === "application") {
        description.media.push(
          createMediaDescriptionForSctp(this.sctpTransport!, mid)
        );
      } else {
        const transceiver = this.getTransceiverByMid(mid);
        if (!transceiver) {
          log("transceiver by mid not found", mid);
          return;
        }
        transceiver.mLineIndex = i;
        description.media.push(
          createMediaDescriptionForTransceiver(
            transceiver,
            this.cname,
            transceiver.direction,
            mid
          )
        );
      }
    });

    // # handle new transceivers / sctp
    this.transceivers
      .filter((t) => !description.media.find((m) => m.rtp.muxId === t.mid))
      .forEach((transceiver) => {
        transceiver.mLineIndex = description.media.length;
        description.media.push(
          createMediaDescriptionForTransceiver(
            transceiver,
            this.cname,
            transceiver.direction,
            allocateMid(this.seenMid)
          )
        );
      });

    if (
      this.sctpTransport &&
      !description.media.find((m) => this.sctpTransport!.mid === m.rtp.muxId)
    ) {
      description.media.push(
        createMediaDescriptionForSctp(
          this.sctpTransport,
          allocateMid(this.seenMid)
        )
      );
    }

    const mids = description.media
      .map((m) => m.rtp.muxId)
      .filter((v) => v) as string[];
    const bundle = new GroupDescription("BUNDLE", mids);
    description.group.push(bundle);

    return wrapSessionDescription(description);
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
    }> = {}
  ) {
    const base: typeof options = {
      protocol: "",
      ordered: true,
      negotiated: false,
    };
    const settings: Required<typeof base> = { ...base, ...options } as any;

    if (settings.maxPacketLifeTime && settings.maxRetransmits)
      throw new Error("can not select both");

    if (!this.sctpTransport) {
      this.sctpTransport = this.createSctpTransport();
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

    return new RTCDataChannel(this.sctpTransport, parameters);
  }

  removeTrack(sender: RTCRtpSender) {
    if (this.isClosed) throw new Error("peer closed");
    if (!this.getSenders().find(({ ssrc }) => sender.ssrc === ssrc))
      throw new Error("unExist");

    const transceiver = this.transceivers.find(
      ({ sender: { ssrc } }) => sender.ssrc === ssrc
    );
    if (!transceiver) throw new Error("unExist");

    sender.stop();

    if (transceiver.direction === "sendrecv") {
      transceiver.direction = "recvonly";
    } else if (
      transceiver.direction === "sendonly" ||
      transceiver.direction === "recvonly"
    ) {
      transceiver.direction = "inactive";
    }
    this.needNegotiation();
  }

  private needNegotiation = () => {
    this.negotiationneeded = true;
    this.onnegotiationneeded.execute();
  };

  private createDtlsTransport(srtpProfiles: number[] = []) {
    if (this.dtlsTransport) return this.dtlsTransport;

    const iceGatherer = new RTCIceGatherer(this.configuration.iceConfig);
    iceGatherer.onGatheringStateChange.subscribe((state) => {
      this.updateIceGatheringState(state);
    });
    this.updateIceGatheringState(iceGatherer.gatheringState);
    const iceTransport = new RTCIceTransport(iceGatherer);
    iceTransport.onStateChange.subscribe((state) => {
      this.updateIceConnectionState(state);
    });
    this.updateIceConnectionState(iceTransport.state);

    iceTransport.iceGather.onIceCandidate = (candidate) => {
      if (!this.localDescription) return;
      const sdp = SessionDescription.parse(this.localDescription.sdp);
      const media = sdp.media[0];
      candidate.sdpMLineIndex = 0;
      candidate.sdpMid = media.rtp.muxId;
      this.onIceCandidate.execute(candidate);
    };

    const dtls = new RTCDtlsTransport(
      iceTransport,
      this.router,
      this.certificates,
      srtpProfiles
    );
    this.dtlsTransport = dtls;

    return dtls;
  }

  private createSctpTransport() {
    const sctp = new RTCSctpTransport(
      this.createDtlsTransport([SRTP_PROFILE.SRTP_AES128_CM_HMAC_SHA1_80])
    );
    sctp.mid = undefined;

    sctp.onDataChannel.subscribe((dc) => {
      this.onDataChannel.execute(dc);
    });

    return sctp;
  }

  async setLocalDescription(sessionDescription: RTCSessionDescription) {
    const { dtlsTransport } = this;
    if (!dtlsTransport) throw new Error("seems no media");

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
    description.media.forEach((media, i) => {
      const mid = media.rtp.muxId;
      if (!mid) {
        log("mid missing");
        return;
      }
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
    });

    // # set ICE role
    const iceTransport = dtlsTransport.iceTransport;
    if (description.type === "offer") {
      iceTransport.connection.iceControlling = true;
      iceTransport.roleSet = true;
    } else {
      iceTransport.connection.iceControlling = false;
      iceTransport.roleSet = true;
    }

    // # configure direction
    this.transceivers.forEach((t) => {
      if (["answer", "pranswer"].includes(description.type)) {
        const direction = andDirection(t.direction, t.offerDirection);
        t.currentDirection = direction;
      }
    });

    // for trickle ice
    this.setLocal(description);

    // # gather candidates
    await dtlsTransport.iceTransport.iceGather.gather();
    description.media.map((media) => {
      addTransportDescription(media, dtlsTransport);
    });

    this.setLocal(description);

    return this.localDescription;
  }

  private setLocal(description: SessionDescription) {
    if (description.type === "answer") {
      this.currentLocalDescription = description;
      this.pendingLocalDescription = undefined;
    } else {
      this.pendingLocalDescription = description;
    }
  }

  async addIceCandidate(candidateMessage: RTCIceCandidateJSON) {
    if (!this.dtlsTransport) throw new Error();

    const candidate = RTCIceCandidate.fromJSON(candidateMessage);

    const iceTransport = this.dtlsTransport.iceTransport;
    await iceTransport.addRemoteCandidate(candidate);
  }

  private async connect() {
    if (this.masterTransportEstablished || !this.dtlsTransport) return;

    const dtlsTransport = this.dtlsTransport;
    const iceTransport = dtlsTransport.iceTransport;

    if (this.remoteIce && this.remoteDtls) {
      this.setConnectionState("connecting");

      await iceTransport.start(this.remoteIce);
      await dtlsTransport.start(this.remoteDtls);

      if (this.sctpTransport && this.sctpRemotePort) {
        await this.sctpTransport.start(this.sctpRemotePort);
        await this.sctpTransport.sctp.stateChanged.connected.asPromise();
      }

      this.masterTransportEstablished = true;

      this.setConnectionState("connected");
    }
  }

  private localRtp(transceiver: RTCRtpTransceiver) {
    const rtp = new RTCRtpParameters({
      headerExtensions: transceiver.headerExtensions,
      rtcp: { cname: this.cname, ssrc: transceiver.sender.ssrc, mux: true },
    });
    return rtp;
  }

  private remoteRtp(transceiver: RTCRtpTransceiver) {
    const media = this._remoteDescription!.media[transceiver.mLineIndex!];
    const receiveParameters = new RTCRtpReceiveParameters({
      codecs: transceiver.codecs,
      muxId: media.rtp.muxId,
      rtcp: media.rtp.rtcp,
    });
    const encodings = transceiver.codecs.map(
      (codec) =>
        new RTCRtpCodingParameters({
          ssrc: media.ssrc[0]?.ssrc,
          payloadType: codec.payloadType,
        })
    );
    receiveParameters.encodings = encodings;
    receiveParameters.headerExtensions = transceiver.headerExtensions;
    return receiveParameters;
  }

  private validateDescription(
    description: SessionDescription,
    isLocal: boolean
  ) {
    if (isLocal) {
      if (description.type === "offer") {
        if (!["stable", "have-local-offer"].includes(this.signalingState))
          throw new Error("Cannot handle offer in signaling state");
      } else if (description.type === "answer") {
        if (
          !["have-remote-offer", "have-local-pranswer"].includes(
            this.signalingState
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
            this.signalingState
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

      const offerMedia = offer.media.map((v) => [v.kind, v.rtp.muxId]);
      const answerMedia = description.media.map((v) => [v.kind, v.rtp.muxId]);
      if (!isEqual(offerMedia, answerMedia))
        throw new Error("Media sections in answer do not match offer");
    }
  }

  async setRemoteDescription(sessionDescription: RTCSessionDescription) {
    // # parse and validate description
    const description = SessionDescription.parse(sessionDescription.sdp);
    description.type = sessionDescription.type;
    this.validateDescription(description, false);

    // # apply description
    for (const [i, media] of enumerate(description.media)) {
      let dtlsTransport: RTCDtlsTransport | undefined;

      if (["audio", "video"].includes(media.kind)) {
        const transceiver =
          this.transceivers.find(
            (t) =>
              t.kind === media.kind &&
              [undefined, media.rtp.muxId].includes(t.mid)
          ) ||
          (() => {
            const transceiver = this.addTransceiver(media.kind, {
              direction: "recvonly",
            });
            this.onTransceiver.execute(transceiver);
            return transceiver;
          })();

        // simulcast
        media.simulcastParameters.forEach((param) => {
          this.router.registerRtpReceiverByRid(transceiver, param);
        });

        dtlsTransport = transceiver.dtlsTransport;

        if (!transceiver.mid) {
          transceiver.mid = media.rtp.muxId;
          transceiver.mLineIndex = i;
        }

        // # negotiate codecs
        log("remote codecs", media.rtp.codecs);
        transceiver.codecs = media.rtp.codecs.filter((remoteCodec) =>
          (
            this.configuration.codecs[media.kind as "audio" | "video"] || []
          ).find(
            (localCodec) =>
              localCodec.mimeType.toLowerCase() ===
              remoteCodec.mimeType.toLowerCase()
          )
        );
        log("negotiated codecs", transceiver.codecs);
        if (transceiver.codecs.length === 0) {
          throw new Error("negotiate codecs failed.");
        }
        transceiver.headerExtensions = media.rtp.headerExtensions.filter(
          (extension) =>
            (
              this.configuration.headerExtensions[
                media.kind as "video" | "audio"
              ] || []
            ).find((v) => v.uri === extension.uri)
        );
        transceiver.receiver.setupTWCC(media.ssrc[0]?.ssrc);

        // # configure direction
        const direction = reverseDirection(media.direction || "inactive");
        if (["answer", "pranswer"].includes(description.type)) {
          transceiver.currentDirection = direction;
        } else {
          transceiver.offerDirection = direction;
        }

        if (media.dtlsParams && media.iceParams) {
          this.remoteDtls = media.dtlsParams;
          this.remoteIce = media.iceParams;
        }
      } else if (media.kind === "application") {
        if (!this.sctpTransport) {
          this.sctpTransport = this.createSctpTransport();
        }

        dtlsTransport = this.sctpTransport.dtlsTransport;

        if (!this.sctpTransport.mid) {
          this.sctpTransport.mid = media.rtp.muxId;
        }

        // # configure sctp
        this.sctpRemotePort = media.sctpPort;

        if (media.dtlsParams && media.iceParams) {
          this.remoteDtls = media.dtlsParams;
          this.remoteIce = media.iceParams;
        }
      }

      if (dtlsTransport) {
        // # add ICE candidates
        const iceTransport = dtlsTransport.iceTransport;
        media.iceCandidates.forEach(iceTransport.addRemoteCandidate);

        await iceTransport.iceGather.gather();

        if (media.iceCandidatesComplete) {
          await iceTransport.addRemoteCandidate(undefined);
        }

        if (description.type === "offer" && !iceTransport.roleSet) {
          iceTransport.connection.iceControlling = media.iceParams!.iceLite;
          iceTransport.roleSet = true;
        }

        if (description.type === "answer") {
          dtlsTransport.role =
            media.dtlsParams?.role === "client" ? "server" : "client";
          this.negotiationneeded = false;
        }
      }
    }

    // connect transports
    this.connect();

    if (description.type === "offer") {
      this.setSignalingState("have-remote-offer");
    } else if (description.type === "answer") {
      this.setSignalingState("stable");
    }

    if (description.type === "answer") {
      this.currentRemoteDescription = description;
      this.pendingRemoteDescription = undefined;
    } else {
      this.pendingRemoteDescription = description;
    }

    this.transceivers.forEach((transceiver) => {
      if (["sendonly", "sendrecv"].includes(transceiver.direction)) {
        transceiver.sender.parameters = this.localRtp(transceiver);
      }
      if (["recvonly", "sendrecv"].includes(transceiver.direction)) {
        const params = this.remoteRtp(transceiver);
        this.router.registerRtpReceiverBySsrc(transceiver, params);
      }
    });
  }

  addTransceiver(
    trackOrKind: Kind | MediaStreamTrack,
    options: Partial<TransceiverOptions> = {}
  ) {
    const dtlsTransport = this.createDtlsTransport([
      SRTP_PROFILE.SRTP_AES128_CM_HMAC_SHA1_80,
    ]);

    const kind =
      typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;

    const direction = options.direction || "sendrecv";

    const sender = new RTCRtpSender(trackOrKind, dtlsTransport);
    const receiver = new RTCRtpReceiver(kind, dtlsTransport, sender.ssrc);
    const transceiver = new RTCRtpTransceiver(
      kind,
      receiver,
      sender,
      direction,
      dtlsTransport
    );
    transceiver.options = options;
    this.router.ssrcTable[transceiver.sender.ssrc] = transceiver.sender;

    this.transceivers.push(transceiver);

    return transceiver;
  }

  getTransceivers() {
    return this.transceivers;
  }

  getSenders() {
    return this.getTransceivers().map((t) => t.sender);
  }

  getReceivers() {
    return this.getTransceivers().map((t) => t.receiver);
  }

  addTrack(track: MediaStreamTrack) {
    if (this.isClosed) throw new Error("is closed");
    if (this.getSenders().find((sender) => sender.track?.id === track.id))
      throw new Error("track exist");

    const emptyTrackSender = this.transceivers.find(
      (t) =>
        t.sender.track == undefined &&
        t.kind === track.kind &&
        SenderDirections.includes(t.direction) === true
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
        !t.usedForSender
    );
    if (notSendTransceiver) {
      const sender = notSendTransceiver.sender;
      sender.registerTrack(track);
      switch (notSendTransceiver.direction) {
        case "recvonly":
          notSendTransceiver.direction = "sendrecv";
          break;
        case "inactive":
          notSendTransceiver.direction = "sendonly";
          break;
      }
      this.needNegotiation();
      return sender;
    } else {
      const transceiver = this.addTransceiver(track, { direction: "sendrecv" });
      this.needNegotiation();
      return transceiver.sender;
    }
  }

  async createAnswer() {
    this.assertNotClosed();
    if (
      !["have-remote-offer", "have-local-pranswer"].includes(
        this.signalingState
      ) ||
      !this.dtlsTransport
    )
      throw new Error("createAnswer failed");

    if (this.certificates.length === 0) {
      await this.dtlsTransport.setupCertificate();
    }

    const description = new SessionDescription();
    addSDPHeader("answer", description);

    this._remoteDescription?.media.forEach((remoteM) => {
      let dtlsTransport!: RTCDtlsTransport;
      let media: MediaDescription;

      if (["audio", "video"].includes(remoteM.kind)) {
        const transceiver = this.getTransceiverByMid(remoteM.rtp.muxId!)!;
        media = createMediaDescriptionForTransceiver(
          transceiver,
          this.cname,
          andDirection(transceiver.direction, transceiver.offerDirection),
          transceiver.mid!
        );
        if (!transceiver.dtlsTransport) throw new Error();
        dtlsTransport = transceiver.dtlsTransport;
      } else if (remoteM.kind === "application") {
        if (!this.sctpTransport || !this.sctpTransport.mid) throw new Error();
        media = createMediaDescriptionForSctp(
          this.sctpTransport,
          this.sctpTransport.mid
        );

        dtlsTransport = this.sctpTransport.dtlsTransport;
      } else throw new Error();

      // # determine DTLS role, or preserve the currently configured role
      if (!media.dtlsParams) throw new Error();
      if (dtlsTransport.role === "auto") {
        media.dtlsParams.role = "client";
      } else {
        media.dtlsParams.role = dtlsTransport.role;
      }
      media.simulcastParameters = remoteM.simulcastParameters.map((v) => ({
        ...v,
        direction: reverseSimulcastDirection(v.direction),
      }));
      description.media.push(media);
    });

    const bundle = new GroupDescription("BUNDLE", []);
    description.media.forEach((media) => {
      bundle.items.push(media.rtp.muxId!);
    });
    description.group.push(bundle);

    return wrapSessionDescription(description);
  }

  close() {
    if (this.isClosed) return;

    this.isClosed = true;
    this.setSignalingState("closed");
    this.setConnectionState("closed");

    this.transceivers.forEach((transceiver) => {
      transceiver.receiver.stop();
      transceiver.sender.stop();
    });

    if (this.sctpTransport) {
      this.sctpTransport.stop();
    }
    if (this.dtlsTransport) {
      this.dtlsTransport.stop();
      this.dtlsTransport.iceTransport.stop();
    }

    this.removeAllListeners();
    log("peerConnection closed");
  }

  private assertNotClosed() {
    if (this.isClosed) throw new Error("RTCPeerConnection is closed");
  }

  private updateIceGatheringState(state: IceGathererState) {
    log("iceGatheringStateChange", state);
    this.iceGatheringState = state;
    this.iceGatheringStateChange.execute(state);
  }

  private updateIceConnectionState(state: IceTransportState) {
    log("iceConnectionStateChange", state);
    this.iceConnectionState = state;
    this.iceConnectionStateChange.execute(state);
  }

  private setSignalingState(state: SignalingState) {
    log("signalingStateChange", state);
    this.signalingState = state;
    this.signalingStateChange.execute(state);
  }

  private setConnectionState(state: ConnectionState) {
    log("connectionStateChange", state);
    this.connectionState = state;
    this.connectionStateChange.execute(state);
  }

  private removeAllListeners() {
    this.onDataChannel.allUnsubscribe();
    this.iceGatheringStateChange.allUnsubscribe();
    this.iceConnectionStateChange.allUnsubscribe();
    this.signalingStateChange.allUnsubscribe();
    this.onTransceiver.allUnsubscribe();
    this.onIceCandidate.allUnsubscribe();
  }
}

export function createMediaDescriptionForTransceiver(
  transceiver: RTCRtpTransceiver,
  cname: string,
  direction: Direction,
  mid: string
) {
  const media = new MediaDescription(
    transceiver.kind,
    9,
    "UDP/TLS/RTP/SAVPF",
    transceiver.codecs.map((c) => c.payloadType)
  );
  media.direction = direction;
  media.msid = transceiver.msid;
  media.rtp = new RTCRtpParameters({
    codecs: transceiver.codecs,
    headerExtensions: transceiver.headerExtensions,
    muxId: mid,
  });
  media.rtcpHost = "0.0.0.0";
  media.rtcpPort = 9;
  media.rtcpMux = true;
  media.ssrc = [new SsrcDescription({ ssrc: transceiver.sender.ssrc, cname })];

  if (transceiver.options.simulcast) {
    media.simulcastParameters = transceiver.options.simulcast.map(
      (o) => new RTCRtpSimulcastParameters(o)
    );
  }

  addTransportDescription(media, transceiver.dtlsTransport!);
  return media;
}

export function createMediaDescriptionForSctp(
  sctp: RTCSctpTransport,
  mid: string
) {
  const media = new MediaDescription(
    "application",
    DISCARD_PORT,
    "UDP/DTLS/SCTP",
    ["webrtc-datachannel"]
  );
  media.sctpPort = sctp.port;

  media.rtp.muxId = mid;
  media.sctpCapabilities = RTCSctpTransport.getCapabilities();

  addTransportDescription(media, sctp.dtlsTransport);
  return media;
}

export function addTransportDescription(
  media: MediaDescription,
  dtlsTransport: RTCDtlsTransport
) {
  const iceTransport = dtlsTransport.iceTransport;
  const iceGatherer = iceTransport.iceGather;

  media.iceCandidates = iceGatherer.localCandidates;
  media.iceCandidatesComplete = iceGatherer.gatheringState === "complete";
  media.iceParams = iceGatherer.localParameters;

  if (media.iceCandidates.length > 0) {
    const candidate = media.iceCandidates[media.iceCandidates.length - 1];
    media.host = candidate.ip;
    media.port = candidate.port;
  } else {
    media.host = DISCARD_HOST;
    media.port = DISCARD_PORT;
  }

  if (media.direction === "inactive") {
    media.port = 0;
  }

  if (!media.dtlsParams) {
    media.dtlsParams = dtlsTransport.localParameters;
    if (!media.dtlsParams.fingerprints) {
      media.dtlsParams.fingerprints =
        dtlsTransport.localParameters.fingerprints;
    }
  }
}

export function allocateMid(mids: Set<string>) {
  let mid = "";
  for (let i = 0; ; ) {
    mid = (i++).toString();
    if (!mids.has(mid)) break;
  }
  mids.add(mid);
  return mid;
}

export function wrapSessionDescription(sessionDescription: SessionDescription) {
  return new RTCSessionDescription(
    sessionDescription.toString(),
    sessionDescription.type
  );
}

export type PeerConfig = {
  codecs: Partial<{
    audio: RTCRtpCodecParameters[];
    video: RTCRtpCodecParameters[];
  }>;
  headerExtensions: Partial<{
    audio: RTCRtpHeaderExtensionParameters[];
    video: RTCRtpHeaderExtensionParameters[];
  }>;
  iceConfig: Partial<IceOptions>;
};

export const defaultPeerConfig: PeerConfig = {
  codecs: {
    audio: [
      new RTCRtpCodecParameters({
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      }),
      new RTCRtpCodecParameters({
        mimeType: "audio/PCMU",
        clockRate: 8000,
        channels: 1,
      }),
    ],
    video: [
      new RTCRtpCodecParameters({
        mimeType: "video/VP8",
        clockRate: 90000,
        rtcpFeedback: [
          { type: "ccm", parameter: "fir" },
          { type: "nack" },
          { type: "nack", parameter: "pli" },
          { type: "goog-remb" },
        ],
      }),
    ],
  },
  headerExtensions: { audio: [], video: [] },
  iceConfig: { stunServer: ["stun.l.google.com", 19302] },
};
