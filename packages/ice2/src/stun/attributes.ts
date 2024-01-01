import {
  BitStream,
  bufferReader,
  bufferWriter,
  bufferXor,
  getBit,
} from "../../../common/src";
import { StunAttribute, StunMessageHeader } from "./message";

// 0                   1                   2                   3
// 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |0 0 0 0 0 0 0 0|    Family     |         X-Port                |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                X-Address (Variable)
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

export const IPv4 = 1 as const;
export const IPv6 = 2 as const;
export type Family = typeof IPv4 | typeof IPv6;

export class XorAddressAttribute {
  family!: Family;
  xPort!: number;
  xAddress!: number;
  type!: number;

  constructor(props: Partial<XorAddressAttribute>) {
    Object.assign(this, props);
  }

  serialize() {
    const header = bufferWriter([1, 1, 2], [0, this.family, this.xPort]);
    const xAddress =
      this.family === 1
        ? bufferWriter([4], [this.xAddress])
        : bufferWriter([16], [this.xAddress]);
    return Buffer.concat([header, xAddress]);
  }

  static Deserialize(buf?: Buffer) {
    if (!buf) {
      return;
    }
    const [, family, xPort] = bufferReader(buf, [1, 1, 2]);
    const xAddress =
      family === 1
        ? buf.subarray(4).readUint32BE()
        : buf.subarray(4).readUintBE(0, 16);
    return new XorAddressAttribute({ family, xPort, xAddress });
  }
}

export function xorPort(xPort: number) {
  const xor = bufferXor(
    bufferWriter([2, 2], [xPort, 0]),
    bufferWriter([4], [StunMessageHeader.magicCookie])
  );
  return xor.readUint16BE();
}

export function xorAddress(xAddress: number) {
  const xor = bufferXor(
    bufferWriter([4], [xAddress]),
    bufferWriter([4], [StunMessageHeader.magicCookie])
  );
  return xor;
}

export function xorIPv4Address(xAddress: number) {
  const xor = bufferXor(
    bufferWriter([4], [xAddress]),
    bufferWriter([4], [StunMessageHeader.magicCookie])
  );
  return xor;
}

export function xorIPv6Address(xAddress: number) {
  const xor = bufferXor(
    bufferWriter([16], [xAddress]),
    bufferWriter([16], [StunMessageHeader.magicCookie])
  );
  return xor;
}

export class StringAttribute {
  value!: string;
  type!: number;

  constructor(props: Partial<StringAttribute>) {
    Object.assign(this, props);
  }

  serialize() {
    return Buffer.from(this.value, "utf8");
  }

  static Deserialize(buf: Buffer) {
    return new StringAttribute({ value: buf.toString("utf8") });
  }
}

export class BytesAttribute {
  value!: Buffer;
  type!: number;

  constructor(props: Partial<BytesAttribute>) {
    Object.assign(this, props);
  }

  serialize() {
    return this.value;
  }

  static Deserialize(buf: Buffer) {
    return new BytesAttribute({ value: buf });
  }
}

export class UInt32Attribute {
  value!: number;
  type!: number;

  constructor(props: Partial<UInt32Attribute>) {
    Object.assign(this, props);
  }

  serialize() {
    return bufferWriter([4], [this.value]);
  }

  static Deserialize(buf?: Buffer) {
    if (!buf) {
      return;
    }
    return new UInt32Attribute({ value: buf.readUInt32BE() });
  }
}

export class UInt64Attribute {
  value!: bigint;
  type!: number;

  constructor(props: Partial<UInt64Attribute>) {
    Object.assign(this, props);
  }

  serialize() {
    return bufferWriter([8], [this.value]);
  }

  static Deserialize(buf?: Buffer) {
    if (!buf) {
      return;
    }
    return new UInt64Attribute({ value: buf.readBigUInt64BE() });
  }
}

export class NullAttribute {
  type!: number;

  constructor(props: Partial<NullAttribute>) {
    Object.assign(this, props);
  }

  serialize() {
    return Buffer.alloc(0);
  }

