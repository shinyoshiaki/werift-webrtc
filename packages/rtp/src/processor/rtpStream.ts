import { ReadableStream, ReadableStreamController } from "stream/web";

import { RtpPacket } from "../rtp/rtp";
import { RtpOutput } from "./rtpCallback";

export class RtpSourceStream {
  readable: ReadableStream<RtpOutput>;
  write!: (chunk: RtpOutput) => void;
  protected controller!: ReadableStreamController<RtpOutput>;

  constructor(
    private options: {
      payloadType?: number;
      clearInvalidPTPacket?: boolean;
    } = {},
  ) {
    options.clearInvalidPTPacket = options.clearInvalidPTPacket ?? true;

    this.readable = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
        this.write = (chunk) => controller.enqueue(chunk);
      },
    });
  }

  push = (packet: Buffer | RtpPacket) => {
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

    this.write({ rtp });
  };

  stop() {
    this.controller.enqueue({ eol: true });
  }
}
