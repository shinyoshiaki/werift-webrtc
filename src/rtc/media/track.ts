import Event from "rx.mini";
import { Kind } from "../../typings/domain";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";

export class RtpTrack {
  ssrc?: number;
  rid?: string;
  readonly onRtp = new Event<RtpPacket>();
  kind: Kind;
  id: string;
  mediaSsrc?: number;
  sequenceNumber: number = 0;

  constructor(props: Partial<RtpTrack> = {}) {
    Object.assign(this, props);

    this.onRtp.subscribe((rtp) => {
      this.mediaSsrc = rtp.header.ssrc;
      this.sequenceNumber = rtp.header.sequenceNumber;
    });
  }
}
