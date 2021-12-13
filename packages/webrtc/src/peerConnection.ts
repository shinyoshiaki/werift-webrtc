import debug from "debug";
import { cloneDeep, isEqual } from "lodash";
import Event from "rx.mini";
import * as uuid from "uuid";

import { Profile } from "../../dtls/src/context/srtp";
import { codecParametersFromString, DtlsKeys } from ".";
import {
  DISCARD_HOST,
  DISCARD_PORT,
  SenderDirections,
  SRTP_PROFILE,
} from "./const";
import { RTCDataChannel, RTCDataChannelParameters } from "./dataChannel";
import { enumerate, EventTarget } from "./helper";
import {
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpParameters,
  RTCRtpReceiveParameters,
  RTCRtpRtxParameters,
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
import { MediaStream, MediaStreamTrack } from "./media/track";
import {
  addSDPHeader,
  GroupDescription,
  MediaDescription,
  SessionDescription,
  SsrcDescription,
} from "./sdp";
import { RTCCertificate, RTCDtlsTransport } from "./transport/dtls";
import {
  IceCandidate,
  IceGathererState,
  RTCIceCandidate,
  RTCIceConnectionState,
  RTCIceGatherer,
  RTCIceTransport,
} from "./transport/ice";
import { RTCSctpTransport } from "./transport/sctp";
import { ConnectionState, Kind, RTCSignalingState } from "./types/domain";
import { Callback, CallbackWithValue } from "./types/util";
import {
  andDirection,
  parseIceServers,
  reverseDirection,
  reverseSimulcastDirection,
} from "./utils";

const log = debug("werift:packages/webrtc/src/peerConnection.ts");

export class RTCPeerConnection extends EventTarget {
  readonly cname = uuid.v4();
  iceTransport: RTCIceTransport;
  dtlsTransport: RTCDtlsTransport;
  sctpTransport?: RTCSctpTransport;
  masterTransportEstablished = false;
  configuration: Required<PeerConfig> =
    cloneDeep<PeerConfig>(defaultPeerConfig);
  connectionState: ConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: IceGathererState = "new";
  signalingState: RTCSignalingState = "stable";
  negotiationneeded = false;
  readonly transceivers: RTCRtpTransceiver[] = [];
  readonly iceGatheringStateChange = new Event<[IceGathererState]>();
  readonly iceConnectionStateChange = new Event<[RTCIceConnectionState]>();
  readonly signalingStateChange = new Event<[RTCSignalingState]>();
  readonly connectionStateChange = new Event<[ConnectionState]>();
  readonly onDataChannel = new Event<[RTCDataChannel]>();
  readonly onRemoteTransceiverAdded = new Event<[RTCRtpTransceiver]>();
  /**
   * should use onRemoteTransceiverAdded
   * @deprecated
   */
  readonly onTransceiver = new Event<[RTCRtpTransceiver]>();
  readonly onTransceiverAdded = new Event<[RTCRtpTransceiver]>();
  readonly onIceCandidate = new Event<[RTCIceCandidate]>();
  readonly onNegotiationneeded = new Event<[]>();

  ondatachannel?: CallbackWithValue<RTCDataChannelEvent>;
  onicecandidate?: CallbackWithValue<RTCPeerConnectionIceEvent>;
  onnegotiationneeded?: CallbackWithValue<any>;
  onsignalingstatechange?: CallbackWithValue<any>;
  ontrack?: CallbackWithValue<RTCTrackEvent>;
  onconnectionstatechange?: Callback;

  private readonly router = new RtpRouter();
  private readonly certificates: RTCCertificate[] = [];
  sctpRemotePort?: number;
  private seenMid = new Set<string>();
  private currentLocalDescription?: SessionDescription;
  private currentRemoteDescription?: SessionDescription;
  private pendingLocalDescription?: SessionDescription;
  private pendingRemoteDescription?: SessionDescription;
  private isClosed = false;
  private shouldNegotiationneeded = false;

  constructor({
    codecs,
    headerExtensions,
    iceServers,
    iceTransportPolicy,
    icePortRange,
    dtls,
  }: Partial<PeerConfig> = {}) {
    super();

    if (iceServers) this.configuration.iceServers = iceServers;
    if (iceTransportPolicy)
      this.configuration.iceTransportPolicy = iceTransportPolicy;
    if (icePortRange) {
      const [min, max] = icePortRange;
      if (min === max) throw new Error("should not be same value");
      if (min >= max) throw new Error("The min must be less than max");
      this.configuration.icePortRange = icePortRange;
    }
    if (codecs?.audio) this.configuration.codecs.audio = codecs.audio;
    if (codecs?.video) this.configuration.codecs.video = codecs.video;

    for (const [i, codecParams] of enumerate([
      ...(this.configuration.codecs.audio || []),
      ...(this.configuration.codecs.video || []),
    ])) {
      codecParams.payloadType = 96 + i;
      switch (codecParams.name.toLowerCase()) {
        case "rtx":
          {
            codecParams.parameters = `apt=${codecParams.payloadType - 1}`;
          }
          break;
        case "red":
          {
            const redundant = codecParams.payloadType + 1;
            codecParams.parameters = `${redundant}/${redundant}`;
            codecParams.payloadType = 63;
          }
          break;
      }
    }

    if (headerExtensions?.audio)
      this.configuration.headerExtensions.audio = headerExtensions.audio;
    if (headerExtensions?.video)
      this.configuration.headerExtensions.video = headerExtensions.video;
    [
      ...(this.configuration.headerExtensions.audio || []),
      ...(this.configuration.headerExtensions.video || []),
    ].forEach((v, i) => {
      v.id = 1 + i;
    });

    if (dtls) {
      const { keys } = dtls;
      if (keys) {
        this.certificates.push(
          new RTCCertificate(keys.keyPem, keys.certPem, keys.signatureHash)
        );
      }
    }

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

    const { iceTransport, dtlsTransport } = this.createTransport([
      SRTP_PROFILE.SRTP_AEAD_AES_128_GCM, // prefer
      SRTP_PROFILE.SRTP_AES128_CM_HMAC_SHA1_80,
    ]);
    this.iceTransport = iceTransport;
    this.dtlsTransport = dtlsTransport;
  }

  get localDescription() {
    if (!this._localDescription) return;
    return this._localDescription.toJSON();
  }

  get remoteDescription() {
    if (!this._remoteDescription) return;
    return this._remoteDescription.toJSON();
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
    if (this.certificates.length === 0) {
      await this.dtlsTransport.setupCertificate();
    }

    this.transceivers.forEach((transceiver) => {
      transceiver.codecs = this.configuration.codecs[transceiver.kind];
      transceiver.headerExtensions =
        this.configuration.headerExtensions[transceiver.kind];
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

    return description.toJSON();
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
  ): RTCDataChannel {
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

    if (transceiver.currentDirection === "recvonly") {
      this.needNegotiation();
      return;
    }

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

  private needNegotiation = async () => {
    this.shouldNegotiationneeded = true;
    if (this.negotiationneeded || this.signalingState !== "stable") return;
    this.shouldNegotiationneeded = false;
    setImmediate(() => {
      this.negotiationneeded = true;
      this.onNegotiationneeded.execute();
      if (this.onnegotiationneeded) this.onnegotiationneeded({});
    });
  };

  private createTransport(srtpProfiles: Profile[] = []) {
    const iceGatherer = new RTCIceGatherer({
      ...parseIceServers(this.configuration.iceServers),
      forceTurn: this.configuration.iceTransportPolicy === "relay",
      portRange: this.configuration.icePortRange,
    });
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
      if (!media) {
        log("media not exist");
        return;
      }
      candidate.sdpMLineIndex = 0;
      candidate.sdpMid = media.rtp.muxId;
      // for chrome & firefox & maybe others
      candidate.foundation = "candidate:" + candidate.foundation;

      this.onIceCandidate.execute(candidate.toJSON());
      if (this.onicecandidate)
        this.onicecandidate({ candidate: candidate.toJSON() });
      this.emit("icecandidate", { candidate });
    };

    const dtlsTransport = new RTCDtlsTransport(
      iceTransport,
      this.router,
      this.certificates,
      srtpProfiles
    );

    return { dtlsTransport, iceTransport };
  }

  private createSctpTransport() {
    const sctp = new RTCSctpTransport(this.dtlsTransport);
    sctp.mid = undefined;

    sctp.onDataChannel.subscribe((channel) => {
      this.onDataChannel.execute(channel);

      const event: RTCDataChannelEvent = { channel };
      if (this.ondatachannel) this.ondatachannel(event);
      this.emit("datachannel", event);
    });

    return sctp;
  }

  async setLocalDescription(sessionDescription: {
    type: "offer" | "answer";
    sdp: string;
  }): Promise<SessionDescription> {
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
        throw new Error("mid not exist");
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
    if (description.type === "offer") {
      this.iceTransport.connection.iceControlling = true;
    } else {
      this.iceTransport.connection.iceControlling = false;
    }
    // One agent full, one lite:  The full agent MUST take the controlling role, and the lite agent MUST take the controlled role
    // RFC 8445 S6.1.1
    if (this.iceTransport.connection.remoteIsLite) {
      this.iceTransport.connection.iceControlling = true;
    }

    // # set DTLS role for mediasoup
    if (description.type === "answer") {
      const role = description.media.find((media) => media.dtlsParams)
        ?.dtlsParams?.role;
      if (role) {
        this.dtlsTransport.role = role;
      }
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
    await this.iceTransport.iceGather.gather();
    description.media.map((media) => {
      addTransportDescription(media, this.dtlsTransport);
    });

    this.setLocal(description);

    // connect transports
    if (description.type === "answer") {
      this.connect().catch((err) => {
        log("connect failed", err);
        this.setConnectionState("failed");
      });
    }

    if (this.shouldNegotiationneeded) {
      this.needNegotiation();
    }

    return description;
  }

  private setLocal(description: SessionDescription) {
    if (description.type === "answer") {
      this.currentLocalDescription = description;
      this.pendingLocalDescription = undefined;
    } else {
      this.pendingLocalDescription = description;
    }
  }

  async addIceCandidate(candidateMessage: RTCIceCandidate) {
    const candidate = IceCandidate.fromJSON(candidateMessage);
    await this.iceTransport.addRemoteCandidate(candidate);
  }

  private async connect() {
    if (this.masterTransportEstablished) return;

    const dtlsTransport = this.dtlsTransport;
    const iceTransport = dtlsTransport.iceTransport;

    this.setConnectionState("connecting");

    await iceTransport.start().catch((err) => {
      log("iceTransport.start failed", err);
      throw err;
    });
    log("ice connected");
    await dtlsTransport.start().catch((err) => {
      log("dtlsTransport.start failed", err);
      throw err;
    });
    log("dtls connected");

    if (this.sctpTransport && this.sctpRemotePort) {
      await this.sctpTransport.start(this.sctpRemotePort);
      await this.sctpTransport.sctp.stateChanged.connected.asPromise();
    }

    this.masterTransportEstablished = true;
    this.setConnectionState("connected");
  }

  private localRtp(transceiver: RTCRtpTransceiver): RTCRtpParameters {
    if (transceiver.mid == undefined) throw new Error("mid not assigned");

    const rtp: RTCRtpParameters = {
      codecs: transceiver.codecs,
      muxId: transceiver.mid,
      headerExtensions: transceiver.headerExtensions,
      rtcp: { cname: this.cname, ssrc: transceiver.sender.ssrc, mux: true },
    };
    return rtp;
  }

  private remoteRtp(
    remoteDescription: SessionDescription,
    transceiver: RTCRtpTransceiver
  ): RTCRtpReceiveParameters {
    if (transceiver.mLineIndex == undefined)
      throw new Error("mLineIndex not assigned");
    const media = remoteDescription.media[transceiver.mLineIndex];
    if (!media) throw new Error("media line not exist");

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
          {}
        )
      ),
    };

    return receiveParameters;
  }

  async setRemoteDescription(sessionDescription: {
    type: "offer" | "answer";
    sdp: string;
  }) {
    // # parse and validate description
    const remoteSdp = SessionDescription.parse(sessionDescription.sdp);
    remoteSdp.type = sessionDescription.type;
    this.validateDescription(remoteSdp, false);

    // # apply description
    for (const [i, remoteMedia] of enumerate(remoteSdp.media)) {
      if (["audio", "video"].includes(remoteMedia.kind)) {
        const transceiver =
          this.transceivers.find(
            (t) =>
              t.kind === remoteMedia.kind &&
              [undefined, remoteMedia.rtp.muxId].includes(t.mid)
          ) ||
          (() => {
            // create remote transceiver
            const transceiver = this.addTransceiver(remoteMedia.kind, {
              direction: "recvonly",
            });

            this.onRemoteTransceiverAdded.execute(transceiver);
            this.onTransceiver.execute(transceiver);

            return transceiver;
          })();

        if (!transceiver.mid) {
          transceiver.mid = remoteMedia.rtp.muxId;
          transceiver.mLineIndex = i;
        }

        // # negotiate codecs
        transceiver.codecs = remoteMedia.rtp.codecs.filter((remoteCodec) => {
          const localCodecs = this.configuration.codecs[remoteMedia.kind] || [];

          const existCodec = findCodecByMimeType(localCodecs, remoteCodec);
          if (!existCodec) return false;

          if (existCodec?.name.toLowerCase() === "rtx") {
            const params = codecParametersFromString(
              existCodec.parameters ?? ""
            );
            const pt = params["apt"];
            const origin = remoteMedia.rtp.codecs.find(
              (c) => c.payloadType === pt
            );
            if (!origin) return false;
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
            (
              this.configuration.headerExtensions[
                remoteMedia.kind as "video" | "audio"
              ] || []
            ).find((v) => v.uri === extension.uri)
        );

        // # configure direction
        const mediaDirection = remoteMedia.direction || "inactive";
        const direction = reverseDirection(mediaDirection);
        if (["answer", "pranswer"].includes(remoteSdp.type)) {
          transceiver.currentDirection = direction;
        } else {
          transceiver.offerDirection = direction;
        }

        const localParams = this.localRtp(transceiver);
        transceiver.sender.prepareSend(localParams);

        if (["recvonly", "sendrecv"].includes(transceiver.direction)) {
          const remotePrams = this.remoteRtp(remoteSdp, transceiver);

          // register simulcast receiver
          remoteMedia.simulcastParameters.forEach((param) => {
            this.router.registerRtpReceiverByRid(
              transceiver,
              param,
              remotePrams
            );
          });

          transceiver.receiver.prepareReceive(remotePrams);
          // register ssrc receiver
          this.router.registerRtpReceiverBySsrc(transceiver, remotePrams);
        }
        if (["sendonly", "sendrecv"].includes(mediaDirection)) {
          // assign msid
          if (remoteMedia.msid != undefined) {
            const [streamId, trackId] = remoteMedia.msid.split(" ");
            transceiver.receiver.remoteStreamId = streamId;
            transceiver.receiver.remoteTrackId = trackId;

            this.fireOnTrack(
              transceiver.receiver.track,
              transceiver,
              new MediaStream({
                id: streamId,
                tracks: [transceiver.receiver.track],
              })
            );
          }
        }

        transceiver.receiver.setupTWCC(remoteMedia.ssrc[0]?.ssrc);
      } else if (remoteMedia.kind === "application") {
        if (!this.sctpTransport) {
          this.sctpTransport = this.createSctpTransport();
        }

        if (!this.sctpTransport.mid) {
          this.sctpTransport.mid = remoteMedia.rtp.muxId;
        }

        // # configure sctp
        this.sctpRemotePort = remoteMedia.sctpPort;
      }

      if (remoteMedia.iceParams && remoteMedia.dtlsParams) {
        this.iceTransport.setRemoteParams(remoteMedia.iceParams);
        this.dtlsTransport.setRemoteParams(remoteMedia.dtlsParams);

        // One agent full, one lite:  The full agent MUST take the controlling role, and the lite agent MUST take the controlled role
        // RFC 8445 S6.1.1
        if (remoteMedia.iceParams?.iceLite) {
          this.iceTransport.connection.iceControlling = true;
        }
      }

      // # add ICE candidates
      remoteMedia.iceCandidates.forEach(this.iceTransport.addRemoteCandidate);

      await this.iceTransport.iceGather.gather();

      if (remoteMedia.iceCandidatesComplete) {
        await this.iceTransport.addRemoteCandidate(undefined);
      }

      // # set DTLS role
      if (remoteSdp.type === "answer" && remoteMedia.dtlsParams?.role) {
        this.dtlsTransport.role =
          remoteMedia.dtlsParams.role === "client" ? "server" : "client";
      }
    }

    // connect transports
    if (remoteSdp.type === "answer") {
      this.connect().catch((err) => {
        log("connect failed", err);
        this.setConnectionState("failed");
      });
    }

    if (remoteSdp.type === "offer") {
      this.setSignalingState("have-remote-offer");
    } else if (remoteSdp.type === "answer") {
      this.setSignalingState("stable");
    }

    if (remoteSdp.type === "answer") {
      this.currentRemoteDescription = remoteSdp;
      this.pendingRemoteDescription = undefined;
    } else {
      this.pendingRemoteDescription = remoteSdp;
    }

    this.negotiationneeded = false;
    if (this.shouldNegotiationneeded) {
      this.needNegotiation();
    }
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

  private fireOnTrack(
    track: MediaStreamTrack,
    transceiver: RTCRtpTransceiver,
    stream: MediaStream
  ) {
    const event: RTCTrackEvent = {
      track,
      streams: [stream],
      transceiver,
      receiver: transceiver.receiver,
    };
    this.emit("track", event);
    if (this.ontrack) this.ontrack(event);
  }

  addTransceiver(
    trackOrKind: Kind | MediaStreamTrack,
    options: Partial<TransceiverOptions> = {}
  ) {
    const kind =
      typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;

    const direction = options.direction || "sendrecv";

    const sender = new RTCRtpSender(trackOrKind, this.dtlsTransport);
    const receiver = new RTCRtpReceiver(kind, this.dtlsTransport, sender.ssrc);
    const transceiver = new RTCRtpTransceiver(
      kind,
      receiver,
      sender,
      direction,
      this.dtlsTransport
    );
    transceiver.options = options;
    this.router.registerRtpSender(transceiver.sender);

    this.transceivers.push(transceiver);
    this.onTransceiverAdded.execute(transceiver);

    this.needNegotiation();

    return transceiver;
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
    ms?: MediaStream
  ) {
    if (this.isClosed) throw new Error("is closed");
    if (this.getSenders().find((sender) => sender.track?.uuid === track.uuid)) {
      throw new Error("track exist");
    }

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

    return description.toJSON();
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
    await this.dtlsTransport.stop();
    await this.iceTransport.stop();

    this.dispose();
    log("peerConnection closed");
  }

  private assertNotClosed() {
    if (this.isClosed) throw new Error("RTCPeerConnection is closed");
  }

  private updateIceGatheringState(state: IceGathererState) {
    log("iceGatheringStateChange", state);
    this.iceGatheringState = state;
    this.iceGatheringStateChange.execute(state);
    this.emit("icegatheringstatechange", state);
  }

  private updateIceConnectionState(state: RTCIceConnectionState) {
    log("iceConnectionStateChange", state);
    this.iceConnectionState = state;
    this.iceConnectionStateChange.execute(state);
    this.emit("iceconnectionstatechange", state);
  }

  private setSignalingState(state: RTCSignalingState) {
    log("signalingStateChange", state);
    this.signalingState = state;
    this.signalingStateChange.execute(state);
    if (this.onsignalingstatechange) this.onsignalingstatechange({});
  }

  private setConnectionState(state: ConnectionState) {
    log("connectionStateChange", state);
    this.connectionState = state;
    this.connectionStateChange.execute(state);
    if (this.onconnectionstatechange) this.onconnectionstatechange();
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
  media.rtp = {
    codecs: transceiver.codecs,
    headerExtensions: transceiver.headerExtensions,
    muxId: mid,
  };
  media.rtcpHost = "0.0.0.0";
  media.rtcpPort = 9;
  media.rtcpMux = true;
  media.ssrc = [new SsrcDescription({ ssrc: transceiver.sender.ssrc, cname })];

  if (transceiver.options.simulcast) {
    media.simulcastParameters = transceiver.options.simulcast.map(
      (o) => new RTCRtpSimulcastParameters(o)
    );
  }

  if (media.rtp.codecs.find((c) => c.name.toLowerCase() === "rtx")) {
    media.ssrc.push(
      new SsrcDescription({ ssrc: transceiver.sender.rtxSsrc, cname })
    );
    media.ssrcGroup = [
      new GroupDescription("FID", [
        transceiver.sender.ssrc.toString(),
        transceiver.sender.rtxSsrc.toString(),
      ]),
    ];
  }

  addTransportDescription(media, transceiver.dtlsTransport);
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
  media.iceOptions = "trickle";

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

export interface PeerConfig {
  codecs: Partial<{
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
  dtls: Partial<{
    keys: DtlsKeys;
  }>;
}

export const findCodecByMimeType = (
  codecs: RTCRtpCodecParameters[],
  target: RTCRtpCodecParameters
) =>
  codecs.find(
    (localCodec) =>
      localCodec.mimeType.toLowerCase() === target.mimeType.toLowerCase()
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
  iceTransportPolicy: "all",
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  icePortRange: undefined,
  dtls: {},
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
  candidate: RTCIceCandidate;
}
