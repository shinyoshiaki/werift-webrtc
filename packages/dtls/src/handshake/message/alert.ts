import { binaryData } from "../../imports/common";

const { decode, encode, types } = binaryData;

export class Alert {
  public level: number;
  public description: number;

  static readonly spec = {
    level: types.uint8,
    description: types.uint8,
  };

  constructor(level: number, description: number) {
    this.level = level;
    this.description = description;
  }

  static deSerialize(buf: Buffer) {
    return new Alert(
      //@ts-expect-error
      ...Object.values(decode(buf, Alert.spec)),
    );
  }

  serialize() {
    return encode(this, Alert.spec);
  }
}
