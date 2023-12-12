import Event from "rx.mini";

import { RtcpPacket, RtpHeader, RtpPacket } from "..";
import { enumerate } from "../helper";
import { Pipeline } from "./base";

export class SampleBuilder extends Pipeline {
  private buffering: RtpPacket[] = [];

  constructor(
    private isFinalPacketInSequence: (header: RtpHeader) => boolean,
    streams?: {
      rtpStream?: Event<[RtpPacket]>;
      rtcpStream?: Event<[RtcpPacket]>;
    },
  ) {
    super(streams);
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
