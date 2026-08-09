import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Extension } from "../../typings/domain";

/** TLS 1.3 cookie extension type = 44 (RFC 8446) */
export const COOKIE_EXTENSION_TYPE = 44;

export class CookieExtension {
  static type = COOKIE_EXTENSION_TYPE;

  constructor(public cookie: Buffer) {}

  static fromData(data: Buffer): CookieExtension {
    if (data.length < 2) throw new Error("cookie extension: truncated");
    const len = data.readUInt16BE(0);
    // RFC 8446: opaque cookie<1..2^16-1> — non-empty, no trailing bytes
    if (len < 1) throw new Error("cookie extension: empty cookie not allowed");
    if (data.length !== 2 + len) {
      throw new Error(
        `cookie extension: length mismatch (declared ${len}, total ${data.length - 2})`,
      );
    }
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
 * Build binding material for a DTLS cookie:
 * peer identity (ip:port) || SHA-256(ClientHello body used at mint time).
 */
export function cookieBinding(
  peerKey: string,
  clientHelloBody: Buffer,
): Buffer {
  const peer = Buffer.from(peerKey, "utf8");
  const chHash = createHash("sha256").update(clientHelloBody).digest();
  return Buffer.concat([peer, Buffer.from([0]), chHash]);
}

/**
 * Stateless address-validation cookie bound to peer + ClientHello hash.
 * Layout: salt(16) || HMAC-SHA256(secret, salt || binding)[0..16)
 */
export function mintCookie(secret: Buffer, binding: Buffer): Buffer {
  const salt = randomBytes(16);
  const mac = createHmac("sha256", secret)
    .update(salt)
    .update(binding)
    .digest()
    .subarray(0, 16);
  return Buffer.concat([salt, mac]);
}

export function verifyCookie(
  secret: Buffer,
  cookie: Buffer,
  binding: Buffer,
): boolean {
  if (cookie.length !== 32) return false;
  const salt = cookie.subarray(0, 16);
  const mac = cookie.subarray(16, 32);
  const expected = createHmac("sha256", secret)
    .update(salt)
    .update(binding)
    .digest()
    .subarray(0, 16);
  try {
    return timingSafeEqual(mac, expected);
  } catch {
    return false;
  }
}

/** Format peer key from address tuple. */
export function peerKeyFromAddr(
  addr?: { address?: string; port?: number } | [string, number] | string,
): string {
  if (!addr) return "unknown";
  if (typeof addr === "string") return addr;
  if (Array.isArray(addr)) return `${addr[0]}:${addr[1]}`;
  if (addr.address != null && addr.port != null) {
    return `${addr.address}:${addr.port}`;
  }
  return "unknown";
}
