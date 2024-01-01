import { randomBytes } from "crypto";
import {
  BitStream,
  bufferReader,
  bufferWriter,
  getBit,
} from "../../../common/src";
import { AttributeClasses } from "./attributes";

// 0                   1                   2                   3
// 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |0 0|     STUN Message Type     |         Message Length        |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                         Magic Cookie                          |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                                                               |
// |                     Transaction ID (96 bits)                  |
// |                                                               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

export function randomTransactionId() {
  return randomBytes(12);
}

export class StunMessageHeader {
  messageType!: StunMessageType;
  messageLength!: number;
  static readonly magicCookie: number = 0x2112a442;
  transactionId!: Buffer;
  static readonly size = 20;

  constructor(
    props: Pick<
      StunMessageHeader,
      "messageType" | "messageLength" | "transactionId"
    >,
  ) {
    Object.assign(this, props);
  }

  serialize() {
    const messageType = this.messageType.serialize();

    const first2bytes = new BitStream(Buffer.alloc(2))
      .writeBits(2, 0)
      .writeBits(14, messageType);

    const message = Buffer.concat([
      first2bytes.uint8Array,
      bufferWriter([2, 4], [this.messageLength, StunMessageHeader.magicCookie]),
      this.transactionId,
    ]);
    return message;
  }

  static Deserialize(buf: Buffer) {
    if (!this.isStunMessage(buf)) {
      throw new Error();
    }

    const [first2bytes, messageLength, magicCookie] = bufferReader(
      buf,
      [2, 2, 4],
    );
    const transactionId = buf.subarray(8, 20);
    const messageType = StunMessageType.Deserialize(
      first2bytes & 0b0011111111111111,
    );

    if (this.magicCookie !== magicCookie) {
      throw new Error();
    }

    const message = new StunMessageHeader({
      messageLength,
      messageType,
      transactionId,
    });
    return message;
  }

  static isStunMessage(buf: Buffer) {
    const check = getBit(buf[0], 0, 2);
    if (check === 0) {
      return true;
    }
    return false;
  }
}

export const Request = 0x000 as const;
export const Indication = 0x010 as const;
export const SuccessResponse = 0x100 as const;
export const ErrorResponse = 0x110 as const;
export type StunClass =
  | typeof Request
  | typeof Indication
  | typeof SuccessResponse
  | typeof ErrorResponse;

export const Binding = 1;

// 0                 1
// 2  3  4 5 6 7 8 9 0 1 2 3 4 5
// +--+--+-+-+-+-+-+-+-+-+-+-+-+-+
// |M |M |M|M|M|C|M|M|M|C|M|M|M|M|
// |11|10|9|8|7|1|6|5|4|0|3|2|1|0|
// +--+--+-+-+-+-+-+-+-+-+-+-+-+-+
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+
export class StunMessageType {
  stunMethod!: number;
  stunClass!: StunClass;

  constructor(props: Partial<StunMessageType>) {
    Object.assign(this, props);
  }

  serialize(): number {
    let m = this.stunMethod;
    const m0 = m & 0b000000001111;
    const m1 = (m & 0b000001110000) << 1;
    const m2 = (m & 0b111110000000) << 2;

    m = m0 + m1 + m2;

    let c = this.stunClass;
    const c0 = (c & 0b01) << 4;
    const c1 = (c & 0b10) << 7;
    c = (c0 + c1) as StunClass;

    return m + c;
  }

  static Deserialize(messageType: number) {
    const c = messageType & 0b00000100010000;
    const m = messageType & 0b11111011101111;
    return new StunMessageType({ stunClass: c as StunClass, stunMethod: m });
  }
}

// 0                   1                   2                   3
// 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |         Type                  |            Length             |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                         Value (variable)                ....
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

export class StunAttribute {
  type!: number;
  /**Lengthフィールドの値は、パディング前の属性のValue部分の長さを、バイト単位で含まなければならない */
  length!: number;
  value!: Buffer;

  static readonly HeaderSize = 4;

  constructor(props: Pick<StunAttribute, "type" | "length" | "value">) {
    Object.assign(this, props);
  }

  static FromAttribute(attribute: AttributeClasses) {
    const buf = attribute.serialize();
    return new StunAttribute({
      type: attribute.type,
      length: buf.length,
      value: buf,
    });
  }

  serialize() {
    const header = bufferWriter([2, 2], [this.type, this.length]);
    const pad = 4 % this.length;
    const value = Buffer.concat([this.value, Buffer.alloc(pad)]);
    const buf = Buffer.concat([header, value]);
    return buf;
  }

  static Deserialize(buf: Buffer) {
    const [type, length] = bufferReader(buf, [2, 2]);
    const value = buf.subarray(this.HeaderSize, this.HeaderSize + length);
    const attribute = new StunAttribute({ type, length, value });
    return attribute;
  }
}

export class StunMessage {
  constructor(
    readonly header: StunMessageHeader,
    readonly attributes: StunAttribute[],
  ) {}

  serialize() {
    const header = this.header.serialize();
    const attributes = Buffer.concat(this.attributes.map((a) => a.serialize()));
    return Buffer.concat([header, attributes]);
  }

  static Deserialize(buf: Buffer) {
    const header = StunMessageHeader.Deserialize(buf);
    const message = buf.subarray(StunMessageHeader.size);

    const attributes: StunAttribute[] = [];

    for (let i = 0; i < message.length; ) {
      const attr = StunAttribute.Deserialize(message.subarray(i));
      i += attr.length + StunAttribute.HeaderSize;
      attributes.push(attr);
    }

    return new StunMessage(header, attributes);
  }
}
