import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Extension } from "../../typings/domain";
import { HandshakeType } from "../const";

/** TLS 1.3 cookie extension type = 44 (RFC 8446) */
export const COOKIE_EXTENSION_TYPE = 44;

/** Cookie format version for address-validation cookies (stateless). */
export const ADDRESS_COOKIE_VERSION = 0x01;

/**
 * Stateless cookie layout (RFC 9147-style content binding):
 *   version(1) || salt(16) || ch1MessageHash(32) || flags(1) || group(2) || mac(16)
 * mac = HMAC-SHA256(secret, version||salt||ch1MessageHash||flags||group||peerKey)[0:16]
 *
 * ch1MessageHash = SHA-256(msg_type||len||ClientHello body) — the transcript
 * message_hash input so HRR completion does not need server-side CH1 storage.
 */
export const ADDRESS_COOKIE_LENGTH = 1 + 16 + 32 + 1 + 2 + 16; // 68

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
 * Transcript message_hash material for a ClientHello body
 * (msg_type || uint24 length || body).
 */
export function clientHelloMessageHash(clientHelloBody: Buffer): Buffer {
  const chFull = Buffer.alloc(4 + clientHelloBody.length);
  chFull.writeUInt8(HandshakeType.client_hello_1, 0);
  chFull.writeUIntBE(clientHelloBody.length, 1, 3);
  clientHelloBody.copy(chFull, 4);
  return createHash("sha256").update(chFull).digest();
}

/**
 * Build binding material for a DTLS cookie (legacy helper / tests):
 * peer identity (ip:port) || 0x00 || SHA-256(ClientHello body).
 * Prefer {@link mintAddressCookie} for wire cookies.
 */
export function cookieBinding(
  peerKey: string,
  clientHelloBody: Buffer,
): Buffer {
  const peer = Buffer.from(peerKey, "utf8");
  const chHash = createHash("sha256").update(clientHelloBody).digest();
  return Buffer.concat([peer, Buffer.from([0]), chHash]);
}

export type AddressCookiePayload = {
  ch1MessageHash: Buffer;
  /** HRR selected_group if present in the cookie-bearing HRR */
  selectedGroup?: number;
};

function macAddressCookie(
  secret: Buffer,
  version: number,
  salt: Buffer,
  ch1MessageHash: Buffer,
  flags: number,
  group: number,
  peerKey: string,
): Buffer {
  return createHmac("sha256", secret)
    .update(Buffer.from([version]))
    .update(salt)
    .update(ch1MessageHash)
    .update(Buffer.from([flags & 0xff]))
    .update((() => {
      const g = Buffer.alloc(2);
      g.writeUInt16BE(group & 0xffff, 0);
      return g;
    })())
    .update(Buffer.from(peerKey, "utf8"))
    .digest()
    .subarray(0, 16);
}

/**
 * Mint a stateless address-validation cookie embedding CH1 message_hash
 * and optional HRR selected_group (does not require server-side CH1 storage).
 */
export function mintAddressCookie(
  secret: Buffer,
  peerKey: string,
  clientHelloBody: Buffer,
  opts?: { selectedGroup?: number },
): Buffer {
  const salt = randomBytes(16);
  const ch1MessageHash = clientHelloMessageHash(clientHelloBody);
  const hasGroup = opts?.selectedGroup !== undefined;
  const flags = hasGroup ? 0x01 : 0x00;
  const group = hasGroup ? (opts!.selectedGroup as number) & 0xffff : 0;
  const mac = macAddressCookie(
    secret,
    ADDRESS_COOKIE_VERSION,
    salt,
    ch1MessageHash,
    flags,
    group,
    peerKey,
  );
  const out = Buffer.alloc(ADDRESS_COOKIE_LENGTH);
  let o = 0;
  out[o++] = ADDRESS_COOKIE_VERSION;
  salt.copy(out, o);
  o += 16;
  ch1MessageHash.copy(out, o);
  o += 32;
  out[o++] = flags;
  out.writeUInt16BE(group, o);
  o += 2;
  mac.copy(out, o);
  return out;
}

/**
 * Verify a stateless address cookie for the given peer.
 * Returns embedded CH1 message_hash (+ group) on success.
 */
export function verifyAddressCookie(
  secret: Buffer,
  cookie: Buffer,
  peerKey: string,
): AddressCookiePayload | undefined {
  if (cookie.length !== ADDRESS_COOKIE_LENGTH) return undefined;
  if (cookie[0] !== ADDRESS_COOKIE_VERSION) return undefined;
  const salt = cookie.subarray(1, 17);
  const ch1MessageHash = cookie.subarray(17, 49);
  const flags = cookie[49];
  const group = cookie.readUInt16BE(50);
  const mac = cookie.subarray(52, 68);
  const expected = macAddressCookie(
    secret,
    ADDRESS_COOKIE_VERSION,
    salt,
    ch1MessageHash,
    flags,
    group,
    peerKey,
  );
  try {
    if (!timingSafeEqual(mac, expected)) return undefined;
  } catch {
    return undefined;
  }
  const payload: AddressCookiePayload = {
    ch1MessageHash: Buffer.from(ch1MessageHash),
  };
  if (flags & 0x01) payload.selectedGroup = group;
  return payload;
}

/**
 * @deprecated Prefer mintAddressCookie. Kept for unit tests of simple MAC cookies.
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

/**
 * @deprecated Prefer verifyAddressCookie.
 */
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
