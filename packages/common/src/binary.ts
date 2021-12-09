import { randomBytes } from "crypto";
import { jspack } from "jspack";

export function random16() {
  return jspack.Unpack("!H", randomBytes(2))[0];
}

export function random32() {
  return jspack.Unpack("!L", randomBytes(4))[0];
}

export class BitWriter {
  value = 0;

  constructor(private bitLength: number) {}

  set(size: number, startIndex: number, value: number) {
    value &= (1 << size) - 1;
    this.value |= value << (this.bitLength - size - startIndex);

    return this;
  }

  get buffer() {
    const length = Math.ceil(this.bitLength / 8);
    const buf = Buffer.alloc(length);
    buf.writeUIntBE(this.value, 0, length);
    return buf;
  }
}

export class BitWriter2 {
  private _value = 0n;
  offset = 0n;

  /**
   * 各valueがオクテットを跨いではならない
   */
  constructor(
    /**Max 32bit */
    private bitLength: number
  ) {}

  set(value: number, size: number = 1) {
    let value_b = BigInt(value);
    const size_b = BigInt(size);

    value_b &= (1n << size_b) - 1n;
    this._value |= value_b << (BigInt(this.bitLength) - size_b - this.offset);
    this.offset += size_b;
    return this;
  }

  get value() {
    return Number(this._value);
  }

  get buffer() {
    const length = Math.ceil(this.bitLength / 8);
    const buf = Buffer.alloc(length);
    buf.writeUIntBE(this.value, 0, length);
    return buf;
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

export function paddingBits(bits: number, expectLength: number) {
  const dec = bits.toString(2);
  return [...[...Array(expectLength - dec.length)].map(() => "0"), ...dec].join(
    ""
  );
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

export function bufferWriterLE(bytes: number[], values: (number | bigint)[]) {
  const length = bytes.reduce((acc, cur) => acc + cur, 0);
  const buf = Buffer.alloc(length);
  let offset = 0;

  values.forEach((v, i) => {
    const size = bytes[i];
    if (size === 8) buf.writeBigUInt64LE(v as bigint, offset);
    else buf.writeUIntLE(v as number, offset, size);

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

export class BufferChain {
  buffer = Buffer.alloc(this.size);

  constructor(private size: number) {}

  writeInt16BE(value: number, offset?: number | undefined) {
    this.buffer.writeInt16BE(value, offset);
    return this;
  }

  writeUInt8(value: number, offset?: number | undefined) {
    this.buffer.writeUInt8(value, offset);
    return this;
  }
}

export const dumpBuffer = (data: Buffer) =>
  "0x" +
  data
    .toString("hex")
    .replace(/(.)(.)/g, "$1$2 ")
    .split(" ")
    .filter((s) => s != undefined && s.length > 0)
    .join(",0x");

export function buffer2ArrayBuffer(buf: Buffer) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
