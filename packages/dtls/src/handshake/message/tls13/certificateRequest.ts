import { FragmentedHandshake } from "../../../record/message/fragment";
import type { Extension, Handshake } from "../../../typings/domain";
import { HandshakeType } from "../../const";
import {
  DEFAULT_SIGNATURE_SCHEMES,
  SignatureAlgorithms,
} from "../../extensions/signatureAlgorithms";

/**
 * TLS 1.3 CertificateRequest (RFC 8446 §4.3.2)
 * certificate_request_context + extensions (must include signature_algorithms)
 */
export class CertificateRequest13 implements Handshake {
  msgType = HandshakeType.certificate_request_13;
  messageSeq?: number;

  constructor(
    public certificateRequestContext: Buffer,
    public extensions: Extension[],
  ) {}

  static create(
    context: Buffer = Buffer.alloc(0),
    schemes: number[] = DEFAULT_SIGNATURE_SCHEMES,
  ): CertificateRequest13 {
    return new CertificateRequest13(context, [
      SignatureAlgorithms.create(schemes).extension,
    ]);
  }

  static deSerialize(buf: Buffer): CertificateRequest13 {
    if (buf.length < 1) throw new Error("CertificateRequest13: truncated");
    const ctxLen = buf.readUInt8(0);
    if (buf.length < 1 + ctxLen + 2) {
      throw new Error("CertificateRequest13: truncated body");
    }
    const context = Buffer.from(buf.subarray(1, 1 + ctxLen));
    let offset = 1 + ctxLen;
    const extLen = buf.readUInt16BE(offset);
    offset += 2;
    const end = offset + extLen;
    if (buf.length < end) throw new Error("CertificateRequest13: ext truncated");
    const extensions: Extension[] = [];
    while (offset < end) {
      if (end - offset < 4) throw new Error("CertificateRequest13: bad ext");
      const type = buf.readUInt16BE(offset);
      const len = buf.readUInt16BE(offset + 2);
      offset += 4;
      if (end - offset < len) throw new Error("CertificateRequest13: ext data");
      const data = Buffer.from(buf.subarray(offset, offset + len));
      offset += len;
      extensions.push({ type, data });
    }
    return new CertificateRequest13(context, extensions);
  }

  serialize(): Buffer {
    const ctx = this.certificateRequestContext;
    const extParts = this.extensions.map((e) => {
      const b = Buffer.alloc(4 + e.data.length);
      b.writeUInt16BE(e.type, 0);
      b.writeUInt16BE(e.data.length, 2);
      e.data.copy(b, 4);
      return b;
    });
    const extBody = Buffer.concat(extParts);
    const out = Buffer.alloc(1 + ctx.length + 2 + extBody.length);
    out.writeUInt8(ctx.length, 0);
    ctx.copy(out, 1);
    out.writeUInt16BE(extBody.length, 1 + ctx.length);
    extBody.copy(out, 1 + ctx.length + 2);
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
