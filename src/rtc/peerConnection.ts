import { RTCDataChannelParameters, RTCDataChannel } from "./dataChannel";
import { RTCSctpTransport } from "./transport/sctp";
import {
  RTCIceGatherer,
  RTCIceTransport,
  RTCIceParameters
} from "./transport/ice";
import {
  RTCDtlsTransport,
  RTCCertificate,
  State,
  RTCDtlsParameters
} from "./transport/dtls";
import { SessionDescription, GroupDescription, MediaDescription } from "./sdp";
import { DISCARD_PORT, DISCARD_HOST } from "./const";
import { RTCSessionDescription } from "./sessionDescription";
import { isEqual } from "lodash";
import { Subject } from "rxjs";

type Configuration = { stunServer?: [string, number] };

export class RTCPeerConnection {
  iceGatheringStateChange = new Subject<string>();
  iceConnectionStateChange = new Subject<string>();
  signalingStateChange = new Subject<string>();

  private certificates = [RTCCertificate.generateCertificate()];
  private sctp?: RTCSctpTransport;
  private sctpRemotePort?: number;
  private remoteDtls: { [key: string]: RTCDtlsParameters } = {};
  private remoteIce: { [key: string]: RTCIceParameters } = {};
  private seenMid = new Set<string>();
  private sctpMLineIndex?: number;

  private currentLocalDescription?: SessionDescription;
  private currentRemoteDescription?: SessionDescription;
  private pendingLocalDescription?: SessionDescription;
  private pendingRemoteDescription?: SessionDescription;
  private iceTransports = new Set<RTCIceTransport>();
  private _iceConnectionState = "new";
  private _iceGatheringState = "new";
  private _signalingState = "stable";
  private isClosed = false;
  private initialOffer?: boolean;

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

  private localDescription() {
    return this.pendingLocalDescription || this.currentLocalDescription;
  }

  private remoteDescription() {
    return this.pendingRemoteDescription || this.currentRemoteDescription;
  }

