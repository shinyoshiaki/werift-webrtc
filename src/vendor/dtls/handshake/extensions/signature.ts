import { encode, types, decode } from "binary-data";

export class Signature {
  static type = 13;
  static readonly spec = {
    type: types.uint16be,
    data: types.array(
      { hash: types.uint8, signature: types.uint8 },
      types.uint16be,
      "bytes"
    ),
  };

  constructor(
    public type: number,
    public data: { hash: number; signature: number }[]
  ) {
    this.type = Signature.type;
  }

  static createEmpty() {
    const v = new Signature(undefined as any, undefined as any);
    return v;
  }

  static deSerialize(buf: Buffer) {
    return new Signature(
      //@ts-ignore
      ...Object.values(decode(buf, Signature.spec))
    );
  }

  serialize() {
    const res = encode(this, Signature.spec).slice();
    return Buffer.from(res);
  }

  static fromData(buf: Buffer) {
    return new Signature(Signature.type, decode(buf, Signature.spec.data));
  }

  get extension() {
    return {
      type: this.type,
      data: Buffer.from(encode(this.data, Signature.spec.data).slice()),
    };
  }
}
