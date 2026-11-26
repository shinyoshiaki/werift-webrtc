import { createPrivateKey, X509Certificate } from "node:crypto";

import {
  CipherContext,
  HashAlgorithm,
  NamedCurveAlgorithm,
  normalizePem,
  SignatureAlgorithm,
  type SignatureHash,
} from "../imports/dtls";
import { fingerprint } from "../utils";

export class RTCCertificate {
  public certPem: string;
  public signatureHash: SignatureHash;

  publicKey: string;
  privateKey: string;

  constructor(
    privateKeyPem: string,
    certPem: string,
    signatureHash: SignatureHash,
  ) {
    this.certPem = certPem;
    this.signatureHash = signatureHash;
    this.certPem = normalizePem(certPem);
    const cert = new X509Certificate(this.certPem);
    this.publicKey = cert.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    this.privateKey = createPrivateKey(normalizePem(privateKeyPem))
      .export({ type: "pkcs8", format: "pem" })
      .toString();
  }

  getFingerprints(): RTCDtlsFingerprint[] {
    return [
      new RTCDtlsFingerprint(
        "sha-256",
        fingerprint(new X509Certificate(this.certPem).raw, "sha256"),
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
  public algorithm: string;
  public value: string;

  constructor(algorithm: string, value: string) {
    this.algorithm = algorithm;
    this.value = value;
  }
}

export class RTCDtlsParameters {
  public fingerprints: RTCDtlsFingerprint[];
  public role: "auto" | "client" | "server";

  constructor(
    fingerprints: RTCDtlsFingerprint[] = [],
    role: "auto" | "client" | "server",
  ) {
    this.fingerprints = fingerprints;
    this.role = role;
  }
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
