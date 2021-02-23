import debug from "debug";
import Event from "rx.mini";
import * as uuid from "uuid";
import { RtpHeader, RtpPacket } from "../../../rtp/src";
import { RTCDtlsTransport } from "../transport/dtls";
import { Kind } from "../typings/domain";
import {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpParameters,
} from "./parameters";
import { RTCRtpReceiver } from "./rtpReceiver";
import { RTCRtpSender } from "./rtpSender";
import { RtpTrack } from "./track";

const log = debug("werift:webrtc:rtpTransceiver");

export class RTCRtpTransceiver {
  readonly uuid = uuid.v4();
  readonly onTrack = new Event<[RtpTrack]>();
  mid?: string;
  mLineIndex?: number;
  _codecs: RTCRtpCodecParameters[] = [];
  get codecs() {
    return this._codecs;
  }
  set codecs(codecs: RTCRtpCodecParameters[]) {
    this._codecs = codecs;
    this.receiver.codecs = codecs;
  }
  headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
  senderParams?: RTCRtpParameters;
  options: Partial<TransceiverOptions> = {};
  inactive = false;

  constructor(
    public readonly kind: Kind,
    public readonly receiver: RTCRtpReceiver,
    public readonly sender: RTCRtpSender,
    public direction: Direction,
    public dtlsTransport: RTCDtlsTransport
  ) {}

  get msid() {
    return `${this.sender.streamId} ${this.sender.trackId}`;
  }

  addTrack(track: RtpTrack) {
    const exist = this.receiver.tracks.find((t) => {
      if (t.rid) return t.rid === track.rid;
      if (t.ssrc) return t.ssrc === track.ssrc;
    });
    if (!exist) {
      this.receiver.tracks.push(track);
      if (track.ssrc) this.receiver.trackBySSRC[track.ssrc] = track;
      if (track.rid) this.receiver.trackByRID[track.rid] = track;
      this.onTrack.execute(track);
    }
  }

  replaceRtp(header: RtpHeader) {
    this.sender.replaceRTP(header);
  }

  sendRtp = (rtp: Buffer | RtpPacket) => {
    if (this.direction === "inactive") {
      log("sendRtp", this.uuid, "direction inactive");
      return;
    }
    if (!this.senderParams) {
      log("sendRtp", this.uuid, "senderParams null");
      return;
    }

    this.sender.sendRtp(rtp, this.senderParams);
  };
}

export const Directions = [
  "sendonly",
  "sendrecv",
  "recvonly",
  "inactive",
] as const;

export type Direction = typeof Directions[number];

type SimulcastDirection = "send" | "recv";

export type TransceiverOptions = {
  simulcast: { direction: SimulcastDirection; rid: string }[];
};
