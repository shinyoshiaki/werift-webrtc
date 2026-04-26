export const SignatureAlgorithm = {
  rsa_1: 1,
  ecdsa_3: 3,
} as const;
export type SignatureAlgorithms =
  (typeof SignatureAlgorithm)[keyof typeof SignatureAlgorithm];

export const HashAlgorithm = {
  sha256_4: 4,
} as const;
export type HashAlgorithms = (typeof HashAlgorithm)[keyof typeof HashAlgorithm];

export type SignatureHash = {
  hash: HashAlgorithms;
  signature: SignatureAlgorithms;
};

export const CipherSuite = {
  TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256_49195: 0xc02b, //49195,
  TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199: 0xc02f, //49199
} as const;
export type CipherSuites = (typeof CipherSuite)[keyof typeof CipherSuite];
export const CipherSuiteList: CipherSuites[] = Object.values(CipherSuite);

export const NamedCurveAlgorithm = {
  x25519_29: 29,
  secp256r1_23: 23,
} as const;
export type NamedCurveAlgorithms =
  (typeof NamedCurveAlgorithm)[keyof typeof NamedCurveAlgorithm];
export const NamedCurveAlgorithmList: NamedCurveAlgorithms[] =
  Object.values(NamedCurveAlgorithm);

export const CurveType = { named_curve_3: 3 } as const;
export type CurveTypes = (typeof CurveType)[keyof typeof CurveType];

export const SignatureScheme = {
  rsa_pkcs1_sha256: 0x0401,
  ecdsa_secp256r1_sha256: 0x0403,
} as const;
export type SignatureSchemes =
  (typeof SignatureScheme)[keyof typeof SignatureScheme];

export const certificateTypes = [
  1, // clientCertificateTypeRSASign
  64, // clientCertificateTypeECDSASign
];

export const signatures = [
  { hash: HashAlgorithm.sha256_4, signature: SignatureAlgorithm.rsa_1 },
  { hash: HashAlgorithm.sha256_4, signature: SignatureAlgorithm.ecdsa_3 },
];
