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

  public type: number = Signature.type;
  public data: { hash: number; signature: number }[] = [];

  constructor(props: Partial<Signature> = {}) {
    Object.assign(this, props);
  }

  static createEmpty() {
    const v = new Signature();
    return v;
  }

  static deSerialize(buf: Buffer) {
    return new Signature(decode(buf, Signature.spec));
  }

  serialize() {
    const res = encode(this, Signature.spec).slice();
    return Buffer.from(res);
  }

  static fromData(buf: Buffer) {
    const type = Buffer.alloc(2);
    type.writeUInt16BE(Signature.type);
    return Signature.deSerialize(Buffer.concat([type, buf]));
  }

  get extension() {
    return {
      type: this.type,
      data: this.serialize().slice(2),
    };
  }
}
