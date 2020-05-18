import { randomBytes } from "crypto";
import { encode, types, decode } from "binary-data";

export class DtlsRandom {
  static readonly spec = {
    gmt_unix_time: types.uint32be,
    random_bytes: types.buffer(28),
  };

  constructor(
    public gmt_unix_time = Math.floor(Date.now() / 1000),
    public random_bytes = randomBytes(28)
  ) {}

  static deSerialize(buf: Buffer) {
    return new DtlsRandom(
      //@ts-ignore
      ...Object.values(decode(buf, DtlsRandom.spec))
    );
  }

  static from(spec: typeof DtlsRandom.spec) {
    //@ts-ignore
    return new DtlsRandom(...Object.values(spec));
  }

  serialize() {
    const res = encode(this, DtlsRandom.spec).slice();
    return Buffer.from(res);
  }
}
