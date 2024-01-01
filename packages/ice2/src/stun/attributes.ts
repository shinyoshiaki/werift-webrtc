import { bufferReader, bufferWriter, bufferXor } from "../../../common/src";
import { StunMessageHeader } from "./message";

export const Attributes = {
  messageIntegrity: 0x0008,
  priority: 0x0024,
  useCandidate: 0x0025,
  iceControlled: 0x8029,
  iceControlling: 0x802a,
} as const;

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

export class XorMappedAddress {
  family!: Family;
  xPort!: number;
  xAddress!: number;

  constructor(props: Partial<XorMappedAddress>) {
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

  static Deserialize(buf: Buffer) {
    const [, family, xPort] = bufferReader(buf, [1, 1, 2]);
    const xAddress =
      family === 1
        ? buf.subarray(4).readUint32BE()
        : buf.subarray(4).readUintBE(0, 16);
    return new XorMappedAddress({ family, xPort, xAddress });
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
