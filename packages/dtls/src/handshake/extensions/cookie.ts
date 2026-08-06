import { createHmac, randomBytes } from "crypto";
import type { Extension } from "../../typings/domain";

/** TLS 1.3 cookie extension type = 44 (RFC 8446) */
export const COOKIE_EXTENSION_TYPE = 44;

export class CookieExtension {
  static type = COOKIE_EXTENSION_TYPE;

  constructor(public cookie: Buffer) {}

  static fromData(data: Buffer): CookieExtension {
    if (data.length < 2) throw new Error("cookie extension: truncated");
    const len = data.readUInt16BE(0);
    if (data.length < 2 + len) throw new Error("cookie extension: length");
    return new CookieExtension(Buffer.from(data.subarray(2, 2 + len)));
  }

  serializeData(): Buffer {
    const out = Buffer.alloc(2 + this.cookie.length);
    out.writeUInt16BE(this.cookie.length, 0);
    this.cookie.copy(out, 2);
    return out;
  }

  get extension(): Extension {
    return { type: CookieExtension.type, data: this.serializeData() };
  }
}

/**
 * Stateless address-validation cookie (HMAC over secret + salt).
 * Not bound to IP for unit tests; production can include peer address bytes.
 */
export function mintCookie(secret: Buffer, salt?: Buffer): Buffer {
  const s = salt ?? randomBytes(16);
  const mac = createHmac("sha256", secret).update(s).digest().subarray(0, 16);
  return Buffer.concat([s, mac]);
}

export function verifyCookie(secret: Buffer, cookie: Buffer): boolean {
  if (cookie.length < 32) return false;
  const salt = cookie.subarray(0, 16);
  const mac = cookie.subarray(16, 32);
  const expected = createHmac("sha256", secret)
    .update(salt)
    .digest()
    .subarray(0, 16);
  return mac.equals(expected);
}
