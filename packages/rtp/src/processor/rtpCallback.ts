import Event from "rx.mini";

import { RtpPacket } from "../rtp/rtp";
import { SimpleProcessorCallback } from "./interface";

export type RtpInput = Buffer | RtpPacket;

export interface RtpOutput {
  rtp?: RtpPacket;
  eol?: boolean;
}

export class RtpSourceCallback
  implements SimpleProcessorCallback<RtpInput, RtpOutput>
{
  private cb?: (chunk: RtpOutput) => void;
  private destructor?: () => void;
  onStopped = new Event();

  constructor(
    private options: {
      payloadType?: number;
      clearInvalidPTPacket?: boolean;
    } = {}
  ) {
    options.clearInvalidPTPacket = options.clearInvalidPTPacket ?? true;
  }

  pipe(cb: (chunk: RtpOutput) => void, destructor?: () => void) {
    this.cb = cb;
    this.destructor = destructor;
    return this;
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
  }

  destroy = () => {
    if (this.destructor) {
      this.destructor();
      this.destructor = undefined;
    }
    this.cb = undefined;
    this.onStopped.allUnsubscribe();
  };
}
