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
