import Event from "rx.mini";

import { RtpPacket } from "../../rtp/rtp";
import { SourceStream } from "./base";

export class RtpSourceStream extends SourceStream<{ rtp: RtpPacket }> {
  constructor(ev: Event<[RtpPacket]>) {
    super();

    ev.subscribe((rtp) => {
      this.write({ rtp });
    });
  }
}
