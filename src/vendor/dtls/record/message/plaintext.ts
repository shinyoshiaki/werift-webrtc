import { encode, types, decode } from "binary-data";
import { MACHeader, DtlsPlaintextHeader } from "./header";

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
