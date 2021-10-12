import { RtcpPacket, RtpHeader, RtpPacket } from "..";
import { enumerate } from "../helper";
import { Pipeline } from "./domain";

export class SampleBuilder implements Pipeline {
  private packets: RtpPacket[] = [];
  private children?: Pipeline;

  constructor(
    private isFinalPacketInSequence: (header: RtpHeader) => boolean
  ) {}

  pipe(children: Pipeline) {
    this.children = children;
  }

  pushRtpPackets(packets: RtpPacket[]) {
    this.packets = [...this.packets, ...packets];

    let tail: number | undefined;
    for (const [i, p] of enumerate(this.packets)) {
      if (this.isFinalPacketInSequence(p.header)) {
        tail = i;
        break;
      }
    }
    if (tail == undefined) return;

    const frames = this.packets.slice(0, tail + 1);
    this.packets = this.packets.slice(tail + 1);

    this.children?.pushRtpPackets?.(frames);
  }

  pushRtcpPackets(packets: RtcpPacket[]) {
    this.children?.pushRtcpPackets?.(packets);
  }
}
