import { randomBytes } from "crypto";
/* eslint-disable @typescript-eslint/ban-ts-comment */
import { binaryData } from "../imports/common";

const { decode, encode, types } = binaryData;

export class DtlsRandom {
  public gmt_unix_time: number;
  public random_bytes: Buffer<ArrayBuffer>;

  static readonly spec = {
    gmt_unix_time: types.uint32be,
    random_bytes: types.buffer(28),
  };

  constructor(
    gmt_unix_time = Math.floor(Date.now() / 1000),
    random_bytes: Buffer<ArrayBufferLike> = randomBytes(28),
  ) {
    this.gmt_unix_time = gmt_unix_time;
    // Copy into an ArrayBuffer-backed Buffer so the public property stays non-shared.
    this.random_bytes = Buffer.from(random_bytes);
  }

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
