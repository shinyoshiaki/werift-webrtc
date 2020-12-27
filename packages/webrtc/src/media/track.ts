import Event from "rx.mini";
import { RtpPacket } from "../../../rtp/src";
import { Kind } from "../typings/domain";

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
