import * as Int64 from "int64-buffer";
import nodeIp from "ip";
import range from "lodash/range.js";

import type { Address } from "../imports/common";
import {
  type AttributeKeys,
  COOKIE,
  IPV4_PROTOCOL,
  IPV6_PROTOCOL,
} from "./const";

function packAddress(value: Address) {
  const [address] = value;

  const protocol = nodeIp.isV4Format(address) ? IPV4_PROTOCOL : IPV6_PROTOCOL;

  const buffer = Buffer.alloc(4);
  buffer.writeUInt8(0, 0);
  buffer.writeUInt8(protocol, 1);
  buffer.writeUInt16BE(value[1], 2);

  return Buffer.concat([buffer, nodeIp.toBuffer(address)]);
}

export function unpackErrorCode(data: Buffer): [number, string] {
  if (data.length < 4) throw new Error("STUN error code is less than 4 bytes");
  const codeHigh = data.readUInt8(2);
  const codeLow = data.readUInt8(3);
  const reason = data.slice(4).toString("utf8");
  return [codeHigh * 100 + codeLow, reason];
}

function unpackAddress(data: Buffer): Address {
  if (data.length < 4)
    throw new Error("STUN address length is less than 4 bytes");
  const protocol = data.readUInt8(1);
  const port = data.readUInt16BE(2);
  const address = data.slice(4);
  switch (protocol) {
    case IPV4_PROTOCOL:
      if (address.length != 4)
        throw new Error(`STUN address has invalid length for IPv4`);
      return [nodeIp.toString(address), port];
    case IPV6_PROTOCOL:
      if (address.length != 16)
        throw new Error("STUN address has invalid length for IPv6");
      return [nodeIp.toString(address), port];
    default:
      throw new Error("STUN address has unknown protocol");
  }
}

function xorAddress(data: Buffer, transactionId: Buffer) {
  const xPad = Buffer.alloc(16);
  xPad.writeUInt16BE(COOKIE >> 16, 0);
  xPad.writeUInt32BE(COOKIE, 2);
  transactionId.copy(xPad, 6);
  let xData = data.slice(0, 2);

  for (const i of range(2, data.length)) {
    const num = data[i] ^ xPad[i - 2];
    const buf = Buffer.alloc(1);
    buf.writeUInt8(num, 0);
    xData = Buffer.concat([xData, buf]);
  }
  return xData;
}

export function unpackXorAddress(data: Buffer, transactionId: Buffer): Address {
  return unpackAddress(xorAddress(data, transactionId));
}

export function packErrorCode(value: [number, string]) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt16BE(0, 0);
  buffer.writeUInt8(Math.floor(value[0] / 100), 2);
  buffer.writeUInt8(value[0] % 100, 3);
  const encode = Buffer.from(value[1], "utf8");
  return Buffer.concat([buffer, encode]);
}

export function packXorAddress(value: Address, transactionId: Buffer) {
  return xorAddress(packAddress(value), transactionId);
}

const packUnsigned = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
};

const unpackUnsigned = (data: Buffer) => data.readUInt32BE(0);

const packUnsignedShort = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt16BE(value, 0);
  return buffer;
};

const unpackUnsignedShort = (data: Buffer) => data.readUInt16BE(0);

const packUnsigned64 = (value: bigint) => {
  return new Int64.Int64BE(value.toString()).toBuffer();
};
const unpackUnsigned64 = (data: Buffer) => {
  const int = new Int64.Int64BE(data);
  return BigInt(int.toString());
};

const packString = (value: string) => Buffer.from(value, "utf8");
const unpackString = (data: Buffer) => data.toString("utf8");

const packBytes = (value: Buffer) => value;
const unpackBytes = (data: Buffer) => data;

const packNone = (value: Buffer) => Buffer.from([]);
const unpackNone = (data: Buffer) => null;

export type ATTRIBUTE = [
  number,
  AttributeKey,
  (...args: any) => Buffer,
  (...args: any) => any,
];

const ATTRIBUTES: ATTRIBUTE[] = [
  [0x0001, "MAPPED-ADDRESS", packAddress, unpackAddress],
  [0x0003, "CHANGE-REQUEST", packUnsigned, unpackUnsigned],
  [0x0004, "SOURCE-ADDRESS", packAddress, unpackAddress],
  [0x0005, "CHANGED-ADDRESS", packAddress, unpackAddress],
  [0x0006, "USERNAME", packString, unpackString],
  [0x0008, "MESSAGE-INTEGRITY", packBytes, unpackBytes],
  [0x0009, "ERROR-CODE", packErrorCode, unpackErrorCode],
  [0x000c, "CHANNEL-NUMBER", packUnsignedShort, unpackUnsignedShort],
  [0x000d, "LIFETIME", packUnsigned, unpackUnsigned],
  [0x0012, "XOR-PEER-ADDRESS", packXorAddress, unpackXorAddress],
  [0x0013, "DATA", packBytes, unpackBytes],
  [0x0014, "REALM", packString, unpackString],
  [0x0015, "NONCE", packBytes, unpackBytes],
  [0x0016, "XOR-RELAYED-ADDRESS", packXorAddress, unpackXorAddress],
  [0x0019, "REQUESTED-TRANSPORT", packUnsigned, unpackUnsigned],
  [0x0020, "XOR-MAPPED-ADDRESS", packXorAddress, unpackXorAddress],
  [0x0024, "PRIORITY", packUnsigned, unpackUnsigned],
  [0x0025, "USE-CANDIDATE", packNone, unpackNone],
  [0x8022, "SOFTWARE", packString, unpackString],
  [0x8028, "FINGERPRINT", packUnsigned, unpackUnsigned],
  [0x8029, "ICE-CONTROLLED", packUnsigned64, unpackUnsigned64],
  [0x802a, "ICE-CONTROLLING", packUnsigned64, unpackUnsigned64],
  [0x802b, "RESPONSE-ORIGIN", packAddress, unpackAddress],
  [0x802c, "OTHER-ADDRESS", packAddress, unpackAddress],
];

export class AttributeRepository {
  constructor(protected attributes: AttributePair[] = []) {}

  getAttributes() {
    return this.attributes;
  }

  setAttribute(key: (typeof AttributeKeys)[number], value: any) {
    const exist = this.attributes.find((a) => a[0] === key);
    if (exist) {
      exist[1] = value;
    } else {
      this.attributes.push([key, value]);
    }
    return this;
  }

  getAttributeValue(key: AttributeKey) {
    const attribute = this.attributes.find((a) => a[0] === key);
    if (!attribute) {
      return undefined;
    }
    return attribute[1];
  }

  get attributesKeys(): (typeof AttributeKeys)[number][] {
    return this.attributes.map((a) => a[0]);
  }

  clear() {
    this.attributes = [];
  }
}

export type AttributeKey = (typeof AttributeKeys)[number];

export type AttributePair = [AttributeKey, any];

export const ATTRIBUTES_BY_TYPE = ATTRIBUTES.reduce(
  (acc, cur) => {
    acc[cur[0]] = cur;
    return acc;
  },
  {} as { [key: string]: ATTRIBUTE },
);

export const ATTRIBUTES_BY_NAME = ATTRIBUTES.reduce(
  (acc, cur) => {
    acc[cur[1]] = cur;
    return acc;
  },
  {} as { [key: string]: ATTRIBUTE },
);
