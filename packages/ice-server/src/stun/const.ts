export const COOKIE = 0x2112a442;
export const FINGERPRINT_LENGTH = 8;
export const FINGERPRINT_XOR = 0x5354554e;
export const HEADER_LENGTH = 20;
/** MESSAGE-INTEGRITY (HMAC-SHA1, 20 bytes) including its 4 byte TLV header. */
export const INTEGRITY_LENGTH = 24;
/** Untruncated MESSAGE-INTEGRITY-SHA256 value length (RFC 8489 §14.6). */
export const INTEGRITY_SHA256_VALUE_LENGTH = 32;
/** Shortest allowed truncation of MESSAGE-INTEGRITY-SHA256 (RFC 8489 §14.6). */
export const INTEGRITY_SHA256_MIN_VALUE_LENGTH = 16;
/** Default MESSAGE-INTEGRITY-SHA256 (32 bytes) including its 4 byte TLV header. */
export const INTEGRITY_SHA256_LENGTH = 4 + INTEGRITY_SHA256_VALUE_LENGTH;
export const IPV4_PROTOCOL = 1;
export const IPV6_PROTOCOL = 2;

export const RETRY_MAX = 6;
export const RETRY_RTO = 50;

export const AttributeKeys = [
  "FINGERPRINT",
  "MESSAGE-INTEGRITY",
  "MESSAGE-INTEGRITY-SHA256",
  "CHANGE-REQUEST",
  "PRIORITY",
  "USERNAME",
  "USERHASH",
  "ICE-CONTROLLING",
  "SOURCE-ADDRESS",
  "USE-CANDIDATE",
  "ICE-CONTROLLED",
  "ERROR-CODE",
  "UNKNOWN-ATTRIBUTES",
  "XOR-MAPPED-ADDRESS",
  "CHANGED-ADDRESS",
  "LIFETIME",
  "REQUESTED-TRANSPORT",
  "NONCE",
  "REALM",
  "REQUESTED-ADDRESS-FAMILY",
  "EVEN-PORT",
  "PASSWORD-ALGORITHM",
  "PASSWORD-ALGORITHMS",
  "XOR-RELAYED-ADDRESS",
  "RESERVATION-TOKEN",
  "CHANNEL-NUMBER",
  "XOR-PEER-ADDRESS",
  "DATA",
  "SOFTWARE",
  "MAPPED-ADDRESS",
  "ALTERNATE-DOMAIN",
  "ALTERNATE-SERVER",
  "RESPONSE-ORIGIN",
  "OTHER-ADDRESS",
] as const;

/**
 * Short-term credential integrity attribute a message is signed with:
 * `"sha1"` = MESSAGE-INTEGRITY (0x0008),
 * `"sha256"` = MESSAGE-INTEGRITY-SHA256 (0x001C, RFC 8489).
 */
export type MessageIntegrityAlgorithm = "sha1" | "sha256";

/**
 * Which integrity attributes an outgoing message carries. `"both"` adds
 * MESSAGE-INTEGRITY followed by MESSAGE-INTEGRITY-SHA256 (RFC 8489 §14.6
 * order), so an agent that only knows SHA-1 can still verify it.
 */
export type MessageIntegrityMode = MessageIntegrityAlgorithm | "both";

/**
 * @enum
 */
export const classes = {
  REQUEST: 0x000,
  INDICATION: 0x010,
  RESPONSE: 0x100,
  ERROR: 0x110,
} as const;
export type classes = (typeof classes)[keyof typeof classes];

/**
 * @enum
 */
export const methods = {
  BINDING: 0x1,
  SHARED_SECRET: 0x2,
  ALLOCATE: 0x3,
  REFRESH: 0x4,
  SEND: 0x6,
  DATA: 0x7,
  CREATE_PERMISSION: 0x8,
  CHANNEL_BIND: 0x9,
} as const;
export type methods = (typeof methods)[keyof typeof methods];

export function isComprehensionRequiredAttribute(type: number) {
  return type >= 0x0000 && type <= 0x7fff;
}

export function isStunMessage(data: Buffer) {
  if (data.length < HEADER_LENGTH) {
    return false;
  }

  if ((data[0] & 0xc0) !== 0) {
    return false;
  }

  if (data.readUInt32BE(4) !== COOKIE) {
    return false;
  }

  const length = data.readUInt16BE(2);
  if (length % 4 !== 0) {
    return false;
  }

  return data.length === HEADER_LENGTH + length;
}
