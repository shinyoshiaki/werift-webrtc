import Event from "rx.mini";

import { RtpPacket } from "../../rtp/rtp";

export interface RtpOutput {
  rtp?: RtpPacket;
  eol?: boolean;
}

export class RtpSourceCallback {
  private cb?: (chunk: RtpOutput) => void;

  onStopped = new Event();

  constructor(
    private options: {
      payloadType?: number;
      clearInvalidPTPacket?: boolean;
    } = {}
  ) {
    options.clearInvalidPTPacket = options.clearInvalidPTPacket ?? true;
  }

  pipe(cb: (chunk: RtpOutput) => void) {
    this.cb = cb;
  }

  input = (packet: Buffer | RtpPacket) => {
    const rtp =
      packet instanceof RtpPacket ? packet : RtpPacket.deSerialize(packet);

    if (
      this.options.payloadType != undefined &&
      this.options.payloadType !== rtp.header.payloadType
    ) {
      if (this.options.clearInvalidPTPacket) {
        rtp.clear();
      }
      return;
    }

    if (this.cb) {
      this.cb({ rtp });
    }
  };

  stop() {
    if (this.cb) {
      this.cb({ eol: true });
    }
    this.onStopped.execute();

    this.cb = undefined;
    this.onStopped.allUnsubscribe();
  }
}
