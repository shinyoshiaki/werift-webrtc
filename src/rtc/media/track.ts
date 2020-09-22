import Event from "rx.mini";
import { Kind } from "../../typings/domain";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";

export class RtpTrack {
  ssrc?: number;
  rid?: string;
  onRtp = new Event<RtpPacket>();
  kind: Kind;
  id: string;

  constructor(props: Partial<RtpTrack> = {}) {
    Object.assign(this, props);
  }
}
