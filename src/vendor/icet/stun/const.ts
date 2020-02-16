export const COOKIE = 0x2112a442;
export const FINGERPRINT_LENGTH = 8;
export const FINGERPRINT_XOR = 0x5354554e;
export const HEADER_LENGTH = 20;
export const INTEGRITY_LENGTH = 24;
export const IPV4_PROTOCOL = 1;
export const IPV6_PROTOCOL = 2;

export const RETRY_MAX = 6;
export const RETRY_RTO = 50;

export const ATTRIBUTES = [
  "FINGERPRINT",
  "MESSAGE-INTEGRITY",
  "PRIORITY",
  "USERNAME",
  "ICE-CONTROLLING",
  "USE-CANDIDATE",
  "ICE-CONTROLLED",
  "ERROR-CODE",
  "XOR-MAPPED-ADDRESS"
] as const;
