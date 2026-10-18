import { binaryData } from "../../imports/common";

import { ProtocolVersion } from "../../handshake/binary";

const { decode, encode, types } = binaryData;

export interface DtlsPlaintextHeader {
  contentType: number;
  protocolVersion: {
    major: number;
    minor: number;
  };
  epoch: number;
  sequenceNumber: number;
  contentLen: number;
}

export class MACHeader {
  static readonly spec = {
    epoch: types.uint16be,
    sequenceNumber: types.uint48be,
    contentType: types.uint8,
    protocolVersion: ProtocolVersion,
    contentLen: types.uint16be,
  };

  constructor(
    public epoch: number,
    public sequenceNumber: number,
    public contentType: number,
    public protocolVersion: { major: number; minor: number },
    public contentLen: number,
  ) {}

  static createEmpty() {
    return new MACHeader(
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    );
  }

  static deSerialize(buf: Buffer) {
    return new MACHeader(
      //@ts-ignore
      ...Object.values(decode(buf, MACHeader.spec)),
    );
  }

  serialize() {
    return encode(this, MACHeader.spec);
  }
}
