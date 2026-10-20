import { binaryData } from "../../imports/common";

const { decode, encode, types } = binaryData;

export class Alert {
  static readonly spec = {
    level: types.uint8,
    description: types.uint8,
  };

  constructor(
    public level: number,
    public description: number,
  ) {}

  static deSerialize(buf: Buffer) {
    return new Alert(
      //@ts-ignore
      ...Object.values(decode(buf, Alert.spec)),
    );
  }

  serialize() {
    return encode(this, Alert.spec);
  }
}
