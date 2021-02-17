export enum SignatureAlgorithm {
  rsa = 1,
  ecdsa = 3,
}

export const CipherSuite = {
  TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256: 0xc02b, //49195
  TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256: 0xc02f, //49199
} as const;

export type CipherSuites = typeof CipherSuite[keyof typeof CipherSuite];

export enum HashAlgorithm {
  sha256 = 4,
}

export const NamedCurveAlgorithm = {
  x25519: 29, // prefer
  secp256r1: 23,
} as const;

export type NamedCurveAlgorithms = typeof NamedCurveAlgorithm[keyof typeof NamedCurveAlgorithm];
