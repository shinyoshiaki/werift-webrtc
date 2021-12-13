import { Red, RtpHeader, RtpPacket, uint16Add, uint32Add } from "../..";

export class RedHandler {
  private readonly size = 150;
  private sequenceNumbers: number[] = [];

  push(red: Red, rtp: RtpPacket) {
    const packets: RtpPacket[] = [];

    red.blocks.forEach(({ blockPT, timestampOffset, block: bin }, i) => {
      const sequenceNumber = uint16Add(
        rtp.header.sequenceNumber,
        -(red.blocks.length - (i + 1))
      );
      if (timestampOffset) {
        packets.push(
          new RtpPacket(
            new RtpHeader({
              timestamp: uint32Add(rtp.header.timestamp, -timestampOffset),
              payloadType: blockPT,
              ssrc: rtp.header.ssrc,
              sequenceNumber,
              marker: true,
            }),
            bin
          )
        );
      } else {
        packets.push(
          new RtpPacket(
            new RtpHeader({
              timestamp: rtp.header.timestamp,
              payloadType: blockPT,
              ssrc: rtp.header.ssrc,
              sequenceNumber,
              marker: true,
            }),
            bin
          )
        );
      }
    });

    const filtered = packets.filter((p) => {
      if (this.sequenceNumbers.includes(p.header.sequenceNumber)) {
        return false;
      } else {
        if (this.sequenceNumbers.length > this.size) {
          this.sequenceNumbers.shift();
        }
        this.sequenceNumbers.push(p.header.sequenceNumber);
        return true;
      }
    });
    return filtered;
  }
}
