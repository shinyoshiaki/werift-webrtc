import { range } from "lodash";
import { RtpPacket } from "../../vendor/rtp";

export class Nack {
  private newEstSeqNum = 0;
  private _lost: { [seqNum: number]: number } = {};

  get lost() {
    return Object.keys(this._lost).map(Number);
  }

  onPacket(packet: RtpPacket) {
    const { sequenceNumber } = packet.header;

    if (this.newEstSeqNum === 0) {
      this.newEstSeqNum = sequenceNumber;
      return;
    }

    if (this._lost[sequenceNumber]) {
      console.log("recovery lost", sequenceNumber);
      delete this._lost[sequenceNumber];
    }

    if (sequenceNumber > this.newEstSeqNum + 1) {
      range(this.newEstSeqNum + 1, sequenceNumber).forEach((seq) => {
        this._lost[seq] = 1;
      });
    } else {
      this.newEstSeqNum = sequenceNumber;
      return;
    }

    this.newEstSeqNum = sequenceNumber;

    if (Object.keys(this._lost).length > 1000) {
      this._lost = Object.entries(this._lost)
        .slice(-1000)
        .reduce((acc, [key, v]) => {
          acc[key] = v;
          return acc;
        }, {} as { [seqNum: number]: number });
    }
  }

  increment() {
    Object.keys(this._lost).forEach((seq) => {
      if (++this._lost[seq] > 10) {
        console.log("lost failed", seq);
        delete this._lost[seq];
      }
    });
  }
}
