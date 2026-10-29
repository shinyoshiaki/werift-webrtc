import { randomBytes } from "crypto";
/* eslint-disable @typescript-eslint/ban-ts-comment */
import { binaryData } from "../imports/common";

const { decode, encode, types } = binaryData;

export class DtlsRandom {
  static readonly spec = {
    gmt_unix_time: types.uint32be,
    random_bytes: types.buffer(28),
  };

  constructor(
    public gmt_unix_time = Math.floor(Date.now() / 1000),
    public random_bytes = randomBytes(28),
  ) {}

  static deSerialize(buf: Buffer) {
    return new DtlsRandom(
      //@ts-expect-error
      ...Object.values(decode(buf, DtlsRandom.spec)),
    );
  }

  static from(spec: binaryData.Decoded<typeof DtlsRandom.spec>) {
    //@ts-expect-error
    return new DtlsRandom(...Object.values(spec));
  }

  serialize() {
    return encode(this, DtlsRandom.spec);
  }
}
