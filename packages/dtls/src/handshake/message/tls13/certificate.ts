import { FragmentedHandshake } from "../../../record/message/fragment";
import type { Handshake } from "../../../typings/domain";
import { HandshakeType } from "../../const";

/**
 * TLS 1.3 Certificate (RFC 8446 §4.4.2)
 * certificate_request_context + list of CertificateEntry (cert + extensions)
 */
export class Certificate13 implements Handshake {
  msgType = HandshakeType.certificate_11;
  messageSeq?: number;

  constructor(
    public certificateRequestContext: Buffer,
    public certificates: Buffer[],
  ) {}

  static createEmpty() {
    return new Certificate13(Buffer.alloc(0), []);
  }

  static deSerialize(buf: Buffer): Certificate13 {
    if (buf.length < 1) throw new Error("Certificate13: truncated context");
    const ctxLen = buf.readUInt8(0);
    if (buf.length < 1 + ctxLen + 3) {
      throw new Error("Certificate13: truncated");
    }
    const context = Buffer.from(buf.subarray(1, 1 + ctxLen));
    let offset = 1 + ctxLen;
    const listLen = buf.readUIntBE(offset, 3);
    offset += 3;
    const end = offset + listLen;
    if (buf.length < end) throw new Error("Certificate13: list truncated");
    // Reject trailing junk after the certificate list
    if (buf.length !== end) {
      throw new Error("Certificate13: trailing data after certificate_list");
    }
    const certificates: Buffer[] = [];
    while (offset < end) {
      if (end - offset < 3) throw new Error("Certificate13: cert truncated");
      const certLen = buf.readUIntBE(offset, 3);
      offset += 3;
      if (certLen < 1) throw new Error("Certificate13: empty cert_data");
      if (end - offset < certLen + 2) {
        throw new Error("Certificate13: cert data truncated");
      }
      const cert = Buffer.from(buf.subarray(offset, offset + certLen));
      offset += certLen;
      const extLen = buf.readUInt16BE(offset);
      offset += 2;
      // extensions must fit entirely within certificate_list
      if (offset + extLen > end) {
        throw new Error("Certificate13: extensions exceed certificate_list");
      }
      // skip extension bytes (we do not parse them yet)
      offset += extLen;
      certificates.push(cert);
    }
    if (offset !== end) {
      throw new Error("Certificate13: certificate_list length mismatch");
    }
    return new Certificate13(context, certificates);
  }

  serialize(): Buffer {
    const ctx = this.certificateRequestContext;
    const entries = this.certificates.map((cert) => {
      // cert_data (uint24) + empty extensions (uint16=0)
      const e = Buffer.alloc(3 + cert.length + 2);
      e.writeUIntBE(cert.length, 0, 3);
      cert.copy(e, 3);
      e.writeUInt16BE(0, 3 + cert.length);
      return e;
    });
    const list = Buffer.concat(entries);
    const out = Buffer.alloc(1 + ctx.length + 3 + list.length);
    out.writeUInt8(ctx.length, 0);
    ctx.copy(out, 1);
    out.writeUIntBE(list.length, 1 + ctx.length, 3);
    list.copy(out, 1 + ctx.length + 3);
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
