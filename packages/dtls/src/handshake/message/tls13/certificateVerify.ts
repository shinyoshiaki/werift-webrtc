import { FragmentedHandshake } from "../../../record/message/fragment";
import type { Handshake } from "../../../typings/domain";
import { HandshakeType } from "../../const";

/**
 * TLS 1.3 CertificateVerify (RFC 8446 §4.4.3)
 */
export class CertificateVerify13 implements Handshake {
  msgType = HandshakeType.certificate_verify_15;
  messageSeq?: number;

  constructor(
    public algorithm: number,
    public signature: Buffer,
  ) {}

  static createEmpty() {
    return new CertificateVerify13(0, Buffer.alloc(0));
  }

  static deSerialize(buf: Buffer): CertificateVerify13 {
    if (buf.length < 4) throw new Error("CertificateVerify13: truncated");
    const algorithm = buf.readUInt16BE(0);
    const sigLen = buf.readUInt16BE(2);
    // Strict: no trailing bytes after signature vector
    if (buf.length !== 4 + sigLen) {
      throw new Error(
        `CertificateVerify13: length mismatch (declared sig ${sigLen}, total ${buf.length - 4})`,
      );
    }
    return new CertificateVerify13(
      algorithm,
      Buffer.from(buf.subarray(4, 4 + sigLen)),
    );
  }

  serialize(): Buffer {
    const out = Buffer.alloc(4 + this.signature.length);
    out.writeUInt16BE(this.algorithm, 0);
    out.writeUInt16BE(this.signature.length, 2);
    this.signature.copy(out, 4);
    return out;
  }

  toFragment() {
    const body = this.serialize();
    return new FragmentedHandshake(
      this.msgType,
      body.length,
      this.messageSeq!,
      0,
      body.length,
      body,
    );
  }
}

/**
 * Build TLS 1.3 CertificateVerify signed content:
 * 64 spaces || context string || 0x00 || transcript_hash
 */
export function buildCertificateVerifyContent(
  isServer: boolean,
  transcriptHash: Buffer,
): Buffer {
  const spaces = Buffer.alloc(64, 0x20);
  const context = Buffer.from(
    isServer
      ? "TLS 1.3, server CertificateVerify"
      : "TLS 1.3, client CertificateVerify",
    "ascii",
  );
  return Buffer.concat([spaces, context, Buffer.from([0]), transcriptHash]);
}
