import {
  float32bit,
  numberToByteArray,
  stringToByteArray,
} from "./typedArrayUtils";

export interface EBMLData {
  write(buf: Uint8Array, pos: number): number;
  countSize(): number;
}

export class Value implements EBMLData {
  constructor(public bytes: Uint8Array) {}

  public write(buf: Uint8Array, pos: number): number {
    buf.set(this.bytes, pos);
    return pos + this.bytes.length;
  }

  public countSize(): number {
    return this.bytes.length;
  }
}

export class Element implements EBMLData {
  private readonly size: number;
  private readonly sizeMetaData: Uint8Array;

  constructor(
    private id: Uint8Array,
    private children: EBMLData[],
    isSizeUnknown: boolean,
  ) {
    const bodySize = this.children.reduce((p, c) => p + c.countSize(), 0);
    this.sizeMetaData = isSizeUnknown
      ? UNKNOWN_SIZE
      : vintEncode(numberToByteArray(bodySize, getEBMLByteLength(bodySize)));
    this.size = this.id.length + this.sizeMetaData.length + bodySize;
  }

  public write(buf: Uint8Array, pos: number): number {
    buf.set(this.id, pos);
    buf.set(this.sizeMetaData, pos + this.id.length);
    return this.children.reduce(
      (p, c) => c.write(buf, p),
      pos + this.id.length + this.sizeMetaData.length,
    );
  }

  public countSize(): number {
    return this.size;
  }
}

export const bytes = (data: Uint8Array): Value => {
  return new Value(data);
};

export const number = (num: number): Value => {
  return bytes(numberToByteArray(num));
};

export const float = (num: number): Value => bytes(float32bit(num));

export const vintEncodedNumber = (num: number): Value => {
  return bytes(vintEncode(numberToByteArray(num, getEBMLByteLength(num))));
};

/**
 * Decode a vint-encoded unsigned integer previously produced by `vintEncodedNumber`.
 * Returns its numeric value (number if within MAX_SAFE_INTEGER, otherwise bigint) and the length in bytes.
 * Throws if the value is the EBML unknown-size sentinel.
 */
export const decodeVintEncodedNumber = (
  buf: Uint8Array,
  offset = 0,
): { value: number | bigint; length: number } => {
  const { value, length, unknown } = vintDecode(buf, offset);
  if (unknown || value === undefined) {
    throw new Error("decodeVintEncodedNumber: value is unknown size sentinel");
  }
  return { value, length };
};

export const string = (str: string): Value => {
  return bytes(stringToByteArray(str));
};

export const element = (
  id: Uint8Array,
  child: EBMLData | EBMLData[],
): EBMLData => {
  return new Element(id, Array.isArray(child) ? child : [child], false);
};

export const unknownSizeElement = (
  id: Uint8Array,
  child: EBMLData | EBMLData[],
): EBMLData => {
  return new Element(id, Array.isArray(child) ? child : [child], true);
};

export const build = (v: EBMLData): Uint8Array => {
  const b = new Uint8Array(v.countSize());
  v.write(b, 0);
  return b;
};

export const getEBMLByteLength = (num: number | bigint): number => {
  if (num < 0x7f) {
    return 1;
  } else if (num < 0x3fff) {
    return 2;
  } else if (num < 0x1fffff) {
    return 3;
  } else if (num < 0xfffffff) {
    return 4;
  } else if (num < 0x7ffffffff) {
    return 5;
  } else if (num < 0x3ffffffffff) {
    return 6;
  } else if (num < 0x1ffffffffffff) {
    return 7;
  } else if (num < 0x20000000000000n) {
    return 8;
  } else if (num < 0xffffffffffffffn) {
    throw new Error(
      "EBMLgetEBMLByteLength: number exceeds Number.MAX_SAFE_INTEGER",
    );
  } else {
    throw new Error(
      "EBMLgetEBMLByteLength: data size must be less than or equal to " +
        (2 ** 56 - 2),
    );
  }
};

export const UNKNOWN_SIZE = new Uint8Array([
  0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
]);

export const vintEncode = (byteArray: Uint8Array): Uint8Array => {
  byteArray[0] = getSizeMask(byteArray.length) | byteArray[0];
  return byteArray;
};

export const getSizeMask = (byteLength: number): number => {
  return 0x80 >> (byteLength - 1);
};

export interface VIntDecodeResult {
  /** The decoded value. Undefined if the VINT represents an unknown size sentinel (all value bits = 1). */
  value: number | bigint | undefined;
  /** Total number of bytes consumed by this VINT. */
  length: number;
  /** True when this VINT encodes the EBML "unknown size" value (all value bits set to 1). */
  unknown: boolean;
}

/**
 * Decode an EBML variable size integer (VINT) from the provided buffer.
 *
 * Encoding recap (EBML spec):
 *   The length (N, 1..8) is indicated by the position of the first set bit in the first byte.
 *   Patterns:
 *     1xxxxxxx -> 1 byte total  (7 value bits)
 *     01xxxxxx xxxxxxxx -> 2 bytes total (14 value bits)
 *     001xxxxx ...... -> 3 bytes total (21 value bits)
 *     ...
 *     00000001 [7 subsequent bytes] -> 8 bytes total (56 value bits)
 *
 * The marker bit itself is cleared from the first byte to recover the value bits.
 * Total value bits = 7 * N.
 * A value with all value bits set to 1 is reserved for the "unknown size" sentinel.
 */
export const vintDecode = (buf: Uint8Array, offset = 0): VIntDecodeResult => {
  if (offset >= buf.length) {
    throw new Error("vintDecode: offset out of range");
  }
  const first = buf[offset];
  if (first === 0) {
    throw new Error("vintDecode: invalid first byte 0x00 (no leading 1 bit)");
  }

  // Determine length by locating first set bit (MSB towards LSB)
  let length = 0;
  for (let i = 0; i < 8; i++) {
    const mask = 0x80 >> i;
    if (first & mask) {
      length = i + 1; // Length is position index + 1
      break;
    }
  }
  if (length === 0) {
    throw new Error("vintDecode: could not determine length");
  }
  if (offset + length > buf.length) {
    throw new Error("vintDecode: insufficient bytes for declared length");
  }

  // Mask out the length marker bit(s) in the first byte
  const lengthMarker = getSizeMask(length);
  let valueBig = BigInt(first & ~lengthMarker);

  for (let i = 1; i < length; i++) {
    valueBig = (valueBig << 8n) | BigInt(buf[offset + i]);
  }

  // Maximum value (all value bits = 1) indicates unknown size
  const allOnes = (1n << BigInt(7 * length)) - 1n; // 7 value bits per byte
  const unknown = valueBig === allOnes;

  let value: number | bigint | undefined;
  if (unknown) {
    value = undefined;
  } else if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
    value = Number(valueBig);
  } else {
    value = valueBig; // preserve precision as bigint
  }

  return { value, length, unknown };
};
