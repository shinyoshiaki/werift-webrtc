// rfc2198

import { debug } from "debug";

import { BitStream } from "../../../../common/src";

const log = debug("packages/rtp/src/rtp/red/packet.ts");

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

  static deSerialize(bufferOrArrayBuffer: Buffer | ArrayBuffer) {
    const buf =
      bufferOrArrayBuffer instanceof ArrayBuffer
        ? Buffer.from(bufferOrArrayBuffer)
        : bufferOrArrayBuffer;

    const red = new Red();
    let offset = 0;
    [red.header, offset] = RedHeader.deSerialize(buf);

    red.header.fields.forEach(({ blockLength, timestampOffset, blockPT }) => {
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
        this.header.fields.push({
          fBit: 1,
          blockPT,
          blockLength: bin.length,
          timestampOffset,
        });
      } else {
        this.header.fields.push({ fBit: 0, blockPT });
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
  fields: RedHeaderField[] = [];

  static deSerialize(buf: Buffer) {
    let offset = 0;
    const header = new RedHeader();

    for (;;) {
      const field: RedHeaderField = {} as any;
      header.fields.push(field);

      const bitStream = new BitStream(buf.slice(offset));
      field.fBit = bitStream.readBits(1);
      field.blockPT = bitStream.readBits(7);

      offset++;

      if (field.fBit === 0) {
        break;
      }

      field.timestampOffset = bitStream.readBits(14);
      field.blockLength = bitStream.readBits(10);

      offset += 3;
    }

    return [header, offset] as const;
  }

  serialize() {
    let buf = Buffer.alloc(0);
    for (const field of this.fields) {
      try {
        if (field.timestampOffset && field.blockLength) {
          const bitStream = new BitStream(Buffer.alloc(4))
            .writeBits(1, field.fBit)
            .writeBits(7, field.blockPT)
            .writeBits(14, field.timestampOffset)
            .writeBits(10, field.blockLength);
          buf = Buffer.concat([buf, bitStream.uint8Array]);
        } else {
          const bitStream = new BitStream(Buffer.alloc(1))
            .writeBits(1, 0)
            .writeBits(7, field.blockPT);
          buf = Buffer.concat([buf, bitStream.uint8Array]);
        }
      } catch (error: any) {
        log(error?.message);
        continue;
      }
    }
    return buf;
  }
}

interface RedHeaderField {
  fBit: number;
  blockPT: number;
  /**14bit */
  timestampOffset?: number;
  /**10bit */
  blockLength?: number;
}
