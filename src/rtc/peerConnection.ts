import * as uuid from "uuid";
import { RTCDataChannelParameters, RTCDataChannel } from "./dataChannel";
import { RTCSctpTransport, RTCSctpCapabilities } from "./transport/sctp";
import {
  RTCIceGatherer,
  RTCIceTransport,
  RTCIceParameters,
  IceState,
} from "./transport/ice";
import {
  RTCDtlsTransport,
  DtlsState,
  RTCDtlsParameters,
  RTCCertificate,
} from "./transport/dtls";
import {
  SessionDescription,
  GroupDescription,
  MediaDescription,
  RTCSessionDescription,
  addSDPHeader,
} from "./sdp";
import { DISCARD_PORT, DISCARD_HOST } from "./const";
import { isEqual } from "lodash";
import { RTCRtpTransceiver } from "./media/rtpTransceiver";
import { RTCRtpReceiver } from "./media/rtpReceiver";
import { RTCRtpSender } from "./media/rtpSender";
import { enumerate } from "../helper";
import Event from "rx.mini";

type Configuration = { stunServer?: [string, number] };
type SignalingState =
  | "stable"
  | "have-local-offer"
  | "have-remote-offer"
  | "closed";

export class RTCPeerConnection {
  datachannel = new Event<RTCDataChannel>();
  iceGatheringStateChange = new Event<IceState>();
  iceConnectionStateChange = new Event<IceState>();
  signalingStateChange = new Event<string>();

  private certificates = [RTCCertificate.generateCertificate()];
  private sctp?: RTCSctpTransport;
  private sctpRemotePort?: number;
  private sctpRemoteCaps?: RTCSctpCapabilities;
  private remoteDtls: { [key: string]: RTCDtlsParameters } = {};
  private remoteIce: { [key: string]: RTCIceParameters } = {};
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

  constructor(private configuration: Configuration) {}

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

