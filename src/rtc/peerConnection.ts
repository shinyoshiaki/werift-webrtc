import { isEqual } from "lodash";
import Event from "rx.mini";
import * as uuid from "uuid";
import { enumerate } from "../helper";
import { Kind } from "../typings/domain";
import { DISCARD_HOST, DISCARD_PORT, SRTP_PROFILE } from "./const";
import { RTCDataChannel, RTCDataChannelParameters } from "./dataChannel";
import { CODECS } from "./media/const";
import {
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  RTCRtpParameters,
  RTCRtpReceiveParameters,
} from "./media/parameters";
import { RtpRouter } from "./media/router";
import { RTCRtpReceiver } from "./media/rtpReceiver";
import { RTCRtpSender } from "./media/rtpSender";
import { Direction, RTCRtpTransceiver } from "./media/rtpTransceiver";
import {
  addSDPHeader,
  GroupDescription,
  MediaDescription,
  RTCSessionDescription,
  SessionDescription,
  SsrcDescription,
} from "./sdp";
import {
  DtlsState,
  RTCCertificate,
  RTCDtlsParameters,
  RTCDtlsTransport,
} from "./transport/dtls";
import {
  IceState,
  RTCIceGatherer,
  RTCIceParameters,
  RTCIceTransport,
} from "./transport/ice";
import { RTCSctpCapabilities, RTCSctpTransport } from "./transport/sctp";

type Configuration = {
  stunServer: [string, number];
  privateKey: string;
  certificate: string;
  codecs: { audio: RTCRtpCodecParameters[]; video: RTCRtpCodecParameters[] };
};

type SignalingState =
  | "stable"
  | "have-local-offer"
  | "have-remote-offer"
  | "closed";

export class RTCPeerConnection {
  cname = uuid.v4();
  datachannel = new Event<RTCDataChannel>();
  iceGatheringStateChange = new Event<IceState>();
  iceConnectionStateChange = new Event<IceState>();
  signalingStateChange = new Event<string>();
  onTrack = new Event<RTCRtpTransceiver>();
  router = new RtpRouter();
  private certificates = [RTCCertificate.unsafe_useDefaultCertificate()];
  private sctpTransport?: RTCSctpTransport;
  private sctpRemotePort?: number;
  private sctpRemoteCaps?: RTCSctpCapabilities;
  private remoteDtls: { [key: string]: RTCDtlsParameters } = {};
  private remoteIce: { [key: string]: RTCIceParameters } = {};
  get remoteIceKeys() {
    return Object.keys(this.remoteIce);
  }
  private seenMid = new Set<string>();
  private sctpMLineIndex?: number;

  private currentLocalDescription?: SessionDescription;
  private currentRemoteDescription?: SessionDescription;
  private pendingLocalDescription?: SessionDescription;
  private pendingRemoteDescription?: SessionDescription;
  private iceTransports = new Set<RTCIceTransport>();
  private _iceConnectionState: IceState = "new";
  private _iceGatheringState: IceState = "new";
  private _signalingState: SignalingState = "stable";
  private isClosed = false;
  private streamId = uuid.v4();
  private transceivers: RTCRtpTransceiver[] = [];

