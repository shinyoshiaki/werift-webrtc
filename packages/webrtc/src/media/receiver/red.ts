import { Red, RtpHeader, RtpPacket, uint16Add, uint32Add } from "../..";

// 0                   1                    2                   3
// 0 1 2 3 4 5 6 7 8 9 0 1 2 3  4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |F|   block PT  |  timestamp offset         |   block length    |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

// 0 1 2 3 4 5 6 7
// +-+-+-+-+-+-+-+-+
// |0|   Block PT  |
// +-+-+-+-+-+-+-+-+

export class AudioRedHandler {
  private readonly size = 150;
  private sequenceNumbers: number[] = [];

  push(red: Red, rtp: RtpPacket) {
    const packets: RtpPacket[] = [];

    red.blocks.forEach(({ blockPT, timestampOffset, block }, i) => {
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
            block
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
            block
          )
        );
      }
    });

    const filtered = packets.filter((p) => {
      // duplicate
      if (this.sequenceNumbers.includes(p.header.sequenceNumber)) {
        return false;
      } else {
        // buffer overflow
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
