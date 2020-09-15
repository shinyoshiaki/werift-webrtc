import { isEqual } from "lodash";
import Event from "rx.mini";
import * as uuid from "uuid";
import { enumerate } from "../helper";
import { Kind, SignalingState } from "../typings/domain";
import { IceOptions } from "../vendor/ice";
import { DISCARD_HOST, DISCARD_PORT, SRTP_PROFILE } from "./const";
import { RTCDataChannel, RTCDataChannelParameters } from "./dataChannel";
import { CODECS } from "./media/const";
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
  IceState,
  RTCIceCandidate,
  RTCIceCandidateJSON,
  RTCIceGatherer,
  RTCIceParameters,
  RTCIceTransport,
} from "./transport/ice";
import { RTCSctpTransport } from "./transport/sctp";

export type PeerConfig = {
  privateKey: string;
  certificate: string;
  codecs: Partial<{
    audio: RTCRtpCodecParameters[];
    video: RTCRtpCodecParameters[];
  }>;
  headerExtensions: Partial<{
    audio: RTCRtpHeaderExtensionParameters[];
    video: RTCRtpHeaderExtensionParameters[];
  }>;
} & IceOptions;

export class RTCPeerConnection {
  cname = uuid.v4();
  masterTransport: RTCDtlsTransport;
  sctpTransport?: RTCSctpTransport;
  masterTransportEstablished = false;
  onDataChannel = new Event<RTCDataChannel>();
  iceGatheringStateChange = new Event<IceState>();
  iceConnectionStateChange = new Event<IceState>();
  signalingStateChange = new Event<string>();
  onTransceiver = new Event<RTCRtpTransceiver>();
  onIceCandidate = new Event<RTCIceCandidate>();
  router = new RtpRouter();
  private certificates = [RTCCertificate.unsafe_useDefaultCertificate()];
  private sctpRemotePort?: number;
  private remoteDtls: RTCDtlsParameters;
  private remoteIce: RTCIceParameters;
  private seenMid = new Set<string>();
  private currentLocalDescription?: SessionDescription;
  private currentRemoteDescription?: SessionDescription;
  private pendingLocalDescription?: SessionDescription;
  private pendingRemoteDescription?: SessionDescription;
  private _iceConnectionState: IceState = "new";
  private _iceGatheringState: IceState = "new";
  private _signalingState: SignalingState = "stable";
  private isClosed = false;
  transceivers: RTCRtpTransceiver[] = [];

  constructor(private configuration: Partial<PeerConfig> = {}) {
    if (configuration.certificate && configuration.privateKey) {
      this.certificates = [
        new RTCCertificate(configuration.privateKey, configuration.certificate),
      ];
    }
    if (!configuration.codecs) {
      configuration.codecs = CODECS;
    }
    if (!configuration.headerExtensions) {
      configuration.headerExtensions = { audio: [], video: [] };
    }
  }

  get iceConnectionState() {
    return this._iceConnectionState;
  }

  get iceGatheringState() {
    return this._iceGatheringState;
  }

  get signalingState() {
    return this._signalingState;
  }

  get localDescription() {
    return wrapSessionDescription(this._localDescription());
  }

  get remoteDescription() {
    return wrapSessionDescription(this._remoteDescription());
  }

  _localDescription() {
    return this.pendingLocalDescription || this.currentLocalDescription;
  }

