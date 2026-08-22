import type { Extension } from "../../typings/domain";

/** Extension type signature_algorithms = 13 (same as TLS 1.2) */
export const SIGNATURE_ALGORITHMS_TYPE = 13;

/**
 * TLS 1.3 SignatureScheme values we support for CertificateVerify.
 * RSA PKCS#1 v1.5 (rsa_pkcs1_*) is forbidden for TLS 1.3 CertificateVerify
 * (RFC 8446 §4.4.3 / §9.1) — only RSA-PSS and ECDSA/EdDSA are advertised.
 */
export const SignatureScheme13 = {
  /** @deprecated Not used for TLS 1.3 CertificateVerify (kept for wire decode only). */
  rsa_pkcs1_sha256: 0x0401,
  rsa_pss_rsae_sha256: 0x0804,
  ecdsa_secp256r1_sha256: 0x0403,
  ed25519: 0x0807,
} as const;

export type SignatureScheme13Value =
  (typeof SignatureScheme13)[keyof typeof SignatureScheme13];

/** Advertised / accepted for TLS 1.3 CertificateVerify (no rsa_pkcs1_*). */
export const DEFAULT_SIGNATURE_SCHEMES: number[] = [
  SignatureScheme13.ecdsa_secp256r1_sha256,
  SignatureScheme13.rsa_pss_rsae_sha256,
];

export class SignatureAlgorithms {
  static type = SIGNATURE_ALGORITHMS_TYPE;

  constructor(public schemes: number[]) {}

  static create(schemes: number[] = DEFAULT_SIGNATURE_SCHEMES) {
    return new SignatureAlgorithms(schemes);
  }

  static fromData(data: Buffer): SignatureAlgorithms {
    if (data.length < 2) throw new Error("signature_algorithms: truncated");
    const len = data.readUInt16BE(0);
    // Strict: no trailing bytes after declared vector
    if (data.length !== 2 + len || len % 2 !== 0 || len < 2) {
      throw new Error(
        `signature_algorithms: invalid length (declared ${len}, total ${data.length})`,
      );
    }
    const schemes: number[] = [];
    for (let i = 0; i < len; i += 2) {
      schemes.push(data.readUInt16BE(2 + i));
    }
    return new SignatureAlgorithms(schemes);
  }

  serializeData(): Buffer {
    const buf = Buffer.alloc(2 + this.schemes.length * 2);
    buf.writeUInt16BE(this.schemes.length * 2, 0);
    this.schemes.forEach((s, i) => buf.writeUInt16BE(s, 2 + i * 2));
    return buf;
  }

  get extension(): Extension {
    return { type: SignatureAlgorithms.type, data: this.serializeData() };
  }
}
