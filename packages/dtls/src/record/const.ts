/**
 * @enum
 */
export const ContentType = {
  changeCipherSpec: 20,
  alert: 21,
  handshake: 22,
  applicationData: 23,
} as const;
export type ContentType = (typeof ContentType)[keyof typeof ContentType];

/**
 * @enum
 */
export const AlertDesc = {
  CloseNotify: 0,
  UnexpectedMessage: 10,
  BadRecordMac: 20,
  DecryptionFailed: 21,
  RecordOverflow: 22,
  DecompressionFailure: 30,
  HandshakeFailure: 40,
  NoCertificate: 41,
  BadCertificate: 42,
  UnsupportedCertificate: 43,
  CertificateRevoked: 44,
  CertificateExpired: 45,
  CertificateUnknown: 46,
  IllegalParameter: 47,
  UnknownCa: 48,
  AccessDenied: 49,
  DecodeError: 50,
  DecryptError: 51,
  ExportRestriction: 60,
  ProtocolVersion: 70,
  InsufficientSecurity: 71,
  InternalError: 80,
  UserCanceled: 90,
  NoRenegotiation: 100,
  UnsupportedExtension: 110,
} as const;
export type AlertDesc = (typeof AlertDesc)[keyof typeof AlertDesc];

/** Returns the AlertDesc member name for a wire value, or undefined if unknown. */
export const alertDescName = (value: number): string | undefined =>
  Object.entries(AlertDesc).find(([, v]) => v === value)?.[0];
