import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  X509Certificate,
} from "crypto";
import { Certificate as FidmCertificate, PrivateKey } from "@fidm/x509";

import { SignatureScheme } from "../const";
import { hashSha256 } from "./hkdf";
import { buildCertificateVerifyContent } from "../../handshake/message/tls13/certificateVerify";

/**
 * Sign TLS 1.3 CertificateVerify content with the local private key.
 * Prefer rsa_pss_rsae_sha256 for RSA, ecdsa_secp256r1_sha256 for EC.
 */
export function signCertificateVerify(
  keyPem: string,
  isServer: boolean,
  transcript: Buffer,
  preferredScheme?: number,
): { algorithm: number; signature: Buffer } {
  const content = buildCertificateVerifyContent(isServer, hashSha256(transcript));
  const key = createPrivateKey(keyPem);
  const type = key.asymmetricKeyType;

  if (type === "rsa") {
    const algorithm =
      preferredScheme === SignatureScheme.rsa_pkcs1_sha256
        ? SignatureScheme.rsa_pkcs1_sha256
        : SignatureScheme.rsa_pss_rsae_sha256;
    if (algorithm === SignatureScheme.rsa_pss_rsae_sha256) {
      const signer = createSign("sha256");
      signer.update(content);
      const signature = signer.sign({
        key,
        padding: 6, // RSA_PKCS1_PSS_PADDING
        saltLength: 32,
      });
      return { algorithm, signature };
    }
    const signer = createSign("RSA-SHA256");
    signer.update(content);
    return { algorithm, signature: signer.sign(key) };
  }

  if (type === "ec") {
    const signer = createSign("sha256");
    signer.update(content);
    const signature = signer.sign(key);
    return {
      algorithm: SignatureScheme.ecdsa_secp256r1_sha256,
      signature,
    };
  }

  throw new Error(`unsupported key type for CertificateVerify: ${type}`);
}

/**
 * Verify TLS 1.3 CertificateVerify against peer certificate DER.
 */
export function verifyCertificateVerify(
  certDer: Buffer,
  algorithm: number,
  signature: Buffer,
  isServer: boolean,
  transcript: Buffer,
): boolean {
  const content = buildCertificateVerifyContent(isServer, hashSha256(transcript));
  const x509 = new X509Certificate(certDer);
  const key = x509.publicKey;

  if (
    algorithm === SignatureScheme.rsa_pss_rsae_sha256 ||
    algorithm === 0x0804
  ) {
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

  if (algorithm === SignatureScheme.rsa_pkcs1_sha256) {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(content);
    return verifier.verify(key, signature);
  }

  if (algorithm === SignatureScheme.ecdsa_secp256r1_sha256) {
    const verifier = createVerify("sha256");
    verifier.update(content);
    return verifier.verify(key, signature);
  }

  throw new Error(`unsupported CertificateVerify algorithm 0x${algorithm.toString(16)}`);
}

export function parseCertAndKey(
  certPem: string,
  keyPem: string,
): { certDer: Buffer; keyPem: string; privateKey: PrivateKey } {
  const cert = FidmCertificate.fromPEM(Buffer.from(certPem));
  const privateKey = PrivateKey.fromPEM(Buffer.from(keyPem));
  return { certDer: cert.raw, keyPem, privateKey };
}
