import debug from "debug";
import Event from "rx.mini";
import * as uuid from "uuid";
import { RTCDtlsTransport } from "../transport/dtls";
import { Kind } from "../types/domain";
import {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
} from "./parameters";
import { RTCRtpReceiver } from "./rtpReceiver";
import { RTCRtpSender } from "./rtpSender";
import { MediaStreamTrack } from "./track";

const log = debug("werift:webrtc:rtpTransceiver");

export class RTCRtpTransceiver {
  readonly uuid = uuid.v4();
  readonly onTrack = new Event<[MediaStreamTrack]>();
  mid?: string;
  mLineIndex?: number;
  _codecs: RTCRtpCodecParameters[] = [];
  get codecs() {
    return this._codecs;
  }
  set codecs(codecs: RTCRtpCodecParameters[]) {
    this._codecs = codecs;
    this.receiver.codecs = codecs;
    this.sender.codec = codecs[0];
  }
  headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
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

  addTrack(track: MediaStreamTrack) {
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
