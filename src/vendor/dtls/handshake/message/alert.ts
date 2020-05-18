import { encode, types, decode } from "binary-data";

const AlertLevel = types.uint8;
const AlertDescription = types.uint8;

export class Alert {
  static readonly spec = {
    level: AlertLevel,
    description: AlertDescription,
  };

  constructor(public verifyData: Buffer) {}

  static createEmpty() {
    return new Alert(undefined as any);
  }

  static deSerialize(buf: Buffer) {
    return new Alert(
      //@ts-ignore
      ...Object.values(decode(buf, Alert.spec))
    );
  }

  serialize() {
    const res = encode(this, Alert.spec).slice();
    return Buffer.from(res);
  }
}