  private _remoteDescription() {
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

  createOffer() {
    if (!this.sctpTransport && this.transceivers.length === 0)
      throw new Error(
        "Cannot create an offer with no media and no data channels"
      );

    this.transceivers.forEach((transceiver) => {
      transceiver.codecs = this.configuration.codecs[transceiver.kind];
      transceiver.headerExtensions = this.configuration.headerExtensions[
        transceiver.kind
      ];
    });

    const description = new SessionDescription();
    addSDPHeader("offer", description);

    // # handle existing transceivers / sctp

    const media = this._localDescription()
      ? this._localDescription().media
      : [];

    media.forEach((m, i) => {
      const mid = m.rtp.muxId;
      if (m.kind === "application") {
        description.media.push(
          createMediaDescriptionForSctp(this.sctpTransport, mid)
        );
      } else {
        const transceiver = this.getTransceiverByMid(mid);
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
      !description.media.find((m) => this.sctpTransport.mid === m.rtp.muxId)
    ) {
      description.media.push(
        createMediaDescriptionForSctp(
          this.sctpTransport,
          allocateMid(this.seenMid)
        )
      );
    }

    const bundle = new GroupDescription(
      "BUNDLE",
      description.media.map((m) => m.rtp.muxId)
    );
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

  /**
   * need createOffer
   * @param sender
   */
  removeTrack(sender: RTCRtpSender) {
    const transceiver = this.transceivers.find(
      (t) => t.sender.ssrc === sender.ssrc
    );
    if (transceiver.direction === "sendrecv")
      transceiver.direction = "recvonly";
    else if (transceiver.direction === "sendonly")
      transceiver.direction = "inactive";
  }

  private updateIceGatheringState() {
    const state = this.masterTransport.iceTransport.state;

    if (state !== this._iceGatheringState) {
      this._iceGatheringState = state;
      this.iceGatheringStateChange.execute(state);
    }
  }

  private updateIceConnectionState() {
    const state = this.masterTransport.iceTransport.state;

    if (state !== this._iceConnectionState) {
      this._iceConnectionState = state;
      this.iceConnectionStateChange.execute(state);
    }
  }

  private createDtlsTransport(srtpProfiles: number[] = []) {
    if (this.masterTransport) return this.masterTransport;

    const iceGatherer = new RTCIceGatherer(this.configuration);
    iceGatherer.subject.subscribe((state) => {
      if (state === "stateChange") {
        this.updateIceGatheringState();
      }
    });
    const iceTransport = new RTCIceTransport(iceGatherer);
    iceTransport.iceState.subscribe((state) => {
      if (state === "stateChange") {
        this.updateIceConnectionState();
      }
    });
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
      this.certificates,
      srtpProfiles
    );
    dtls.router = this.router;
    this.masterTransport = dtls;

    this.updateIceGatheringState();
    this.updateIceConnectionState();

    return dtls;
  }

  private createSctpTransport() {
    const sctp = new RTCSctpTransport(this.createDtlsTransport());
    sctp.mid = undefined;

    sctp.onDataChannel.subscribe((dc) => {
      this.onDataChannel.execute(dc);
    });

    return sctp;
  }

  async setLocalDescription(sessionDescription: RTCSessionDescription) {
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
      this.seenMid.add(mid);
      if (["audio", "video"].includes(media.kind)) {
        const transceiver = this.getTransceiverByMLineIndex(i);
        transceiver.mid = mid;
      }
      if (media.kind === "application") {
        this.sctpTransport.mid = mid;
      }
    });

    // # set ICE role
    const iceTransport = this.masterTransport.iceTransport;
    if (description.type === "offer") {
      iceTransport.connection.iceControlling = true;
      iceTransport.roleSet = true;
    } else {
      iceTransport.connection.iceControlling = false;
      iceTransport.roleSet = true;
    }

    this.setLocal(description);

    // # gather candidates
    await this.gather();

    description.media.map((media) => {
      addTransportDescription(media, this.masterTransport);
    });

    this.setLocal(description);
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
    if (!this.masterTransport) throw new Error();

    const candidate = RTCIceCandidate.fromJSON(candidateMessage);

    const iceTransport = this.masterTransport.iceTransport;
    iceTransport.addRemoteCandidate(candidate);
  }

  private async gather() {
    if (this.masterTransportEstablished) return;
    await this.masterTransport.iceTransport.iceGather.gather();
  }

  private async connect() {
    if (this.masterTransportEstablished) return;

    const dtlsTransport = this.masterTransport;
    const iceTransport = dtlsTransport.iceTransport;

    if (
      iceTransport.iceGather.getLocalCandidates() &&
      this.remoteIce &&
      this.remoteDtls
    ) {
      await iceTransport.start(this.remoteIce);
      await dtlsTransport.start(this.remoteDtls);

      if (this.sctpTransport) {
        await this.sctpTransport.start(this.sctpRemotePort);
        await this.sctpTransport.sctp.stateChanged.connected.asPromise();
      }

      this.masterTransportEstablished = true;
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
    const media = this._remoteDescription().media[transceiver.mLineIndex];
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

  private setSignalingState(state: SignalingState) {
    this._signalingState = state;
    this.signalingStateChange.execute(state);
  }

  private validateDescription(
    description: SessionDescription,
    isLocal: boolean
  ) {
    if (isLocal) {
      if (description.type === "offer") {
        if (!["stable", "have-local-offer"].includes(this._signalingState))
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
      if (!media.iceParams.usernameFragment || !media.iceParams.password)
        throw new Error("ICE username fragment or password is missing");
    });

    if (["answer", "pranswer"].includes(description.type || "")) {
      const offer = isLocal
        ? this._remoteDescription()
        : this._localDescription();
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
    for (let [i, media] of enumerate(description.media)) {
      let dtlsTransport: RTCDtlsTransport | undefined;

      if (["audio", "video"].includes(media.kind)) {
        let transceiver = this.transceivers.find(
          (t) =>
            t.kind === media.kind &&
            [undefined, media.rtp.muxId].includes(t.mid)
        );
        if (!transceiver) {
          transceiver = this.addTransceiver(media.kind, "recvonly");

          if (["recvonly", "sendrecv"].includes(transceiver.direction)) {
            this.onTransceiver.execute(transceiver);
          }
        }

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
        transceiver.codecs = media.rtp.codecs.filter((remoteCodec) =>
          this.configuration.codecs[media.kind as "audio" | "video"].find(
            (localCodec) => localCodec.mimeType === remoteCodec.mimeType
          )
        );
        transceiver.headerExtensions = media.rtp.headerExtensions.filter(
          (extension) =>
            this.configuration.headerExtensions[
              media.kind as "video" | "audio"
            ].find((v) => v.uri === extension.uri)
        );

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
          iceTransport.addRemoteCandidate(undefined);
        }

        if (description.type === "offer" && !iceTransport.roleSet) {
          iceTransport.connection.iceControlling = media.iceParams.iceLite;
          iceTransport.roleSet = true;
        }

        if (description.type === "answer") {
          dtlsTransport.role =
            media.dtlsParams.role === "client" ? "server" : "client";
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
        transceiver.senderParams = this.localRtp(transceiver);
      }
      if (["recvonly", "sendrecv"].includes(transceiver.direction)) {
        const params = this.remoteRtp(transceiver);
        this.router.registerRtpReceiverBySsrc(transceiver, params);
      }
    });
  }

  addTransceiver(
    kind: Kind,
    direction: Direction,
    options: Partial<TransceiverOptions> = {}
  ) {
    const dtlsTransport = this.createDtlsTransport([
      SRTP_PROFILE.SRTP_AES128_CM_HMAC_SHA1_80,
    ]);

    const transceiver = new RTCRtpTransceiver(
      kind,
      new RTCRtpReceiver(kind, dtlsTransport),
      new RTCRtpSender(kind, dtlsTransport),
      direction
    );
    transceiver.receiver.rtcpSsrc = transceiver.sender.ssrc;
    transceiver.dtlsTransport = dtlsTransport;
    transceiver.options = options;
    this.router.ssrcTable[transceiver.sender.ssrc] = transceiver.sender;

    this.transceivers.push(transceiver);

    return transceiver;
  }

  createAnswer() {
    this.assertNotClosed();
    if (
      !["have-remote-offer", "have-local-pranswer"].includes(
        this.signalingState
      )
    )
      throw new Error();

    const description = new SessionDescription();
    addSDPHeader("answer", description);

    this._remoteDescription()?.media.forEach((remoteM) => {
      let dtlsTransport: RTCDtlsTransport;
      let media: MediaDescription;

      if (["audio", "video"].includes(remoteM.kind)) {
        const transceiver = this.getTransceiverByMid(remoteM.rtp.muxId);
        media = createMediaDescriptionForTransceiver(
          transceiver,
          this.cname,
          transceiver.direction,
          transceiver.mid
        );
        dtlsTransport = transceiver.dtlsTransport;
      } else if (remoteM.kind === "application") {
        if (!this.sctpTransport || !this.sctpTransport.mid) throw new Error();
        media = createMediaDescriptionForSctp(
          this.sctpTransport,
          this.sctpTransport.mid
        );

        dtlsTransport = this.sctpTransport.dtlsTransport;
      }

      // # determine DTLS role, or preserve the currently configured role
      if (dtlsTransport.role === "auto") {
        media.dtlsParams.role = "client";
      } else {
        media.dtlsParams.role = dtlsTransport.role;
      }
      media.simulcastParameters = remoteM.simulcastParameters;
      description.media.push(media!);
    });

    const bundle = new GroupDescription("BUNDLE", []);
    description.media.forEach((media) => {
      bundle.items.push(media.rtp.muxId);
    });
    description.group.push(bundle);

    return wrapSessionDescription(description);
  }

  async close() {
    if (this.isClosed) return;

    this.isClosed = true;
    this.setSignalingState("closed");

    if (this.sctpTransport) {
      this.sctpTransport.stop();
      this.sctpTransport.dtlsTransport.stop();
      await this.sctpTransport.dtlsTransport.iceTransport.stop();
    }

    this.updateIceConnectionState();
    this.removeAllListeners();
  }

  private assertNotClosed() {
    if (this.isClosed) throw new Error("RTCPeerConnection is closed");
  }

  private removeAllListeners() {
    this.onDataChannel.allUnsubscribe();
    this.iceGatheringStateChange.allUnsubscribe();
    this.iceConnectionStateChange.allUnsubscribe();
    this.signalingStateChange.allUnsubscribe();
  }
}

function createMediaDescriptionForTransceiver(
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
  media.msid = `${transceiver.sender.streamId} ${transceiver.sender.trackId}`;
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

  addTransportDescription(media, transceiver.dtlsTransport);
  return media;
}

function createMediaDescriptionForSctp(sctp: RTCSctpTransport, mid: string) {
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

function addTransportDescription(
  media: MediaDescription,
  dtlsTransport: RTCDtlsTransport
) {
  const iceTransport = dtlsTransport.iceTransport;
  const iceGatherer = iceTransport.iceGather;

  media.iceCandidates = iceGatherer.getLocalCandidates();
  media.iceCandidatesComplete = iceGatherer.state === "completed";
  media.iceParams = iceGatherer.getLocalParameters();

  if (media.iceCandidates.length > 0) {
    const candidate = media.iceCandidates[media.iceCandidates.length - 1];
    media.host = candidate.ip;
    media.port = candidate.port;
  } else {
    media.host = DISCARD_HOST;
    media.port = DISCARD_PORT;
  }

  if (!media.dtlsParams) {
    media.dtlsParams = dtlsTransport.getLocalParameters();
    if (!media.dtlsParams.fingerprints) {
      media.dtlsParams.fingerprints = dtlsTransport.getLocalParameters().fingerprints;
    }
  }
}

function allocateMid(mids: Set<string>) {
  let i = 0;
  let mid = "";
  while (true) {
    mid = (i++).toString();
    if (!mids.has(mid)) break;
  }
  mids.add(mid);
  return mid;
}

function wrapSessionDescription(sessionDescription?: SessionDescription) {
  if (sessionDescription) {
    return new RTCSessionDescription(
      sessionDescription.toString(),
      sessionDescription.type!
    );
  }
}
