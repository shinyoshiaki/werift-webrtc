import { RTCRtpReceiver } from "./rtpReceiver";
import { RTCRtpSender } from "./rtpSender";
import { RTCDtlsTransport } from "../transport/dtls";
import {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpParameters,
} from "./parameters";
import * as uuid from "uuid";
import { Kind } from "../../typings/domain";
import { RtpTrack } from "./track";
import Event from "rx.mini";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";

export type Direction = "sendonly" | "sendrecv" | "recvonly" | "inactive";

export type TransceiverOptions = {
  simulcast: { direction: "send" | "recv"; rid: string }[];
};

export class RTCRtpTransceiver {
  uuid = uuid.v4();
  bundled = false;
  mid?: string;
  mLineIndex?: number;
  dtlsTransport?: RTCDtlsTransport;
  codecs: RTCRtpCodecParameters[] = [];
  headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
  parameters: RTCRtpParameters;
  onTrack = new Event<RtpTrack>();
  options: Partial<TransceiverOptions> = {};

  constructor(
    public kind: Kind,
    public receiver: RTCRtpReceiver,
    public sender: RTCRtpSender,
    public direction: Direction
  ) {}

  addTrack(track: RtpTrack) {
    const exist = this.receiver.tracks.find((t) => {
      if (t.rid) return t.rid === track.rid;
      if (t.ssrc) return t.ssrc === track.ssrc;
    });
    if (!exist) {
      this.receiver.tracks.push(track);
      this.onTrack.execute(track);
    }
  }

  sendRtp = (rtp: Buffer | RtpPacket) => {
    if (this.direction === "inactive") return;
    if (!this.parameters)
      this.parameters = new RTCRtpParameters({
        muxId: this.mid,
        headerExtensions: this.headerExtensions,
      });
    this.sender.sendRtp(rtp, this.parameters);
  };
}
