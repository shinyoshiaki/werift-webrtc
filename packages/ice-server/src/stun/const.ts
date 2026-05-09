export const COOKIE = 0x2112a442;
export const FINGERPRINT_LENGTH = 8;
export const FINGERPRINT_XOR = 0x5354554e;
export const HEADER_LENGTH = 20;
export const INTEGRITY_LENGTH = 24;
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

export enum classes {
  REQUEST = 0x000,
  INDICATION = 0x010,
  RESPONSE = 0x100,
  ERROR = 0x110,
}

export enum methods {
  BINDING = 0x1,
  SHARED_SECRET = 0x2,
  ALLOCATE = 0x3,
  REFRESH = 0x4,
  SEND = 0x6,
  DATA = 0x7,
  CREATE_PERMISSION = 0x8,
  CHANNEL_BIND = 0x9,
}

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
