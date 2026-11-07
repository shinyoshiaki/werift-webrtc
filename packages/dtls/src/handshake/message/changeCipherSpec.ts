import { binaryData } from "../../imports/common";

const { decode, encode, types } = binaryData;

// 7.1.  Change Cipher Spec Protocol

export class ChangeCipherSpec {
  public type: number;

  static readonly spec = {
    type: types.uint8,
  };

  constructor(type = 1) {
    this.type = type;
  }

  static createEmpty() {
    return new ChangeCipherSpec();
  }

  static deSerialize(buf: Buffer) {
    const { type } = decode(buf, ChangeCipherSpec.spec);
    return new ChangeCipherSpec(type);
  }

  serialize() {
    return encode(this, ChangeCipherSpec.spec);
  }
}
