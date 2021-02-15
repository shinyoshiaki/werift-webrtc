export enum SignatureAlgorithm {
  rsa = 1,
  ecdsa = 3,
}

export const CipherSuite = {
  EcdheEcdsaWithAes128GcmSha256: 0xc02b, //49195
  EcdheRsaWithAes128GcmSha256: 0xc02f, //49199
} as const;

export enum HashAlgorithm {
  sha256 = 4,
}

export enum NamedCurveAlgorithm {
  namedCurveP256 = 23,
  namedCurveX25519 = 29,
}
