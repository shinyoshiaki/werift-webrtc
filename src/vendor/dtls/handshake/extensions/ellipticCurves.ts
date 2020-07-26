import { encode, types, decode } from "binary-data";
import { Extension } from "../../typings/domain";

export class EllipticCurves {
  static type = 10;
  static readonly spec = {
    type: types.uint16be,
    data: types.array(types.uint16be, types.uint16be, "bytes"),
  };

  public type: number = EllipticCurves.type;
  public data: number[] = [];

  constructor(props: Partial<EllipticCurves> = {}) {
    Object.assign(this, props);
  }

  static createEmpty() {
    return new EllipticCurves();
  }

  static fromData(buf: Buffer) {
    return new EllipticCurves({
      type: EllipticCurves.type,
      data: decode(buf, EllipticCurves.spec.data),
    });
  }

  static deSerialize(buf: Buffer) {
    return new EllipticCurves(decode(buf, EllipticCurves.spec));
  }

  serialize() {
    return Buffer.from(encode(this, EllipticCurves.spec).slice());
  }

  get extension(): Extension {
    return {
      type: this.type,
      data: this.serialize().slice(2),
    };
  }
}
