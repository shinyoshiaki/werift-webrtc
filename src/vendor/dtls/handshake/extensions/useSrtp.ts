import { encode, types, decode } from "binary-data";
import { Extension } from "../../typings/domain";

export class UseSRTP {
  static type = 14; // 9.  IANA Considerations
  static readonly spec = {
    type: types.uint16be,
    mkiLength: types.uint16be,
    profileLength: types.uint16be,
    profiles: types.array(
      types.uint16be,
      (ctx: any) => ctx.current.profileLength / 2
    ),
    mki: types.buffer(
      (ctx: any) => ctx.current.mkiLength - ctx.current.profileLength - 2
    ),
  };
  type: number = UseSRTP.type;
  mkiLength: number = 0;
  profileLength: number = 0;
  profiles: number[] = [];
  mki: Buffer = Buffer.from([]);

  constructor(props: Partial<UseSRTP> = {}) {
    Object.assign(this, props);
  }

  static create(profiles: number[], mki: Buffer) {
    const profileLength = profiles.length * 2;
    const v = new UseSRTP({
      profiles,
      profileLength,
      mki,
      mkiLength: mki.length + profileLength + 2,
    });
    return v;
  }

  static deSerialize(buf: Buffer) {
    return new UseSRTP(decode(buf, UseSRTP.spec));
  }

  serialize() {
    const res = encode(this, UseSRTP.spec).slice();
    return Buffer.from(res);
  }

  static fromData(buf: Buffer) {
    const type = Buffer.alloc(2);
    type.writeUInt16BE(UseSRTP.type);
    return UseSRTP.deSerialize(Buffer.concat([type, buf]));
  }

  get extension(): Extension {
    return {
      type: this.type,
      data: this.serialize().slice(2),
    };
  }
}
