import { decode, encode, types } from "binary-data";

export class Alert {
  static readonly spec = {
    level: types.uint8,
    description: types.uint8,
  };

  constructor(public level: number, public description: number) {}

  static deSerialize(buf: Buffer) {
    return new Alert(
      //@ts-ignore
      ...Object.values(decode(buf, Alert.spec)),
    );
  }

  serialize() {
    const res = encode(this, Alert.spec).slice();
    return Buffer.from(res);
  }
}
