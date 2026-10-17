import { binaryData } from "../../imports/common";

const { decode, encode, types } = binaryData;

export class RenegotiationIndication {
  static type = 65281;
  static readonly spec = {
    type: types.uint16be,
    data: types.uint8,
  };

  public type: number = RenegotiationIndication.type;
  public data: number = 0;

  constructor(props: Partial<RenegotiationIndication> = {}) {
    Object.assign(this, props);
  }

  static createEmpty() {
    const v = new RenegotiationIndication();
    return v;
  }

  static deSerialize(buf: Buffer) {
    return new RenegotiationIndication(
      decode(buf, RenegotiationIndication.spec),
    );
  }

  serialize() {
    return encode(this, RenegotiationIndication.spec);
  }

  get extension() {
    return {
      type: this.type,
      data: this.serialize().slice(2),
    };
  }
}
