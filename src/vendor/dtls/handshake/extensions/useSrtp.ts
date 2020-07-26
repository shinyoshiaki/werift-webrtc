import { encode, types, decode } from "binary-data";
import { Extension } from "../../typings/domain";
import { times } from "lodash";

export class UseSRTP {
  static type = 14; // 9.  IANA Considerations
  static readonly spec = {
    type: types.uint16be,
    data: types.buffer(types.uint16be),
  };

  type: number = UseSRTP.type;
  data: Buffer = Buffer.from([]);
  profiles: number[] = [];
  mki?: Buffer;

  constructor(props: Partial<UseSRTP> = {}) {
    Object.assign(this, props);
  }

  static create(profiles: number[], mki: Buffer) {
    const v = new UseSRTP({
      profiles,
      mki,
    });
    return v;
  }

  static deSerialize(buf: Buffer) {
    const useSrtp = new UseSRTP(decode(buf, UseSRTP.spec));
    const profileLength = useSrtp.data.readUInt16BE();
    const profiles = times(profileLength / 2).map((i) => {
      return useSrtp.data.readUInt16BE(i * 2 + 2);
    });
    useSrtp.profiles = profiles;
    useSrtp.mki = useSrtp.data.slice(profileLength + 2);
    return useSrtp;
  }

  serialize() {
    const profileLength = Buffer.alloc(2);
    profileLength.writeUInt16BE(this.profiles.length * 2);
    const data = Buffer.concat([
      profileLength,
      ...this.profiles.map((profile) => {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(profile);
        return buf;
      }),
      Buffer.from([0x00]),
    ]);
    this.data = data;
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
