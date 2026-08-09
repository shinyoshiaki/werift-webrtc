import { randomBytes } from "crypto";
/* eslint-disable @typescript-eslint/ban-ts-comment */
import { decode, encode, types } from "@shinyoshiaki/binary-data";

import { DOWNGRADE_TLS12_SENTINEL } from "../version";

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
      //@ts-ignore
      ...Object.values(decode(buf, DtlsRandom.spec)),
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

  /** Full 32-byte Random (gmt_unix_time || random_bytes). */
  toBuffer32(): Buffer {
    const b = Buffer.alloc(32);
    b.writeUInt32BE(this.gmt_unix_time >>> 0, 0);
    this.random_bytes.copy(b, 4);
    return b;
  }

  /**
   * RFC 8446 §4.1.3 / RFC 9147: TLS 1.3-capable server negotiating TLS 1.2
   * MUST set the last 8 bytes of ServerHello.Random to DOWNGRD\\x01.
   * Mutates `random_bytes` in place (must run before ServerHello is sent and
   * before the same Random is used in the PRF).
   */
  applyTls12DowngradeSentinel(): void {
    if (this.random_bytes.length < 8) {
      throw new Error("DtlsRandom.random_bytes too short for downgrade sentinel");
    }
    DOWNGRADE_TLS12_SENTINEL.copy(
      this.random_bytes,
      this.random_bytes.length - 8,
    );
  }
}