  static Deserialize() {
    return new NullAttribute({});
  }
}

// 0                   1                   2                   3
// 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |           Reserved, should be 0         |Class|     Number    |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |      Reason Phrase (variable)                                ..
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

export class ErrorAttribute {
  code!: number;
  reason!: string;
  type!: number;

  constructor(props: Partial<ErrorAttribute>) {
    Object.assign(this, props);
  }

  serialize() {
    const r1 = Buffer.alloc(2);
    const rc = new BitStream(Buffer.alloc(1))
      .writeBits(5, 0)
      .writeBits(3, Math.floor(this.code / 100));
    const number = bufferWriter([1], [this.code % 100]);
    return Buffer.concat([
      r1,
      rc.uint8Array,
      number,
      Buffer.from(this.reason, "utf8"),
    ]);
  }

  static Deserialize(buf?: Buffer) {
    if (!buf) {
      return;
    }
    const [_, RC, number] = bufferReader(buf, [2, 1, 1]);
    const errorClass = getBit(RC, 6);
    const errorCode = errorClass * 100 + number;
    const reason = buf.subarray(4).toString("utf8");
    return new ErrorAttribute({ code: errorCode, reason });
  }
}

export const Attributes = {
  username: {
    type: 0x0006,
    serialize: (s: string) =>
      StunAttribute.FromAttribute(
        new StringAttribute({ value: s, type: Attributes.username.type })
      ),
  },
  messageIntegrity: { type: 0x0008, attr: BytesAttribute },
  errorCode: {
    type: 0x0009,
    serialize: (code: number, reason: string) =>
      StunAttribute.FromAttribute(
        new ErrorAttribute({ code, reason, type: Attributes.errorCode.type })
      ),
    deserialize: (attr: StunAttribute[]) =>
      ErrorAttribute.Deserialize(
        attr.find((a) => a.type === Attributes.errorCode.type)?.value
      ),
  },
  xorMappedAddress: {
    type: 0x0020,
    attr: XorAddressAttribute,
    deserialize: (attr: StunAttribute[]) =>
      XorAddressAttribute.Deserialize(
        attr.find((a) => a.type === Attributes.xorMappedAddress.type)?.value
      ),
  },
  priority: {
    type: 0x0024,
    serialize: (p: number) =>
      StunAttribute.FromAttribute(
        new UInt32Attribute({
          value: p,
          type: Attributes.priority.type,
        })
      ),
    deserialize: (attr: StunAttribute[]) =>
      UInt32Attribute.Deserialize(
        attr.find((a) => a.type === Attributes.priority.type)?.value
      ),
  },
  useCandidate: {
    type: 0x0025,
    serialize: () =>
      StunAttribute.FromAttribute(
        new NullAttribute({ type: Attributes.useCandidate.type })
      ),
    deserialize: (attr: StunAttribute[]) =>
      attr.find((a) => a.type === Attributes.useCandidate.type)?.value
        ? NullAttribute.Deserialize()
        : undefined,
  },
  iceControlled: {
    type: 0x8029,
    serialize: (n: bigint) =>
      StunAttribute.FromAttribute(
        new UInt64Attribute({ value: n, type: Attributes.iceControlled.type })
      ),
    deserialize: (attr: StunAttribute[]) =>
      UInt64Attribute.Deserialize(
        attr.find((a) => a.type === Attributes.iceControlled.type)?.value
      ),
  },
  iceControlling: {
    type: 0x802a,
    serialize: (n: bigint) =>
      StunAttribute.FromAttribute(
        new UInt64Attribute({ value: n, type: Attributes.iceControlling.type })
      ),
    deserialize: (attr: StunAttribute[]) =>
      UInt64Attribute.Deserialize(
        attr.find((a) => a.type === Attributes.iceControlling.type)?.value
      ),
  },
} as const;

export type AttributeClasses =
  | StringAttribute
  | BytesAttribute
  | UInt64Attribute
  | NullAttribute
  | ErrorAttribute
  | UInt32Attribute
  | XorAddressAttribute;
