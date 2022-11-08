import memoize from "lodash/memoize";

export const numberToByteArray = (
  num: number,
  byteLength: number = getNumberByteLength(num)
): Uint8Array => {
  let byteArray;
  if (byteLength === 1) {
    byteArray = new DataView(new ArrayBuffer(1));
    byteArray.setUint8(0, num);
  } else if (byteLength === 2) {
    byteArray = new DataView(new ArrayBuffer(2));
    byteArray.setUint16(0, num);
  } else if (byteLength === 3) {
    byteArray = new DataView(new ArrayBuffer(3));
    byteArray.setUint8(0, num >> 16);
    byteArray.setUint16(1, num & 0xffff);
  } else if (byteLength === 4) {
    byteArray = new DataView(new ArrayBuffer(4));
    byteArray.setUint32(0, num);
  } else if (/* byteLength === 5 && */ num < 0xffffffff) {
    // 4GB (upper limit for int32) should be enough in most cases
    byteArray = new DataView(new ArrayBuffer(5));
    byteArray.setUint32(1, num);
  } else if (byteLength === 5) {
    // Naive emulations of int64 bitwise opreators
    byteArray = new DataView(new ArrayBuffer(5));
    byteArray.setUint8(0, (num / 0x100000000) | 0);
    byteArray.setUint32(1, num % 0x100000000);
  } else if (byteLength === 6) {
    byteArray = new DataView(new ArrayBuffer(6));
    byteArray.setUint16(0, (num / 0x100000000) | 0);
    byteArray.setUint32(2, num % 0x100000000);
  } else if (byteLength === 7) {
    byteArray = new DataView(new ArrayBuffer(7));
    byteArray.setUint8(0, (num / 0x1000000000000) | 0);
    byteArray.setUint16(1, (num / 0x100000000) & 0xffff);
    byteArray.setUint32(3, num % 0x100000000);
  } else if (byteLength === 8) {
    byteArray = new DataView(new ArrayBuffer(8));
    byteArray.setUint32(0, (num / 0x100000000) | 0);
    byteArray.setUint32(4, num % 0x100000000);
  } else {
    throw new Error(
      "EBML.typedArrayUtils.numberToByteArray: byte length must be less than or equal to 8"
    );
  }
  return new Uint8Array(byteArray.buffer);
};

export const stringToByteArray = memoize((str: string): Uint8Array => {
  return Uint8Array.from(Array.from(str).map((_) => _.codePointAt(0)!));
});

export function getNumberByteLength(num: number | bigint): number {
  if (num < 0) {
    throw new Error(
      "EBML.typedArrayUtils.getNumberByteLength: negative number not implemented"
    );
  } else if (num < 0x100) {
    return 1;
  } else if (num < 0x10000) {
    return 2;
  } else if (num < 0x1000000) {
    return 3;
  } else if (num < 0x100000000) {
    return 4;
  } else if (num < 0x10000000000) {
    return 5;
  } else if (num < 0x1000000000000) {
    return 6;
  } else if (num < 0x20000000000000n) {
    return 7;
  } else {
    throw new Error(
      "EBML.typedArrayUtils.getNumberByteLength: number exceeds Number.MAX_SAFE_INTEGER"
    );
  }
}

export const int16Bit = memoize((num: number): Uint8Array => {
  const ab = new ArrayBuffer(2);
  new DataView(ab).setInt16(0, num);
  return new Uint8Array(ab);
});

export const float32bit = memoize((num: number): Uint8Array => {
  const ab = new ArrayBuffer(4);
  new DataView(ab).setFloat32(0, num);
  return new Uint8Array(ab);
});

export const dumpBytes = (b: ArrayBuffer): string => {
  return Array.from(new Uint8Array(b))
    .map((_) => `0x${_.toString(16)}`)
    .join(", ");
};
