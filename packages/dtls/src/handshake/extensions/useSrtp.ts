import { decode, encode, types } from "@shinyoshiaki/binary-data";

import type { Extension } from "../../typings/domain";

/**
 * use_srtp extension (RFC 5764).
 *
 * Wire: ProtectionProfiles (uint16 length + profiles) + opaque srtp_mki<0..255>
 * `mki` holds the MKI *payload only* (length byte is added on serialize).
 */
export class UseSRTP {
  static type = 14; // 9.  IANA Considerations
  static readonly spec = {
    type: types.uint16be,
    data: types.buffer(types.uint16be),
  };

  type: number = UseSRTP.type;
  data: Buffer = Buffer.from([]);
  profiles: number[] = [];
  /** MKI payload only (not including the length byte). */
  mki: Buffer = Buffer.alloc(0);

  constructor(props: Partial<UseSRTP> = {}) {
    Object.assign(this, props);
  }

  static create(profiles: number[], mki: Buffer = Buffer.alloc(0)) {
    const v = new UseSRTP({
      profiles,
      mki: Buffer.from(mki),
    });
    return v;
  }

  static deSerialize(buf: Buffer) {
    const useSrtp = new UseSRTP(decode(buf, UseSRTP.spec));
    UseSRTP.parseProfilesAndMki(useSrtp);
    return useSrtp;
  }

  /**
   * Parse extension data (profiles + MKI) into profiles[] and mki payload.
   * Strict length checks (RFC 5764).
   */
  private static parseProfilesAndMki(useSrtp: UseSRTP): void {
    const data = useSrtp.data;
    if (data.length < 2) {
      throw new Error("use_srtp: truncated profiles length");
    }
    const profileLength = data.readUInt16BE(0);
    if (profileLength % 2 !== 0) {
      throw new Error("use_srtp: profiles length must be even");
    }
    if (data.length < 2 + profileLength + 1) {
      throw new Error("use_srtp: truncated after profiles");
    }
    const profiles: number[] = [];
    for (let i = 0; i < profileLength; i += 2) {
      profiles.push(data.readUInt16BE(2 + i));
    }
    const mkiOffset = 2 + profileLength;
    const mkiLen = data.readUInt8(mkiOffset);
    if (data.length !== mkiOffset + 1 + mkiLen) {
      throw new Error(
        `use_srtp: MKI length mismatch (declared ${mkiLen}, remaining ${data.length - mkiOffset - 1})`,
      );
    }
    useSrtp.profiles = profiles;
    useSrtp.mki = Buffer.from(
      data.subarray(mkiOffset + 1, mkiOffset + 1 + mkiLen),
    );
  }

  serialize() {
    if (this.mki.length > 255) {
      throw new Error("use_srtp: MKI longer than 255 bytes");
    }
    const profileLength = Buffer.alloc(2);
    profileLength.writeUInt16BE(this.profiles.length * 2);
    const mkiLen = Buffer.alloc(1);
    mkiLen.writeUInt8(this.mki.length, 0);
    const data = Buffer.concat([
      profileLength,
      ...this.profiles.map((profile) => {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(profile);
        return buf;
      }),
      mkiLen,
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