  async createOffer() {
    if (!this.sctp)
      throw new Error(
        "Cannot create an offer with no media and no data channels"
      );

    const mids = [...this.seenMid];
    const ntpSeconds = Date.now() >> 32;
    const description = new SessionDescription();
    description.origin = `${ntpSeconds} ${ntpSeconds} IN IP4 0.0.0.0`;
    description.msidSemantic.push(new GroupDescription("WMS", ["*"]));
    description.type = "offer";

    const getMedia = (description?: SessionDescription) => {
      return description?.media || [];
    };

    const getMediaSection = (media: MediaDescription[], i: number) => {
      return media.length > i ? media[i] : undefined;
    };

    const localMedia = getMedia(this.localDescription());
    const remoteMedia = getMedia(this.remoteDescription());
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

    const nextMLineIndex = () => description.media.length;

    if (this.sctp && !this.sctp.mid) {
      this.sctpMLineIndex = nextMLineIndex();
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
    options: Partial<{ protocol: string }> = {}
  ) {
    const base: Required<typeof options> = { protocol: "" };
    const settings: typeof base = { ...base, ...options };

    if (!this.sctp) {
      this.sctp = this.createSctpTransport();
    }

    const parameters = new RTCDataChannelParameters();
    parameters.protocol = settings.protocol;
    parameters.label = label;

    return new RTCDataChannel(this.sctp, parameters);
  }

  private updateIceGatheringState() {
    let state = "new";

    const states = new Set([...this.iceTransports].map(v => v.iceGather.state));
    if (isEqual(states, new Set(["completed"]))) {
      state = "complete";
    } else if (states.has("gathering")) {
      state = "gathering";
    }

    if (state !== this._iceGatheringState) {
      this._iceGatheringState = state;
      this.iceGatheringStateChange.next(state);
    }
  }

  private updateIceConnectionState() {
    let state = "new";

    const states = new Set([...this.iceTransports].map(v => v.state));
    if (this.isClosed) {
      state = "closed";
    } else if (states.has("failed")) {
      state = "failed";
    } else if (isEqual(states, new Set(["completed"]))) {
      state = "completed";
    } else if (states.has("checking")) {
      state = "checking";
    }

    if (state !== this._iceConnectionState) {
      this._iceConnectionState = state;
      this.iceConnectionStateChange.next(state);
    }
  }

  private createDtlsTransport() {
    const iceGatherer = new RTCIceGatherer(this.configuration.stunServer);
    iceGatherer.subject.subscribe(this.updateIceGatheringState);
    const iceTransport = new RTCIceTransport(iceGatherer);
    iceTransport.subject.subscribe(this.updateIceConnectionState);
    this.iceTransports.add(iceTransport);

    this.updateIceGatheringState();
    this.updateIceConnectionState();

    return new RTCDtlsTransport(iceTransport, this.certificates);
  }

  private createSctpTransport() {
    const sctp = new RTCSctpTransport(this.createDtlsTransport());
    sctp.bundled = false;
    sctp.mid = undefined;

    // todo listen

    return sctp;
  }

  async setLocalDescription(sessionDescription: RTCSessionDescription) {
    const description = SessionDescription.parse(sessionDescription.sdp);
    description.type = sessionDescription.type;
    this.validateDescription(description, true);

    if (description.type === "offer") {
      this.setSignalingState("have-local-offer");
    } else if (description.type === "answer") {
      this.setSignalingState("stable");
    }

    description.media.forEach(media => {
      const mid = media.rtp.muxId;
      this.seenMid.add(mid);
      if (media.kind === "application") {
        if (!this.sctp) throw new Error();
        this.sctp.mid = mid;
      }
    });

    if (this.initialOffer === undefined) {
      this.initialOffer = description.type === "offer";
      this.iceTransports.forEach(
        iceTransport =>
          (iceTransport.connection.iceControlling = this.initialOffer!)
      );
    }

    await this.gather();
    description.media.map(media => {
      if (media.kind === "application") {
        if (!this.sctp) throw new Error();
        addTransportDescription(media, this.sctp.transport);
      }
    });

    await this.connect();

    if (description.type === "answer") {
      this.currentLocalDescription = description;
      this.pendingLocalDescription = undefined;
    } else {
      this.pendingLocalDescription = description;
    }
  }

  private async gather() {
    await Promise.all([...this.iceTransports].map(t => t.iceGather.gather()));
  }

  private async connect() {
    if (this.sctp) {
      const dtlsTransport = this.sctp.transport;
      const iceTransport = dtlsTransport.transport;
      if (
        iceTransport.iceGather.getLocalCandidates() &&
        Object.keys(this.remoteIce).includes(this.sctp.uuid)
      ) {
        await iceTransport.start(this.remoteIce[this.sctp.uuid]);
        if (dtlsTransport.state === State.NEW) {
          await dtlsTransport.start(this.remoteDtls[this.sctp.uuid]);
        }
        if (dtlsTransport.state === State.CONNECTED) {
          if (!this.sctpRemotePort) throw new Error();
          await this.sctp.start(this.sctpRemotePort);
        }
      }
    }
  }

  private setSignalingState(state: string) {
    this._signalingState = state;
    this.signalingStateChange.next(state);
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

    description.media.forEach(media => {
      if (!media.ice.usernameFragment || !media.ice.password)
        throw new Error("ICE username fragment or password is missing");
    });

    if (["answer", "pranswer"].includes(description.type || "")) {
      const offer = isLocal
        ? this.remoteDescription()
        : this.localDescription();
      if (!offer) throw new Error();
      const offerMedia = offer.media.map(v => [v.kind, v.rtp.muxId]);
      const answerMedia = description.media.map(v => [v.kind, v.rtp.muxId]);
      if (!isEqual(offerMedia, answerMedia))
        throw new Error("Media sections in answer do not match offer");
    }
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
    media.host = media.iceCandidates[0].ip;
    media.port = media.iceCandidates[0].port;
  } else {
    media.host = DISCARD_HOST;
    media.port = DISCARD_PORT;
  }

  media.dtls = dtlsTransport.getLocalParameters();
  if (iceTransport.role === "controlling") {
    media.dtls.role = "auto";
  } else {
    media.dtls.role = "client";
  }

  // dtls
  media.dtls;
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
