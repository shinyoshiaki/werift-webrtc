/**
 * @enum
 */
export const ContentType = {
  changeCipherSpec: 20,
  alert: 21,
  handshake: 22,
  applicationData: 23,
  /** DTLS 1.3 ACK (RFC 9147) */
  ack: 26,
} as const;
export type ContentType = (typeof ContentType)[keyof typeof ContentType];

const alertDescriptionValues = {
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
  /** RFC 8446 missing_extension */
  MissingExtension: 109,
  UnsupportedExtension: 110,
  /** RFC 8446 certificate_required */
  CertificateRequired: 116,
} as const;

/**
 * @enum
 */
export const AlertDesc = new Proxy(alertDescriptionValues, {
  get(target, property, receiver) {
    if (typeof property === "string" && /^\d+$/.test(property)) {
      const value = Number(property);
      return Object.entries(target).find(([, memberValue]) =>
        Object.is(memberValue, value),
      )?.[0];
    }
    return Reflect.get(target, property, receiver);
  },
}) as typeof alertDescriptionValues & {
  readonly [value: number]: string | undefined;
};
export type AlertDesc =
  (typeof alertDescriptionValues)[keyof typeof alertDescriptionValues];

/** Returns the AlertDesc member name for a wire value, or undefined if unknown. */
export const alertDescName = (value: number): string | undefined =>
  Object.entries(alertDescriptionValues).find(([, v]) => v === value)?.[0];
