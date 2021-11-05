// rfc2198

import { getBit, paddingByte } from "../../../common/src";

export class Red {
  header!: RedHeader;
  payloads: Buffer[] = [];

  static deSerialize(buf: Buffer) {
    const red = new Red();
    let offset = 0;
    [red.header, offset] = RedHeader.deSerialize(buf);

    red.header.payloads.forEach(({ blockLength }) => {
      if (blockLength) {
        red.payloads.push(buf.slice(offset, offset + blockLength));
        offset += blockLength;
      } else {
        red.payloads.push(buf.slice(offset));
      }
    });

    return red;
  }
}

export class RedHeader {
  payloads: RedHeaderPayload[] = [];
  offset = 0;

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

    header.offset = offset;

    return [header, offset] as const;
  }
}

type RedHeaderPayload = {
  fBit: number;
  blockPT: number;
  timestampOffset?: number;
  blockLength?: number;
};
