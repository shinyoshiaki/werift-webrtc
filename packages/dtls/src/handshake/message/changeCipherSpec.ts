import { binaryData } from "../../imports/common";

const { decode, encode, types } = binaryData;

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
      ...Object.values(decode(buf, ChangeCipherSpec.spec)),
    );
  }

  serialize() {
    return encode(this, ChangeCipherSpec.spec);
  }
}
