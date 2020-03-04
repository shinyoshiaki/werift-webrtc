import { RTCDataChannelParameters, RTCDataChannel } from "./dataChannel";
import { RTCSctpTransport } from "./transport/sctp";
import { RTCIceGatherer, RTCIceTransport } from "./transport/ice";
import { RTCDtlsTransport, RTCCertificate } from "./transport/dtls";
import { SessionDescription, GroupDescription, MediaDescription } from "./sdp";
import { DISCARD_PORT, DISCARD_HOST } from "./const";
import { RTCSessionDescription } from "./sessionDescription";

type Configuration = { stunServer?: [string, number] };

export class RTCPeerConnection {
  private certificates = [RTCCertificate.generateCertificate()];
  private sctp?: RTCSctpTransport;
  private seenMid = new Set<string>();
  private sctpMLineIndex?: number;

  private currentLocalDescription?: SessionDescription;
  private currentRemoteDescription?: SessionDescription;
  private pendingLocalDescription?: SessionDescription;
  private pendingRemoteDescription?: SessionDescription;
  private _iceConnectionState = "new";

  constructor(private configuration: Configuration) {}

  get iceConnectionState() {
    return this._iceConnectionState;
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

  private createDtlsTransport() {
    const iceGatherer = new RTCIceGatherer(this.configuration.stunServer);
    // iceGatherer.subject.subscribe
    const iceTransport = new RTCIceTransport(iceGatherer);
    // iceTransport.subject.subscribe

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
    // description.type = sessionDescription.type;
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
