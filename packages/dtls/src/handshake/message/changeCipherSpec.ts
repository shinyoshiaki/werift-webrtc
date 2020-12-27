import { encode, types, decode } from "binary-data";

// 7.1.  Change Cipher Spec Protocol

export class ChangeCipherSpec {
  static readonly spec = {
    type: types.uint8,
  };

  constructor(public type = 1) {}

  static createEmpty() {
    return new ChangeCipherSpec();
  }

  static deSerialize(buf: Buffer) {
    return new ChangeCipherSpec(
      //@ts-ignore
      ...Object.values(decode(buf, ChangeCipherSpec.spec))
    );
  }

  serialize() {
    const res = encode(this, ChangeCipherSpec.spec).slice();
    return Buffer.from(res);
  }
}
