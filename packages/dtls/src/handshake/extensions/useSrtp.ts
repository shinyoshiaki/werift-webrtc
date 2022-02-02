import { decode, encode, types } from "binary-data";
import times from "lodash/times";

import { Extension } from "../../typings/domain";

export class UseSRTP {
  static type = 14; // 9.  IANA Considerations
  static readonly spec = {
    type: types.uint16be,
    data: types.buffer(types.uint16be),
  };

  type: number = UseSRTP.type;
  data: Buffer = Buffer.from([]);
  profiles: number[] = [];
  mki: Buffer = Buffer.from([0x00]);

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
      this.mki,
    ]);
    this.data = data;
    const res = encode(this, UseSRTP.spec).slice();
    return Buffer.from(res);
  }

  static fromData(buf: Buffer) {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(UseSRTP.type);
    head.writeUInt16BE(buf.length, 2);
    return UseSRTP.deSerialize(Buffer.concat([head, buf]));
  }

  get extension(): Extension {
    return {
      type: this.type,
      data: this.serialize().slice(4),
    };
  }
}
