import { range } from "lodash";
import { RtpHeader } from "../../vendor/rtp";

export class Nack {
  newEstSeqNum = 0;
  lost: number[] = [];
  constructor() {}

  onPacket(header: RtpHeader) {
    if (header.sequenceNumber < this.newEstSeqNum) return;
    this.newEstSeqNum = header.sequenceNumber;
    this.addMissing(header.sequenceNumber, this.newEstSeqNum + 1);
  }

  addMissing(from: number, to: number) {
    this.lost = this.lost.filter((seq) => to - seq > 10000);
    if (this.lost.length > 1000) {
      this.lost = this.lost.slice(-1000);
      // req keyframe ?
    }
    range(from, to).forEach((seq) => this.lost.push(seq));
  }
}
