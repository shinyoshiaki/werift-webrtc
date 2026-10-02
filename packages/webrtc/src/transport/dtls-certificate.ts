import { Certificate, PrivateKey } from "@fidm/x509";

import {
  CipherContext,
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
  type SignatureHash,
} from "../imports/dtls";
import { fingerprint } from "../utils";

export class RTCCertificate {
  publicKey: string;
  privateKey: string;

  constructor(
    privateKeyPem: string,
    public certPem: string,
    public signatureHash: SignatureHash,
  ) {
    const cert = Certificate.fromPEM(Buffer.from(certPem));
    this.publicKey = cert.publicKey.toPEM();
    this.privateKey = PrivateKey.fromPEM(Buffer.from(privateKeyPem)).toPEM();
  }

  getFingerprints(): RTCDtlsFingerprint[] {
    return [
      new RTCDtlsFingerprint(
        "sha-256",
        fingerprint(
          Certificate.fromPEM(Buffer.from(this.certPem)).raw,
          "sha256",
        ),
      ),
    ];
  }
}

export type DtlsKeys = {
  certPem: string;
  keyPem: string;
  signatureHash: SignatureHash;
};

export class RTCDtlsFingerprint {
  constructor(
    public algorithm: string,
    public value: string,
  ) {}
}

export class RTCDtlsParameters {
  constructor(
    public fingerprints: RTCDtlsFingerprint[] = [],
    public role: "auto" | "client" | "server",
  ) {}
}

/** @internal ECDSA P-256 self-signed certificate used as the default identity. */
export async function createSelfSignedCertificate() {
  const { certPem, keyPem, signatureHash } =
    await CipherContext.createSelfSignedCertificateWithKey(
      {
        signature: SignatureAlgorithm.ecdsa_3,
        hash: HashAlgorithm.sha256_4,
      },
      NamedCurveAlgorithm.secp256r1_23,
    );
  return new RTCCertificate(keyPem, certPem, signatureHash);
}
