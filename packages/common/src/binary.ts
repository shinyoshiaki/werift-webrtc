import { randomBytes } from "crypto";
import { jspack } from "@shinyoshiaki/jspack";

export function random16() {
  return jspack.Unpack("!H", randomBytes(2))[0];
}

export function random32() {
  return jspack.Unpack("!L", randomBytes(4))[0];
}

export function bufferXor(a: Buffer, b: Buffer): Buffer {
  if (a.length !== b.length) {
    throw new TypeError(
      "[webrtc-stun] You can not XOR buffers which length are different",
    );
  }

  const length = a.length;
  const buffer = Buffer.allocUnsafe(length);

  for (let i = 0; i < length; i++) {
    buffer[i] = a[i] ^ b[i];
  }

  return buffer;
}

export function bufferArrayXor(arr: Buffer[]): Buffer {
  const length = [...arr]
    .sort((a, b) => a.length - b.length)
    .reverse()[0].length;
  const xored = Buffer.allocUnsafe(length);

  for (let i = 0; i < length; i++) {
    xored[i] = 0;
    arr.forEach((buffer) => {
      xored[i] ^= buffer[i] ?? 0;
    });
  }

  return xored;
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
    private bitLength: number,
  ) {
    if (bitLength > 32) {
      throw new Error();
    }
  }

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
    "",
  );
}

export function bufferWriter(bytes: number[], values: (number | bigint)[]) {
  return createBufferWriter(bytes)(values);
}

export function createBufferWriter(bytes: number[], singleBuffer?: boolean) {
  const length = bytes.reduce((acc, cur) => acc + cur, 0);
  const reuseBuffer = singleBuffer ? Buffer.alloc(length) : undefined;

  return (values: (number | bigint)[]) => {
    const buf = reuseBuffer || Buffer.alloc(length);
    let offset = 0;

    values.forEach((v, i) => {
      const size = bytes[i];
      if (size === 8) buf.writeBigUInt64BE(v as bigint, offset);
      else buf.writeUIntBE(v as number, offset, size);
      offset += size;
    });
    return buf;
  };
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
  buffer: Buffer;

  constructor(size: number) {
    this.buffer = Buffer.alloc(size);
  }

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

export class BitStream {
  private position = 0;
  private bitsPending = 0;

  constructor(public uint8Array: Buffer) {}

  writeBits(bits: number, value: number): BitStream {
    if (bits == 0) {
      return this;
    }
    value &= 0xffffffff >>> (32 - bits);
    let bitsConsumed;
    if (this.bitsPending > 0) {
      if (this.bitsPending > bits) {
        this.uint8Array[this.position - 1] |=
          value << (this.bitsPending - bits);
        bitsConsumed = bits;
        this.bitsPending -= bits;
      } else if (this.bitsPending == bits) {
        this.uint8Array[this.position - 1] |= value;
        bitsConsumed = bits;
        this.bitsPending = 0;
      } else {
        this.uint8Array[this.position - 1] |=
          value >> (bits - this.bitsPending);
        // ???
        bitsConsumed = this.bitsPending;
        this.bitsPending = 0;
      }
    } else {
      bitsConsumed = Math.min(8, bits);
      this.bitsPending = 8 - bitsConsumed;
      this.uint8Array[this.position++] =
        (value >> (bits - bitsConsumed)) << this.bitsPending;
    }
    bits -= bitsConsumed;
    if (bits > 0) {
      this.writeBits(bits, value);
    }

    return this;
  }

  readBits(bits: number, bitBuffer?: number): any {
    if (typeof bitBuffer == "undefined") {
      bitBuffer = 0;
    }
    if (bits == 0) {
      return bitBuffer;
    }
    let partial: number;
    let bitsConsumed: number;
    if (this.bitsPending > 0) {
      const byte =
        this.uint8Array[this.position - 1] & (0xff >> (8 - this.bitsPending));
      bitsConsumed = Math.min(this.bitsPending, bits);
      this.bitsPending -= bitsConsumed;
      partial = byte >> this.bitsPending;
    } else {
      bitsConsumed = Math.min(8, bits);
      this.bitsPending = 8 - bitsConsumed;
      partial = this.uint8Array[this.position++] >> this.bitsPending;
    }
    bits -= bitsConsumed;
    bitBuffer = (bitBuffer << bitsConsumed) | partial;
    return bits > 0 ? this.readBits(bits, bitBuffer) : bitBuffer;
  }

  seekTo(bitPos: number) {
    this.position = (bitPos / 8) | 0;
    this.bitsPending = bitPos % 8;
    if (this.bitsPending > 0) {
      this.bitsPending = 8 - this.bitsPending;
      this.position++;
    }
  }
}
