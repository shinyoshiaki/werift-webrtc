import { SRTP_PROFILE, SenderDirections } from "./const";
import { RTCDataChannel, RTCDataChannelParameters } from "./dataChannel";
import { enumerate } from "./helper";
import { Event, debug } from "./imports/common";
import type { SrtpProfile } from "./imports/rtp";
import {
  MediaStream,
  type MediaStreamTrack,
  type RTCRtpCodecParameters,
  RTCRtpReceiver,
  RTCRtpSender,
  RTCRtpTransceiver,
  type TransceiverOptions,
} from "./media";
import { RTCPeerConnectionContext } from "./pc/peerConnectionContext";
import {
  type PeerConfig,
  addTransportDescription,
  allocateMid,
  assertDescription,
  assertSignalingState,
  assignTransceiverCodecs,
  createMediaDescriptionForSctp,
  createMediaDescriptionForTransceiver,
  findCodecByMimeType,
  getLocalRtpParams,
  getRemoteRtpParams,
  setConfiguration,
} from "./pc/util";
import {
  GroupDescription,
  type MediaDescription,
  SessionDescription,
  addSDPHeader,
  codecParametersFromString,
} from "./sdp";
import { RTCCertificate, RTCDtlsTransport } from "./transport/dtls";
import {
  IceCandidate,
  type RTCIceCandidate,
  type RTCIceCandidateInit,
  RTCIceGatherer,
  RTCIceTransport,
} from "./transport/ice";
import { RTCSctpTransport } from "./transport/sctp";
import type { Kind } from "./types/domain";
import type { Callback, CallbackWithValue } from "./types/util";
import {
  andDirection,
  parseIceServers,
  reverseDirection,
  reverseSimulcastDirection,
} from "./utils";

const log = debug("werift:packages/webrtc/src/peerConnection.ts");

export class RTCPeerConnection extends RTCPeerConnectionContext {
  readonly onDataChannel = new Event<[RTCDataChannel]>();
  readonly onRemoteTransceiverAdded = new Event<[RTCRtpTransceiver]>();
  readonly onTransceiverAdded = new Event<[RTCRtpTransceiver]>();
  readonly onIceCandidate = new Event<[RTCIceCandidate | undefined]>();
  readonly onNegotiationneeded = new Event<[]>();
  readonly onTrack = new Event<[MediaStreamTrack]>();

  ondatachannel?: CallbackWithValue<RTCDataChannelEvent>;
  onicecandidate?: CallbackWithValue<RTCPeerConnectionIceEvent>;
  onnegotiationneeded?: CallbackWithValue<any>;
  ontrack?: CallbackWithValue<RTCTrackEvent>;

  set onsignalingstatechange(callback: CallbackWithValue<any>) {
    this.stateManager.onsignalingstatechange = callback;
  }
  set onconnectionstatechange(callback: Callback) {
    this.stateManager.onconnectionstatechange = callback;
  }
  set oniceconnectionstatechange(callback: Callback) {
    this.stateManager.oniceconnectionstatechange = callback;
  }

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

  // Override onNegotiationNeeded method from parent class
  protected onNegotiationNeeded() {
    this.onNegotiationneeded.execute();
    if (this.onnegotiationneeded) this.onnegotiationneeded({});
  }

