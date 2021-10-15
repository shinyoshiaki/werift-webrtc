import Event from "rx.mini";

import { RtcpPacket, RtpHeader, RtpPacket } from "..";
import { enumerate } from "../helper";
import { Output, Pipeline } from "./model";

export class SampleBuilder implements Pipeline {
  private buffering: RtpPacket[] = [];
  private children?: Pipeline | Output;

  constructor(
    private isFinalPacketInSequence: (header: RtpHeader) => boolean,
    streams?: {
      rtpStream?: Event<[RtpPacket]>;
      rtcpStream?: Event<[RtcpPacket]>;
    }
  ) {
    streams?.rtpStream?.subscribe?.((packet) => {
      this.pushRtpPackets([packet]);
    });
    streams?.rtcpStream?.subscribe?.((packet) => {
      this.pushRtcpPackets([packet]);
    });
  }

  pipe(children: Pipeline | Output) {
    this.children = children;
    return this;
  }

  pushRtpPackets(incoming: RtpPacket[]) {
    this.buffering = [...this.buffering, ...incoming];

    let tail: number | undefined;
    for (const [i, p] of enumerate(this.buffering)) {
      if (this.isFinalPacketInSequence(p.header)) {
        tail = i;
        break;
      }
    }
    if (tail == undefined) {
      return;
    }

    const packets = this.buffering.slice(0, tail + 1);
    this.buffering = this.buffering.slice(tail + 1);

    this.children?.pushRtpPackets?.(packets);
  }

  pushRtcpPackets(packets: RtcpPacket[]) {
    this.children?.pushRtcpPackets?.(packets);
  }
}
