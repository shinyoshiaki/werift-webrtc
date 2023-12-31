import Event from "rx.mini";

import { RtpPacket } from "../..";
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
  stats = {};
  buffer: RtpPacket[] = [];
  bufferFulfilled = false;

  constructor(
    private options: {
      payloadType?: number;
      clearInvalidPTPacket?: boolean;
      initialBufferLength?: number;
    } = {},
  ) {
    options.clearInvalidPTPacket = options.clearInvalidPTPacket ?? true;
  }

  toJSON() {
    return { ...this.stats };
  }

  pipe(cb: (chunk: RtpOutput) => void, destructor?: () => void) {
    this.cb = cb;
    this.destructor = destructor;
    return this;
  }

  input = (packet: Buffer | RtpPacket) => {
    const rtp = Buffer.isBuffer(packet)
      ? RtpPacket.deSerialize(packet)
      : packet;

    if (
      this.options.payloadType != undefined &&
      this.options.payloadType !== rtp.header.payloadType
    ) {
      if (this.options.clearInvalidPTPacket) {
        rtp.clear();
      }
      return;
    }

    this.stats["rtpSource"] =
      new Date().toISOString() +
      " timestamp:" +
      rtp?.header.timestamp +
      " seq:" +
      rtp?.header.sequenceNumber;

    const cb = this.cb;
    if (cb) {
      if (this.options.initialBufferLength) {
        if (this.bufferFulfilled) {
          cb({ rtp });
          return;
        }
        this.buffer.push(rtp);
        if (this.buffer.length > this.options.initialBufferLength) {
          this.buffer.forEach((rtp) => {
            cb({ rtp });
          });
          this.buffer = [];
          this.bufferFulfilled = true;
        }
      } else {
        cb({ rtp });
      }
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