  constructor(private configuration: Partial<Configuration> = {}) {
    if (configuration.certificate && configuration.privateKey) {
      this.certificates = [
        new RTCCertificate(configuration.privateKey, configuration.certificate),
      ];
    }
    if (!configuration.codecs) {
      configuration.codecs = CODECS;
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

  private _localDescription() {
    return this.pendingLocalDescription || this.currentLocalDescription;
  }

  private _remoteDescription() {
    return this.pendingRemoteDescription || this.currentRemoteDescription;
  }

  private getTransceiverByMid(mid: string) {
    return this.transceivers.find((transceiver) => transceiver.mid === mid);
  }

  createOffer() {
    if (!this.sctpTransport && this.transceivers.length === 0)
      throw new Error(
        "Cannot create an offer with no media and no data channels"
      );

    this.transceivers.forEach((transceiver) => {
      transceiver.codecs = this.configuration.codecs[transceiver.kind];
    });

    const mids = [...this.seenMid];

    const description = new SessionDescription();
    addSDPHeader("offer", description);

    this.transceivers
      .filter((t) => t.mid === undefined)
      .forEach((transceiver) => {
        transceiver.mLineIndex = description.media.length;
        description.media.push(
          createMediaDescriptionForTransceiver(
            transceiver,
            this.cname,
            transceiver.direction,
            allocateMid(new Set(mids))
          )
        );
      });

    if (this.sctpTransport && !this.sctpTransport.mid) {
      this.sctpMLineIndex = description.media.length;
      description.media.push(
        createMediaDescriptionForSctp(
          this.sctpTransport,
          allocateMid(new Set(mids))
        )
      );
    }

    const bundle = new GroupDescription("BUNDLE", []);
    for (let media of description.media) {
      bundle.items.push(media.rtp.muxId);
    }
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

  private updateIceGatheringState() {
    let state: IceState = "new";

    const states = new Set(
      [...this.iceTransports].map((v) => v.iceGather.state)
    );
    if (isEqual([...states], ["completed"])) {
      state = "completed";
    }
    if (states.has("gathering")) {
      state = "gathering";
    }

    if (state !== this._iceGatheringState) {
      this._iceGatheringState = state;
      this.iceGatheringStateChange.execute(state);
    }
  }

  private updateIceConnectionState() {
    let state: IceState = "new";

    const states = new Set([...this.iceTransports].map((v) => v.state));
    if (this.isClosed) {
      state = "closed";
    } else if (states.has("failed")) {
      state = "failed";
    } else if (isEqual([...states], ["completed"])) {
      state = "completed";
    } else if (states.has("checking")) {
      state = "checking";
    } else if (states.has("disconnected")) {
      state = "disconnected";
    } else if (states.has("closed")) {
      state = "closed";
    }

    if (state !== this._iceConnectionState) {
      this._iceConnectionState = state;
      this.iceConnectionStateChange.execute(state);
    }
  }

  private createDtlsTransport(srtpProfiles: number[] = []) {
    const iceGatherer = new RTCIceGatherer(this.configuration.stunServer);
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
    this.iceTransports.add(iceTransport);

    this.updateIceGatheringState();
    this.updateIceConnectionState();

    const dtls = new RTCDtlsTransport(
      iceTransport,
      this.certificates,
      srtpProfiles
    );
    dtls.router = this.router;
    return dtls;
  }

  private createSctpTransport() {
    const sctp = new RTCSctpTransport(this.createDtlsTransport());
    sctp.bundled = false;
    sctp.mid = undefined;

    sctp.datachannel.subscribe((dc) => {
      this.datachannel.execute(dc);
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
    description.media.forEach((media) => {
      const mid = media.rtp.muxId;
      this.seenMid.add(mid);
      if (["audio", "video"].includes(media.kind)) {
        // todo
      }
      if (media.kind === "application") {
        if (!this.sctpTransport) throw new Error();
        this.sctpTransport.mid = mid;
      }
    });

    // # set ICE role
    if (description.type === "offer") {
      this.iceTransports.forEach((iceTransport) => {
        // todo fix
        iceTransport.connection.iceControlling = true;
        iceTransport.roleSet = true;
      });
    } else {
      this.iceTransports.forEach((iceTransport) => {
        // todo fix
        iceTransport.connection.iceControlling = false;
        iceTransport.roleSet = true;
      });
    }

    // # configure direction
    this.transceivers.forEach((t) => {
      if (["answer", "pranswer"].includes(description.type)) {
        t.currentDirection = t.direction;
      }
    });

    // # gather candidates
    await this.gather();
    description.media.map((media) => {
      if (["audio", "video"].includes(media.kind)) {
        // todo
      } else if (media.kind === "application") {
        addTransportDescription(media, this.sctpTransport.dtlsTransport);
      }
    });

    // # connect
    this.connect();

    // # replace description
    if (description.type === "answer") {
      this.currentLocalDescription = description;
      this.pendingLocalDescription = undefined;
    } else {
      this.pendingLocalDescription = description;
    }
  }

  private async gather() {
    await Promise.all([...this.iceTransports].map((t) => t.iceGather.gather()));
  }

  private async connect() {
    for (const transceiver of this.transceivers) {
      const dtlsTransport = transceiver.dtlsTransport;
      const iceTransport = dtlsTransport.iceTransport;
      const iceParam = this.remoteIce[transceiver.uuid];
      if (iceTransport.iceGather.getLocalCandidates() && iceParam) {
        await iceTransport.start(iceParam);
        if (dtlsTransport.state === DtlsState.NEW) {
          await dtlsTransport.start(this.remoteDtls[transceiver.uuid]);
        }
      }
    }

    if (this.sctpTransport) {
      const dtlsTransport = this.sctpTransport.dtlsTransport;
      const iceTransport = dtlsTransport.iceTransport;

      const candidates = iceTransport.iceGather.getLocalCandidates();
      const iceExist = !!this.remoteIce[this.sctpTransport.uuid];

      if (candidates && iceExist) {
        const params = this.remoteIce[this.sctpTransport.uuid];
        await iceTransport.start(params);

        if (!this.sctpRemotePort) throw new Error();

        if (dtlsTransport.state === DtlsState.NEW) {
          await dtlsTransport.start(this.remoteDtls[this.sctpTransport.uuid]);
          // todo fix
          await this.sctpTransport.start(this.sctpRemotePort!);
          await this.sctpTransport?.sctp.stateChanged.connected.asPromise();
          return;
        } else if (dtlsTransport.state === DtlsState.CONNECTED) {
          await this.sctpTransport.start(this.sctpRemotePort!);
          await this.sctpTransport?.sctp.stateChanged.connected.asPromise();
          return;
        }
      }
    }
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
          ssrc: media.ssrc[0].ssrc,
          payloadType: codec.payloadType,
        })
    );
    receiveParameters.encodings = encodings;
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
      if (!media.ice.usernameFragment || !media.ice.password)
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
    const trackEvents = [];
    for (let [i, media] of enumerate(description.media)) {
      let dtlsTransport: RTCDtlsTransport | undefined;

      if (["audio", "video"].includes(media.kind)) {
        const transceiver =
          this.transceivers.find(
            (t) =>
              t.kind === media.kind &&
              [undefined, media.rtp.muxId].includes(t.mid)
          ) || this.addTransceiver(media.kind, Direction.recvonly);

        if (!transceiver.mid) {
          transceiver.mid = media.rtp.muxId;
          transceiver.mLineIndex = i;
        }

        transceiver.codecs = media.rtp.codecs.filter((remoteCodec) =>
          (this.configuration.codecs[
            media.kind
          ] as RTCRtpCodecParameters[]).find(
            (localCodec) => localCodec.mimeType === remoteCodec.mimeType
          )
        );
        transceiver.headerExtensions = [];
        const direction = reverseDirection(media.direction);
        if (["answer", "pranswer"].includes(description.type)) {
          transceiver.currentDirection = direction;
        } else {
          transceiver.offerDirection = direction;
        }

        dtlsTransport = transceiver.dtlsTransport;
        this.remoteDtls[transceiver.uuid] = media.dtls;
        this.remoteIce[transceiver.uuid] = media.ice;
      } else if (media.kind === "application") {
        if (!this.sctpTransport) {
          this.sctpTransport = this.createSctpTransport();
        }
        if (!this.sctpTransport) throw new Error();
        if (!this.sctpTransport.mid) {
          this.sctpTransport.mid = media.rtp.muxId;
          this.sctpMLineIndex = i;
        }

        // # configure sctp
        this.sctpRemotePort = media.sctpPort;
        this.sctpRemoteCaps = media.sctpCapabilities;

        dtlsTransport = this.sctpTransport.dtlsTransport;

        if (!media.dtls) throw new Error();
        this.remoteDtls[this.sctpTransport.uuid] = media.dtls;
        this.remoteIce[this.sctpTransport.uuid] = media.ice;
      }

      if (dtlsTransport) {
        const iceTransport = dtlsTransport.iceTransport;
        await addRemoteCandidates(iceTransport, media);

        if (description.type === "offer" && !iceTransport.roleSet) {
          // todo
          iceTransport.connection.iceControlling = false;
          iceTransport.roleSet = true;
        }

        if (description.type === "answer") {
          dtlsTransport.role =
            media.dtls?.role === "client" ? "server" : "client";
        }
      }
    }

    // if (description.type === "answer")
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
        // todo
      }
      if (["recvonly", "sendrecv"].includes(transceiver.direction)) {
        const params = this.remoteRtp(transceiver);
        this.router.registerRtpReceiver(transceiver.receiver, params);
      }
    });
  }

  addTransceiver(kind: Kind, direction: Direction, bundle?: RTCRtpTransceiver) {
    const dtlsTransport = bundle
      ? bundle.dtlsTransport
      : this.createDtlsTransport([SRTP_PROFILE.SRTP_AES128_CM_HMAC_SHA1_80]);

    const transceiver = new RTCRtpTransceiver(
      kind,
      new RTCRtpReceiver(kind),
      new RTCRtpSender(kind, dtlsTransport),
      direction
    );
    if (bundle) transceiver.bundled = true;
    transceiver.receiver.setRtcpSsrc(transceiver.sender.ssrc);
    transceiver.dtlsTransport = dtlsTransport;
    this.transceivers.push(transceiver);

    this.onTrack.execute(transceiver);

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
      if (dtlsTransport!.role === "auto") {
        media!.dtls!.role = "client";
      } else {
        media!.dtls!.role = dtlsTransport!.role;
      }

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
    this.datachannel.allUnsubscribe();
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
  media.rtp = new RTCRtpParameters({ codecs: transceiver.codecs, muxId: mid });
  media.rtcpHost = "0.0.0.0";
  media.rtcpPort = 9;
  media.rtcpMux = true;
  media.ssrc = [new SsrcDescription({ ssrc: transceiver.sender.ssrc, cname })];
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
  media.ice = iceGatherer.getLocalParameters();

  if (media.iceCandidates.length > 0) {
    // select srflx
    const candidate = media.iceCandidates[media.iceCandidates.length - 1];
    media.host = candidate.ip;
    media.port = candidate.port;
  } else {
    media.host = DISCARD_HOST;
    media.port = DISCARD_PORT;
  }

  if (!media.dtls) {
    media.dtls = dtlsTransport.getLocalParameters();
  } else {
    media.dtls.fingerprints = dtlsTransport.getLocalParameters().fingerprints;
  }
}

function allocateMid(mids: Set<string>) {
  let mid = "";
  while (true) {
    mid = Math.random().toString().slice(2);
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

async function addRemoteCandidates(
  iceTransport: RTCIceTransport,
  media: MediaDescription
) {
  media.iceCandidates.forEach(iceTransport.addRemoteCandidate);
  await iceTransport.iceGather.gather();
  if (media.iceCandidatesComplete) {
    iceTransport.addRemoteCandidate(undefined);
  }
}

function reverseDirection(direction: Direction) {
  if (direction == Direction.sendonly) return Direction.recvonly;
  else if (direction == Direction.recvonly) return Direction.sendonly;
  return direction;
}
