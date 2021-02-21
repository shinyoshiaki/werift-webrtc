export const SignatureAlgorithm = {
  rsa: 1,
  ecdsa: 3,
} as const;

export type SignatureAlgorithms = typeof SignatureAlgorithm[keyof typeof SignatureAlgorithm];

export const CipherSuite = {
  TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256: 0xc02f, //49199 client
  TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256: 0xc02b, //49195 server
} as const;

export type CipherSuites = typeof CipherSuite[keyof typeof CipherSuite];

export const HashAlgorithm = {
  sha256: 4,
} as const;

export type HashAlgorithms = typeof HashAlgorithm[keyof typeof HashAlgorithm];

export const NamedCurveAlgorithm = {
  x25519: 29,
  secp256r1: 23,
} as const;

export type NamedCurveAlgorithms = typeof NamedCurveAlgorithm[keyof typeof NamedCurveAlgorithm];

export const CurveType = { named_curve: 3 } as const;

export type CurveTypes = typeof CurveType[keyof typeof CurveType];
