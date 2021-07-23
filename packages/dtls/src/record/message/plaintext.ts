/* eslint-disable @typescript-eslint/ban-ts-comment */
import { decode, encode, types } from "binary-data";

import { dumpBuffer } from "../../helper";
import { DtlsPlaintextHeader, MACHeader } from "./header";

export class DtlsPlaintext {
  static readonly spec = {
    recordLayerHeader: DtlsPlaintextHeader.spec,
    fragment: types.buffer(
      (context: any) => context.current.recordLayerHeader.contentLen
    ),
  };

  constructor(
    public recordLayerHeader: typeof DtlsPlaintext.spec.recordLayerHeader,
    public fragment: Buffer
  ) {}

  get summary() {
    return {
      header: this.recordLayerHeader,
      fragment: dumpBuffer(this.fragment),
    };
  }

  static createEmpty() {
    return new DtlsPlaintext(undefined as any, undefined as any);
  }

  static deSerialize(buf: Buffer) {
    const r = new DtlsPlaintext(
      //@ts-ignore
      ...Object.values(decode(buf, DtlsPlaintext.spec))
    );
    return r;
  }

  serialize() {
    const res = encode(this, DtlsPlaintext.spec).slice();
    return Buffer.from(res);
  }

  computeMACHeader() {
    return new MACHeader(
      this.recordLayerHeader.epoch,
      this.recordLayerHeader.sequenceNumber,
      this.recordLayerHeader.contentType,
      this.recordLayerHeader.protocolVersion,
      this.recordLayerHeader.contentLen
    ).serialize();
  }
}
