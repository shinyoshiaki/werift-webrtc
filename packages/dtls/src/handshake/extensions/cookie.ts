import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Extension } from "../../typings/domain";
import { HandshakeType } from "../const";
import { ClientHello } from "../message/client/hello";

/** TLS 1.3 cookie extension type = 44 (RFC 8446) */
export const COOKIE_EXTENSION_TYPE = 44;

/**
 * Cookie format version for address-validation cookies (stateless).
 * v2: CH1 message_hash + immutable-fields hash + issuedAt for expiry.
 */
export const ADDRESS_COOKIE_VERSION = 0x02;

/** Max age of a stateless address cookie (seconds). */
export const ADDRESS_COOKIE_MAX_AGE_SEC = 60;
/** Allow small clock skew when checking issuedAt. */
export const ADDRESS_COOKIE_CLOCK_SKEW_SEC = 5;

/**
 * Stateless cookie layout v2:
 *   version(1) || salt(16) || ch1MessageHash(32) || ch1ImmutableHash(32)
 *   || flags(1) || group(2) || issuedAt(4) || mac(16)
 * mac = HMAC-SHA256(secret, all fields || peerKey)[0:16]
 */
export const ADDRESS_COOKIE_LENGTH = 1 + 16 + 32 + 32 + 1 + 2 + 4 + 16; // 104

/** Extension types stripped when hashing HRR-immutable ClientHello fields. */
const EXT_PADDING = 21;
const EXT_EARLY_DATA = 42;
const EXT_COOKIE = COOKIE_EXTENSION_TYPE;
const EXT_KEY_SHARE = 51;

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
 * Canonical hash of ClientHello fields that must not change after HRR
 * (RFC 8446 §4.1.4), after stripping HRR-mutable extensions:
 * - padding, early_data, cookie always stripped
 * - key_share stripped when HRR will/did select a group
 *
 * Enables CH2 consistency checks without storing CH1 body server-side.
 */
export function clientHelloImmutableFieldsHash(
  clientHelloBody: Buffer,
  opts?: { hrrSelectedGroup?: number },
): Buffer {
  const ch = ClientHello.deSerialize(clientHelloBody);
  const parts: Buffer[] = [];

  parts.push(Buffer.from([ch.clientVersion.major, ch.clientVersion.minor]));

  const random32 = Buffer.alloc(32);
  random32.writeUInt32BE(ch.random.gmt_unix_time >>> 0, 0);
  ch.random.random_bytes.copy(random32, 4);
  parts.push(random32);

  parts.push(Buffer.from([ch.sessionId.length]));
  parts.push(ch.sessionId);
  // legacy_cookie must be empty in DTLS 1.3 — still bind its value
  parts.push(Buffer.from([ch.cookie.length]));
  parts.push(ch.cookie);

  const csLen = Buffer.alloc(2);
  csLen.writeUInt16BE(ch.cipherSuites.length * 2, 0);
  parts.push(csLen);
  for (const c of ch.cipherSuites) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(c, 0);
    parts.push(b);
  }

  parts.push(Buffer.from([ch.compressionMethods.length]));
  parts.push(Buffer.from(ch.compressionMethods));

  const skip = new Set<number>([EXT_PADDING, EXT_EARLY_DATA, EXT_COOKIE]);
  if (opts?.hrrSelectedGroup !== undefined) {
    skip.add(EXT_KEY_SHARE);
  }
  // Preserve relative order of remaining extensions (RFC requires identity)
  for (const e of ch.extensions) {
    if (skip.has(e.type)) continue;
    const hdr = Buffer.alloc(4);
    hdr.writeUInt16BE(e.type, 0);
    hdr.writeUInt16BE(e.data.length, 2);
    parts.push(hdr, e.data);
  }

  return createHash("sha256").update(Buffer.concat(parts)).digest();
}

/**
 * Build binding material for a DTLS cookie (legacy helper / tests):
 * peer identity (ip:port) || 0x00 || SHA-256(ClientHello body).
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
  ch1ImmutableHash: Buffer;
  /** HRR selected_group if present in the cookie-bearing HRR */
  selectedGroup?: number;
  issuedAt: number;
};

