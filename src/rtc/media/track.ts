import Event from "rx.mini";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";

export class RtpTrack {
  ssrc?: number;
  rid?: string;
  onRtp = new Event<RtpPacket>();

  constructor(props: Partial<RtpTrack> = {}) {
    Object.assign(this, props);
  }
}
