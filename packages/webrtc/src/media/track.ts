import Event from "rx.mini";
import { Kind } from "../typings/domain";
import { RtpPacket } from "../../../rtp/src";

export class RtpTrack {
  ssrc?: number;
  rid?: string;
  kind: Kind;
  id: string;

  readonly onRtp = new Event<[RtpPacket]>();

  constructor(props: Partial<RtpTrack> = {}) {
    Object.assign(this, props);
  }
}
