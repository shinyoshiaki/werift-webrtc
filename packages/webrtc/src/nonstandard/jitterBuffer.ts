import { debug } from "debug";

import { uint16Add } from "../../../common/src";
import { RtpPacket } from "../../../rtp/src";

const log = debug("werift:packages/webrtc/src/nonstandard/jitterBuffer.ts");

export class JitterBuffer {
  static MaxRetry = 100;
  retry = 0;
  head?: number;
  buffer: { [sequenceNumber: number]: RtpPacket } = {};

  constructor(public maxRetry = JitterBuffer.MaxRetry) {}

  push(p: RtpPacket) {
    this.buffer[p.header.sequenceNumber] = p;

    if (this.head == undefined) {
      this.head = p.header.sequenceNumber;
    } else if (p.header.sequenceNumber != uint16Add(this.head, 1)) {
      if (this.retry++ >= this.maxRetry) {
        log("give up packet lost");
        this.head = uint16Add(this.head, 2);
      } else {
        return [];
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

    return packets;
  }
}
