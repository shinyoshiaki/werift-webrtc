import { RtpPacket } from "../..";

export class RedHandler {
  private readonly size = 150;
  private sequenceNumbers: number[] = [];

  push(rtp: RtpPacket) {
    if (this.sequenceNumbers.includes(rtp.header.sequenceNumber)) {
      return undefined;
    }

    if (this.sequenceNumbers.length > this.size) {
      this.sequenceNumbers.shift();
    }
    this.sequenceNumbers.push(rtp.header.sequenceNumber);

    return rtp;
  }
}
