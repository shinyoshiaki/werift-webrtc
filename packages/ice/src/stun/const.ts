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
  "CHANGE-REQUEST",
  "PRIORITY",
  "USERNAME",
  "ICE-CONTROLLING",
  "SOURCE-ADDRESS",
  "USE-CANDIDATE",
  "ICE-CONTROLLED",
  "ERROR-CODE",
  "XOR-MAPPED-ADDRESS",
  "CHANGED-ADDRESS",
  "LIFETIME",
  "REQUESTED-TRANSPORT",
  "NONCE",
  "REALM",
  "XOR-RELAYED-ADDRESS",
  "CHANNEL-NUMBER",
  "XOR-PEER-ADDRESS",
  "DATA",
  "SOFTWARE",
  "MAPPED-ADDRESS",
  "RESPONSE-ORIGIN",
  "OTHER-ADDRESS",
] as const;

export enum classes {
  REQUEST = 0x000,
  INDICATION = 0x010,
  RESPONSE = 0x100, // 256
  ERROR = 0x110, // 272
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