  setConfiguration(config: Partial<PeerConfig>) {
    this.config = setConfiguration(this.config, config);

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

    // 親クラスのメソッドを利用
    const description = super.buildOfferSdp();
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
    if (
      !this.transceivers
        .map((t) => t.sender)
        .find(({ ssrc }) => sender.ssrc === ssrc)
    ) {
      throw new Error("unExist");
    }

    const transceiver = this.transceivers.find(
      ({ sender: { ssrc } }) => sender.ssrc === ssrc,
    );
    if (!transceiver) {
      throw new Error("unExist");
    }

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
      if (!this._localDescription) {
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

  async setLocalDescription(sessionDescription: {
    type: "offer" | "answer";
    sdp: string;
  }): Promise<SessionDescription> {
    // # parse and validate description
    const description = SessionDescription.parse(sessionDescription.sdp);
    description.type = sessionDescription.type;
    this.assertDescription(description, true);

    // # update signaling state
    if (description.type === "offer") {
      this.setSignalingState("have-local-offer");
    } else if (description.type === "answer") {
      this.setSignalingState("stable");
    }

    // # assign MID
    for (const [i, media] of enumerate(description.media)) {
      const mid = media.rtp.muxId!;
      this.captureMids(description);
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
      (transport) => transport.state === "connected",
    );
    if (this.remoteIsBundled && connected) {
      // no need to gather ice candidates on an existing bundled connection
    } else {
      await Promise.allSettled(
        this.iceTransports.map((iceTransport) => iceTransport.gather()),
      );
    }
  }

  protected setLocal(description: SessionDescription) {
    // 親クラスのsetLocalメソッドを呼び出し
    super.setLocal(description);
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
      iceTransport = this.getTransportByMLineIndex(
        this.buildOfferSdp(),
        candidate.sdpMLineIndex,
      );
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

        this.setConnectionState("connecting");

        await iceTransport.start().catch((err) => {
          log("iceTransport.start failed", err);
          throw err;
        });

        if (dtlsTransport.state === "connected") {
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
    this.assertDescription(remoteSdp, false);

    // SDP Managerにリモート記述を設定
    this.processRemoteDescription(remoteSdp);

    let bundleTransport: RTCDtlsTransport | undefined;

    // # apply description

    const matchTransceiverWithMedia = (
      transceiver: RTCRtpTransceiver,
      media: MediaDescription,
    ) =>
      transceiver.kind === media.kind &&
      [undefined, media.rtp.muxId].includes(transceiver.mid);

    const dtlsTransports = remoteSdp.media
      .map((remoteMedia, i) => {
        if (["audio", "video"].includes(remoteMedia.kind)) {
          let transceiver = this.transceivers.find((t) =>
            matchTransceiverWithMedia(t, remoteMedia),
          );
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

          if (this.remoteIsBundled) {
            if (!bundleTransport) {
              bundleTransport = transceiver.dtlsTransport;
            } else {
              transceiver.setDtlsTransport(bundleTransport);
            }
          }

          this.setRemoteRTP(transceiver, remoteMedia, remoteSdp.type, i);

          return { dtlsTransport: transceiver.dtlsTransport, remoteMedia };
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

          this.setRemoteSCTP(remoteMedia, this.sctpTransport, i);

          return {
            dtlsTransport: this.sctpTransport.dtlsTransport,
            remoteMedia,
          };
        } else {
          throw new Error("invalid media kind");
        }
      })
      .filter((t): t is NonNullable<typeof t> => t != undefined);

    // setup dtls
    for (const { dtlsTransport, remoteMedia } of dtlsTransports) {
      if (remoteMedia.dtlsParams) {
        dtlsTransport.setRemoteParams(remoteMedia.dtlsParams);
      }

      if (remoteSdp.type === "answer" && remoteMedia.dtlsParams?.role) {
        dtlsTransport.role =
          remoteMedia.dtlsParams.role === "client" ? "server" : "client";
      }
    }

    const renomination = !!remoteSdp.media.find(
      (m) => m.direction === "inactive",
    );

    // setup ice
    for (const {
      dtlsTransport: { iceTransport },
      remoteMedia,
    } of dtlsTransports) {
      if (remoteMedia.iceParams) {
        iceTransport.setRemoteParams(remoteMedia.iceParams, renomination);

        // One agent full, one lite:  The full agent MUST take the controlling role, and the lite agent MUST take the controlled role
        // RFC 8445 S6.1.1
        if (remoteMedia.iceParams?.iceLite) {
          iceTransport.connection.iceControlling = true;
        }
      }

      Promise.allSettled(
        remoteMedia.iceCandidates.map((c) =>
          iceTransport.addRemoteCandidate(c),
        ),
      ).then((r) => {
        if (r.some((r) => r.status === "rejected")) {
          log("addRemoteCandidate failed", r);
        } else {
          if (remoteMedia.iceCandidatesComplete) {
            iceTransport.addRemoteCandidate(undefined);
          }
        }
      });
    }

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
    const localParams = getLocalRtpParams(transceiver, this.cname);
    transceiver.sender.prepareSend(localParams);

    if (["recvonly", "sendrecv"].includes(transceiver.direction)) {
      const remotePrams = getRemoteRtpParams(remoteMedia, transceiver);

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

  private assertDescription(description: SessionDescription, isLocal: boolean) {
    // 親クラスの実装を呼び出し
    this.assertSdpDescription(description, isLocal);
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

  addTrack(
    track: MediaStreamTrack,
    /**todo impl */
    ms?: MediaStream,
  ) {
    if (this.isClosed) {
      throw new Error("is closed");
    }
    if (
      this.transceivers
        .map((t) => t.sender)
        .find((sender) => sender.track?.uuid === track.uuid)
    ) {
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
      const transceiver = this.addTransceiver(track, {
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

    // 親クラスのメソッドを利用
    const description = super.buildAnswer();
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
    for (const dtlsTransport of this.dtlsTransports) {
      await dtlsTransport.stop();
      await dtlsTransport.iceTransport.stop();
    }

    this.dispose();
    log("peerConnection closed");
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