function macAddressCookie(
  secret: Buffer,
  version: number,
  salt: Buffer,
  ch1MessageHash: Buffer,
  ch1ImmutableHash: Buffer,
  flags: number,
  group: number,
  issuedAt: number,
  peerKey: string,
): Buffer {
  const issued = Buffer.alloc(4);
  issued.writeUInt32BE(issuedAt >>> 0, 0);
  const g = Buffer.alloc(2);
  g.writeUInt16BE(group & 0xffff, 0);
  return createHmac("sha256", secret)
    .update(Buffer.from([version]))
    .update(salt)
    .update(ch1MessageHash)
    .update(ch1ImmutableHash)
    .update(Buffer.from([flags & 0xff]))
    .update(g)
    .update(issued)
    .update(Buffer.from(peerKey, "utf8"))
    .digest()
    .subarray(0, 16);
}

/**
 * Mint a stateless address-validation cookie embedding:
 * - CH1 transcript message_hash
 * - CH1 immutable-fields hash (for CH2 consistency without server map)
 * - optional HRR selected_group
 * - issuedAt for expiry
 */
export function mintAddressCookie(
  secret: Buffer,
  peerKey: string,
  clientHelloBody: Buffer,
  opts?: { selectedGroup?: number; nowSec?: number },
): Buffer {
  const salt = randomBytes(16);
  const ch1MessageHash = clientHelloMessageHash(clientHelloBody);
  const ch1ImmutableHash = clientHelloImmutableFieldsHash(clientHelloBody, {
    hrrSelectedGroup: opts?.selectedGroup,
  });
  const hasGroup = opts?.selectedGroup !== undefined;
  const flags = hasGroup ? 0x01 : 0x00;
  const group = hasGroup ? (opts!.selectedGroup as number) & 0xffff : 0;
  const issuedAt = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const mac = macAddressCookie(
    secret,
    ADDRESS_COOKIE_VERSION,
    salt,
    ch1MessageHash,
    ch1ImmutableHash,
    flags,
    group,
    issuedAt,
    peerKey,
  );
  const out = Buffer.alloc(ADDRESS_COOKIE_LENGTH);
  let o = 0;
  out[o++] = ADDRESS_COOKIE_VERSION;
  salt.copy(out, o);
  o += 16;
  ch1MessageHash.copy(out, o);
  o += 32;
  ch1ImmutableHash.copy(out, o);
  o += 32;
  out[o++] = flags;
  out.writeUInt16BE(group, o);
  o += 2;
  out.writeUInt32BE(issuedAt >>> 0, o);
  o += 4;
  mac.copy(out, o);
  return out;
}

/**
 * Verify a stateless address cookie for the given peer.
 * Rejects bad MAC, wrong version, or expired issuedAt.
 */
export function verifyAddressCookie(
  secret: Buffer,
  cookie: Buffer,
  peerKey: string,
  opts?: { nowSec?: number; maxAgeSec?: number },
): AddressCookiePayload | undefined {
  if (cookie.length !== ADDRESS_COOKIE_LENGTH) return undefined;
  if (cookie[0] !== ADDRESS_COOKIE_VERSION) return undefined;
  let o = 1;
  const salt = cookie.subarray(o, o + 16);
  o += 16;
  const ch1MessageHash = cookie.subarray(o, o + 32);
  o += 32;
  const ch1ImmutableHash = cookie.subarray(o, o + 32);
  o += 32;
  const flags = cookie[o++];
  const group = cookie.readUInt16BE(o);
  o += 2;
  const issuedAt = cookie.readUInt32BE(o);
  o += 4;
  const mac = cookie.subarray(o, o + 16);

  const expected = macAddressCookie(
    secret,
    ADDRESS_COOKIE_VERSION,
    salt,
    ch1MessageHash,
    ch1ImmutableHash,
    flags,
    group,
    issuedAt,
    peerKey,
  );
  try {
    if (!timingSafeEqual(mac, expected)) return undefined;
  } catch {
    return undefined;
  }

  const now = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const maxAge = opts?.maxAgeSec ?? ADDRESS_COOKIE_MAX_AGE_SEC;
  if (issuedAt > now + ADDRESS_COOKIE_CLOCK_SKEW_SEC) return undefined;
  if (now - issuedAt > maxAge) return undefined;

  const payload: AddressCookiePayload = {
    ch1MessageHash: Buffer.from(ch1MessageHash),
    ch1ImmutableHash: Buffer.from(ch1ImmutableHash),
    issuedAt,
  };
  if (flags & 0x01) payload.selectedGroup = group;
  return payload;
}

/**
 * @deprecated Prefer mintAddressCookie. Kept for unit tests of simple MAC cookies.
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
