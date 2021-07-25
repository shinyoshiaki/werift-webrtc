import { randomBytes } from "crypto";
import { jspack } from "jspack";

export function random16() {
  return jspack.Unpack("!H", randomBytes(2))[0];
}

export function random32() {
  return BigInt(jspack.Unpack("!L", randomBytes(4))[0]);
}

export class BitWriter {
  value = 0;

  constructor(private bitLength: number) {}

  set(size: number, startIndex: number, value: number) {
    value &= (1 << size) - 1;
    this.value |= value << (this.bitLength - size - startIndex);

    return this;
  }
}

export function getBit(bits: number, startIndex: number, length: number = 1) {
  let bin = bits.toString(2).split("");
  bin = [...Array(8 - bin.length).fill("0"), ...bin];
  const s = bin.slice(startIndex, startIndex + length).join("");
  const v = parseInt(s, 2);
  return v;
}

export function paddingByte(bits: number) {
  const dec = bits.toString(2).split("");
  return [...[...Array(8 - dec.length)].map(() => "0"), ...dec].join("");
}

export function bufferWriter(bytes: number[], values: (number | bigint)[]) {
  const length = bytes.reduce((acc, cur) => acc + cur, 0);
  const buf = Buffer.alloc(length);
  let offset = 0;

  values.forEach((v, i) => {
    const size = bytes[i];
    if (size === 8) buf.writeBigUInt64BE(v as bigint, offset);
    else buf.writeUIntBE(v as number, offset, size);

    offset += size;
  });
  return buf;
}

export function bufferReader(buf: Buffer, bytes: number[]) {
  let offset = 0;
  return bytes.map((v) => {
    let read: number | bigint;
    if (v === 8) {
      read = buf.readBigUInt64BE(offset);
    } else {
      read = buf.readUIntBE(offset, v);
    }

    offset += v;

    return read as any;
  });
}
