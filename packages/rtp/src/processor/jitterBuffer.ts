import { debug } from "debug";

import { uint16Add } from "../../../common/src";
import { RtpPacket } from "..";
import { RtcpPacket } from "../rtcp/rtcp";
import { Pipeline } from "./base";

const log = debug("werift:packages/webrtc/src/nonstandard/jitterBuffer.ts");

export class JitterBuffer extends Pipeline {
  private retry = 0;
  private head?: number;
  private buffer: { [sequenceNumber: number]: RtpPacket } = {};

  maxRetry = 100;

  pushRtpPackets(packets: RtpPacket[]) {
    packets.forEach(this.onRtp);
  }

  pushRtcpPackets(packets: RtcpPacket[]) {
    this.children?.pushRtcpPackets?.(packets);
  }

  private onRtp = (p: RtpPacket) => {
    this.buffer[p.header.sequenceNumber] = p;

    if (this.head == undefined) {
      this.head = p.header.sequenceNumber;
    } else if (p.header.sequenceNumber != uint16Add(this.head, 1)) {
      if (this.retry++ >= this.maxRetry) {
        this.head = uint16Add(this.head, 2);
      } else {
        return;
      }
    } else {
      this.head = uint16Add(this.head, 1);
    }

    const packets: RtpPacket[] = [];
    let tail = this.head;
    for (; ; tail = uint16Add(tail, 1)) {
      const p = this.buffer[tail];
      if (p) {
        packets.push(p);
        delete this.buffer[tail];
      } else {
        break;
      }
    }
    this.head = uint16Add(tail, -1);

    this.children?.pushRtpPackets?.(packets);
  };
}
