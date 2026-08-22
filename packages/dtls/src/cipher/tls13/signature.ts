import {
  type KeyObject,
  X509Certificate,
  createPrivateKey,
  createSign,
  createVerify,
} from "crypto";
import { Certificate as FidmCertificate, PrivateKey } from "@fidm/x509";

import { buildCertificateVerifyContent } from "../../handshake/message/tls13/certificateVerify";
import { SignatureScheme } from "../const";
import { hashSha256 } from "./hkdf";

/** True if OpenSSL/Node namedCurve is NIST P-256 (secp256r1). */
export function isSecp256r1Curve(namedCurve: string | undefined): boolean {
  if (!namedCurve) return false;
  return (
    namedCurve === "prime256v1" ||
    namedCurve === "P-256" ||
    namedCurve === "secp256r1"
  );
}

function namedCurveOf(key: KeyObject): string | undefined {
  const details = key.asymmetricKeyDetails as
    | { namedCurve?: string }
    | undefined;
  return details?.namedCurve;
}

/** Schemes this key material can produce for TLS 1.3 CertificateVerify. */
export function schemesForKey(keyPem: string): number[] {
  const key = createPrivateKey(keyPem);
  const type = key.asymmetricKeyType;
  if (type === "rsa") return [SignatureScheme.rsa_pss_rsae_sha256];
  if (type === "ec") {
    // ecdsa_secp256r1_sha256 requires P-256 only (RFC 8446 §4.2.3)
    const curve = namedCurveOf(key);
    if (curve && !isSecp256r1Curve(curve)) {
      return [];
    }
    // Missing curve metadata: assume P-256 (Node often omits for some PEM forms)
    return [SignatureScheme.ecdsa_secp256r1_sha256];
  }
  return [];
}

/**
 * Pick the first scheme in `allowed` (peer preference order) that the local
 * key can produce. Throws if intersection is empty.
 */
export function selectSignatureScheme(
  keyPem: string,
  allowed: readonly number[],
): number {
  const local = new Set(schemesForKey(keyPem));
  for (const s of allowed) {
    if (local.has(s)) return s;
  }
  throw new Error(
    `no overlapping CertificateVerify signature scheme (allowed=[${allowed
      .map((x) => "0x" + x.toString(16))
      .join(",")}])`,
  );
}

/**
 * Sign TLS 1.3 CertificateVerify content with the local private key.
 * RSA uses rsa_pss_rsae_sha256 only (RFC 8446 forbids rsa_pkcs1_* for CV).
 * EC uses ecdsa_secp256r1_sha256. `preferredScheme` must be in peer intersection.
 */
export function signCertificateVerify(
  keyPem: string,
  isServer: boolean,
  transcript: Buffer,
  preferredScheme?: number,
): { algorithm: number; signature: Buffer } {
  const content = buildCertificateVerifyContent(
    isServer,
    hashSha256(transcript),
  );
  const key = createPrivateKey(keyPem);
  const type = key.asymmetricKeyType;

  if (type === "rsa") {
    // TLS 1.3 CertificateVerify: RSA-PSS only (never PKCS#1 v1.5)
    const algorithm = SignatureScheme.rsa_pss_rsae_sha256;
    if (
      preferredScheme !== undefined &&
      preferredScheme !== algorithm &&
      preferredScheme !== 0x0804
    ) {
      throw new Error(
        `RSA key cannot sign CertificateVerify with scheme 0x${preferredScheme.toString(16)}`,
      );
    }
    const signer = createSign("sha256");
    signer.update(content);
    const signature = signer.sign({
      key,
      padding: 6, // RSA_PKCS1_PSS_PADDING
      saltLength: 32,
    });
    return { algorithm, signature };
  }

  if (type === "ec") {
    const curve = namedCurveOf(key);
    if (curve && !isSecp256r1Curve(curve)) {
      throw new Error(
        `EC key namedCurve ${curve} cannot sign ecdsa_secp256r1_sha256 (P-256 only)`,
      );
    }
    const algorithm = SignatureScheme.ecdsa_secp256r1_sha256;
    if (
      preferredScheme !== undefined &&
      preferredScheme !== algorithm &&
      preferredScheme !== 0x0403
    ) {
      throw new Error(
        `EC key cannot sign CertificateVerify with scheme 0x${preferredScheme.toString(16)}`,
      );
    }
    const signer = createSign("sha256");
    signer.update(content);
    const signature = signer.sign(key);
    return { algorithm, signature };
  }

  throw new Error(`unsupported key type for CertificateVerify: ${type}`);
}

/**
 * Verify TLS 1.3 CertificateVerify against peer certificate DER.
 * Accepts only RSA-PSS and ECDSA-P-256 schemes (not rsa_pkcs1_*).
 * RFC 8446: ecdsa_secp256r1_sha256 requires a P-256 public key.
 */
export function verifyCertificateVerify(
  certDer: Buffer,
  algorithm: number,
  signature: Buffer,
  isServer: boolean,
  transcript: Buffer,
): boolean {
  const content = buildCertificateVerifyContent(
    isServer,
    hashSha256(transcript),
  );
  const x509 = new X509Certificate(certDer);
  const key = x509.publicKey;

  if (
    algorithm === SignatureScheme.rsa_pss_rsae_sha256 ||
    algorithm === 0x0804
  ) {
    if (key.asymmetricKeyType !== "rsa") {
      throw new Error(
        "illegal_parameter: rsa_pss_rsae_sha256 CertificateVerify but public key is not RSA",
      );
    }
    const verifier = createVerify("sha256");
    verifier.update(content);
    return verifier.verify(
      {
        key,
        padding: 6,
        saltLength: 32,
      },
      signature,
    );
  }

  // RFC 8446 §4.4.3: rsa_pkcs1_* MUST NOT be used for CertificateVerify in TLS 1.3
  if (algorithm === SignatureScheme.rsa_pkcs1_sha256 || algorithm === 0x0401) {
    throw new Error(
      `CertificateVerify algorithm 0x${algorithm.toString(16)} (rsa_pkcs1) forbidden in TLS 1.3`,
    );
  }

  if (algorithm === SignatureScheme.ecdsa_secp256r1_sha256) {
    if (key.asymmetricKeyType !== "ec") {
      throw new Error(
        "illegal_parameter: ecdsa_secp256r1_sha256 CertificateVerify but public key is not EC",
      );
    }
    const curve = namedCurveOf(key);
    // When namedCurve is present it MUST be P-256; missing metadata is allowed
    // only for keys that Node still verifies as secp256r1.
    if (curve && !isSecp256r1Curve(curve)) {
      throw new Error(
        `illegal_parameter: ecdsa_secp256r1_sha256 requires P-256 public key (got ${curve})`,
      );
    }
    const verifier = createVerify("sha256");
    verifier.update(content);
    return verifier.verify(key, signature);
  }

  throw new Error(
    `unsupported CertificateVerify algorithm 0x${algorithm.toString(16)}`,
  );
}

export function parseCertAndKey(
  certPem: string,
  keyPem: string,
): { certDer: Buffer; keyPem: string; privateKey: PrivateKey } {
  const cert = FidmCertificate.fromPEM(Buffer.from(certPem));
  const privateKey = PrivateKey.fromPEM(Buffer.from(keyPem));
  return { certDer: cert.raw, keyPem, privateKey };
}
