import Event, { EventDisposer } from "rx.mini";

import { RtpPacket } from "../../rtp/rtp";
import { SourceStream } from "./base";

export interface RtpOutput {
  rtp?: RtpPacket;
  eol?: boolean;
}

export class RtpSourceStream extends SourceStream<RtpOutput> {
  private readonly disposer = new EventDisposer();

  constructor(ev: Event<[RtpPacket]>, options: { payloadType?: number } = {}) {
    super();

    ev.subscribe((rtp) => {
      if (
        options.payloadType != undefined &&
        options.payloadType !== rtp.header.payloadType
      ) {
        return;
      }

      this.write({ rtp });
    }).disposer(this.disposer);
  }

  async stop() {
    this.controller.enqueue({ eol: true });
    this.disposer.dispose();
  }
}
