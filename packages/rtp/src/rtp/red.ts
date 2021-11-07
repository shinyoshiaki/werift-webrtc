// rfc2198

import { getBit, paddingByte, uint16Add, uint32Add } from "../../../common/src";
import { RtpHeader, RtpPacket } from "..";

export class Red {
  header!: RedHeader;
  payloads: RtpPacket[] = [];

  static deSerialize(rtp: RtpPacket) {
    const buf = rtp.payload;

    const red = new Red();
    let offset = 0;
    [red.header, offset] = RedHeader.deSerialize(buf);

    red.header.payloads.forEach(
      ({ blockLength, timestampOffset, blockPT }, i) => {
        if (blockLength && timestampOffset) {
          const payload = buf.slice(offset, offset + blockLength);
          const redundantPacket = new RtpPacket(
            new RtpHeader({
              timestamp: uint32Add(rtp.header.timestamp, -timestampOffset),
              payloadType: blockPT,
              ssrc: rtp.header.ssrc,
              sequenceNumber: uint16Add(
                rtp.header.sequenceNumber,
                -(red.header.payloads.length - (i + 1))
              ),
              marker: true,
            }),
            payload
          );
          red.payloads.push(redundantPacket);
          offset += blockLength;
        } else {
          const payload = buf.slice(offset);
          const newPacket = new RtpPacket(
            new RtpHeader({
              timestamp: rtp.header.timestamp,
              payloadType: blockPT,
              ssrc: rtp.header.ssrc,
              sequenceNumber: rtp.header.sequenceNumber,
              marker: true,
            }),
            payload
          );
          red.payloads.push(newPacket);
        }
      }
    );

    return red;
  }
}

export class RedHeader {
  payloads: RedHeaderPayload[] = [];

  static deSerialize(buf: Buffer) {
    let offset = 0;
    const header = new RedHeader();

    for (;;) {
      const payload: RedHeaderPayload = {} as any;
      header.payloads.push(payload);
      payload.fBit = getBit(buf[offset], 0);
      payload.blockPT = getBit(buf[offset], 1, 7);
      offset++;

      if (payload.fBit === 0) {
        break;
      }

      const timestamp_a = paddingByte(getBit(buf[offset], 0, 8));
      offset++;
      const timestamp_b = paddingByte(getBit(buf[offset], 0, 6));
      payload.timestampOffset = parseInt(timestamp_a + timestamp_b, 2);

      const blockLength_a = paddingByte(getBit(buf[offset], 6, 2));
      offset++;
      const blockLength_b = paddingByte(getBit(buf[offset], 0, 8));
      offset++;
      payload.blockLength = parseInt(blockLength_a + blockLength_b, 2);
    }

    return [header, offset] as const;
  }

  serialize() {}
}

type RedHeaderPayload = {
  fBit: number;
  blockPT: number;
  timestampOffset?: number;
  blockLength?: number;
};