  createOffer() {
    if (!this.sctp)
      throw new Error(
        "Cannot create an offer with no media and no data channels"
      );

    const mids = [...this.seenMid];

    const description = new SessionDescription();
    addSDPHeader("offer", description);

    const getMedia = (description?: SessionDescription) => {
      return description?.media || [];
    };

    const getMediaSection = (media: MediaDescription[], i: number) => {
      return media.length > i ? media[i] : undefined;
    };

    const localMedia = getMedia(this._localDescription());
    const remoteMedia = getMedia(this._remoteDescription());
    [...Array(Math.max(localMedia.length, remoteMedia.length))].forEach(
      (_, i) => {
        const localM = getMediaSection(localMedia, i);
        const remoteM = getMediaSection(remoteMedia, i);

        const mediaKind = localM ? localM.kind : remoteM!.kind;
        const mid = localM ? localM.rtp.muxId : remoteM!.rtp.muxId;

        if (mediaKind === "application") {
          this.sctpMLineIndex = i;
          if (!this.sctp) throw new Error("exception");
          description.media.push(createMediaDescriptionForSctp(this.sctp, mid));
        }
      }
    );

    if (this.sctp && !this.sctp.mid) {
      this.sctpMLineIndex = description.media.length;
      description.media.push(
        createMediaDescriptionForSctp(this.sctp, allocateMid(new Set(mids)))
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
      throw new Error();

    if (!this.sctp) {
      this.sctp = this.createSctpTransport();
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

    return new RTCDataChannel(this.sctp, parameters);
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
    }

    if (state !== this._iceConnectionState) {
      this._iceConnectionState = state;
      this.iceConnectionStateChange.execute(state);
    }
  }

  private createDtlsTransport() {
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

    return new RTCDtlsTransport(iceTransport, this.certificates);
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
      if (media.kind === "application") {
        if (!this.sctp) throw new Error();
        this.sctp.mid = mid;
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

    // # gather candidates
    await this.gather();
    description.media.map((media) => {
      if (media.kind === "application") {
        addTransportDescription(media, this.sctp!.transport);
      }
    });

    // # connect
    // if (description.type === "offer")
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
    if (this.sctp) {
      const dtlsTransport = this.sctp.transport;
      const iceTransport = dtlsTransport.transport;

      const candidates = iceTransport.iceGather.getLocalCandidates();
      const iceExist = Object.keys(this.remoteIce).includes(this.sctp.uuid);

      if (candidates && iceExist) {
        const params = this.remoteIce[this.sctp.uuid];
        await iceTransport.start(params);

        if (!this.sctpRemotePort) throw new Error();

        if (dtlsTransport.state === DtlsState.NEW) {
          await dtlsTransport.start(this.remoteDtls[this.sctp.uuid]);
          // todo fix
          await this.sctp.start(this.sctpRemotePort!);
          await new Promise((r) => this.sctp?.sctp.connected.subscribe(r));
          return;
        } else if (dtlsTransport.state === DtlsState.CONNECTED) {
          await this.sctp.start(this.sctpRemotePort!);
          await new Promise((r) => this.sctp?.sctp.connected.subscribe(r));
          return;
        }
      }
    }
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
    for (let [i, media] of enumerate(description.media)) {
      let dtlsTransport: RTCDtlsTransport | undefined;

      if (["audio", "video"].includes(media.kind)) {
        const transceiver =
          this.transceivers.find(
            (t) =>
              t.kind === media.kind &&
              [undefined, media.rtp.muxId].includes(t.mid)
          ) || this.createTransceiver("recvonly", media.kind);
        if (!transceiver.mid) {
          transceiver.mid = media.rtp.muxId;
          transceiver.mLineIndex = i;
        }

        // const common=
        //todo
      } else if (media.kind === "application") {
        if (!this.sctp) {
          this.sctp = this.createSctpTransport();
        }
        if (!this.sctp) throw new Error();
        if (!this.sctp.mid) {
          this.sctp.mid = media.rtp.muxId;
          this.sctpMLineIndex = i;
        }

        // # configure sctp
        this.sctpRemotePort = media.sctpPort;
        this.sctpRemoteCaps = media.sctpCapabilities;

        dtlsTransport = this.sctp.transport;

        if (!media.dtls) throw new Error();
        this.remoteDtls[this.sctp.uuid] = media.dtls;
        this.remoteIce[this.sctp.uuid] = media.ice;
      }

      if (dtlsTransport) {
        const iceTransport = this.sctp!.transport.transport;
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
  }

  private createTransceiver(
    direction: string,
    kind: string,
    senderTrack = undefined
  ) {
    const dtlsTransport = this.createDtlsTransport();
    const transceiver = new RTCRtpTransceiver(
      kind,
      new RTCRtpReceiver(kind, dtlsTransport),
      new RTCRtpSender(senderTrack || kind, dtlsTransport),
      direction
    );
    transceiver.receiver.setRtcpSsrc(transceiver.sender.ssrc);
    transceiver.sender.streamId = this.streamId;
    transceiver.bundled = false;
    transceiver.transport = dtlsTransport;
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

      if (remoteM.kind === "application") {
        if (!this.sctp || !this.sctp.mid) throw new Error();
        media = createMediaDescriptionForSctp(this.sctp, this.sctp.mid);

        dtlsTransport = this.sctp.transport;
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

    if (this.sctp) {
      this.sctp.stop();
      await this.sctp.transport.transport.stop();
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
  addTransportDescription(media, sctp.transport);

  return media;
}

function addTransportDescription(
  media: MediaDescription,
  dtlsTransport: RTCDtlsTransport
) {
  const iceTransport = dtlsTransport.transport;
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
  let i = 0;
  while (true) {
    const mid = i.toString();
    if (![...mids].includes(mid)) {
      mids.add(mid);
      return mid;
    }
    i++;
  }
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

function filterPreferredCodecs() {}
