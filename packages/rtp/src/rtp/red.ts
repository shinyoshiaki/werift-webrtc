// rfc2198

import { BitWriter2, getBit } from "../../../common/src";

// 0                   1                    2                   3
// 0 1 2 3 4 5 6 7 8 9 0 1 2 3  4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |F|   block PT  |  timestamp offset         |   block length    |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

// 0 1 2 3 4 5 6 7
// +-+-+-+-+-+-+-+-+
// |0|   Block PT  |
// +-+-+-+-+-+-+-+-+

export class Red {
  header!: RedHeader;
  payloads: {
    bin: Buffer;
    blockPT: number;
    /**14bit */
    timestampOffset?: number;
  }[] = [];

  static deSerialize(buf: Buffer) {
    const red = new Red();
    let offset = 0;
    [red.header, offset] = RedHeader.deSerialize(buf);

    red.header.payloads.forEach(({ blockLength, timestampOffset, blockPT }) => {
      if (blockLength && timestampOffset) {
        const payload = buf.slice(offset, offset + blockLength);
        red.payloads.push({ bin: payload, blockPT, timestampOffset });
        offset += blockLength;
      } else {
        const payload = buf.slice(offset);
        red.payloads.push({ bin: payload, blockPT });
      }
    });

    return red;
  }

  serialize() {
    this.header = new RedHeader();

    for (const { timestampOffset, blockPT, bin } of this.payloads) {
      if (timestampOffset) {
        this.header.payloads.push({
          fBit: 1,
          blockPT,
          blockLength: bin.length,
          timestampOffset,
        });
      } else {
        this.header.payloads.push({ fBit: 0, blockPT });
      }
    }

    let buf = this.header.serialize();
    for (const { bin } of this.payloads) {
      buf = Buffer.concat([buf, bin]);
    }

    return buf;
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

      payload.timestampOffset =
        (buf[offset] << 6) + ((buf[offset + 1] & 0b11111100) >> 2);
      offset++;
      payload.blockLength = ((buf[offset] & 0b11) << 8) + buf[offset + 1];
      offset += 2;
    }

    return [header, offset] as const;
  }

  serialize() {
    let buf = Buffer.alloc(0);
    for (const payload of this.payloads) {
      if (payload.timestampOffset && payload.blockLength) {
        const a = new BitWriter2(8)
          .set(payload.fBit)
          .set(payload.blockPT, 7).buffer;
        const b = Buffer.alloc(3);
        b.writeUInt16BE(
          (payload.timestampOffset << 2) | (payload.blockLength >> 8)
        );
        b.writeUInt8(payload.blockLength & 0b11111111, 2);

        buf = Buffer.concat([buf, a, b]);
      } else {
        const chunk = new BitWriter2(8).set(0).set(payload.blockPT, 7).buffer;
        buf = Buffer.concat([buf, chunk]);
      }
    }
    return buf;
  }
}

interface RedHeaderPayload {
  fBit: number;
  blockPT: number;
  /**14bit */
  timestampOffset?: number;
  /**10bit */
  blockLength?: number;
}
