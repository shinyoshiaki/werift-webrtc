import { RtpHeader } from "../../rtp/rtp";
import { createCipheriv, createDecipheriv } from "crypto";
import { Context } from "./context";
import { growBufferSize } from "../../helper";

export class SrtpContext extends Context {
  constructor(masterKey: Buffer, masterSalt: Buffer, profile: number) {
    super(masterKey, masterSalt, profile);
  }
  decryptRTP(ciphertext: Buffer, header?: RtpHeader): [Buffer, RtpHeader] {
    header = header || RtpHeader.deSerialize(ciphertext);

    const s = this.getSRTPSRRCState(header.ssrc);

    let dst = Buffer.from([]);
    dst = growBufferSize(dst, ciphertext.length - 10);
    this.updateRolloverCount(header.sequenceNumber, s);

    ciphertext = ciphertext.slice(0, ciphertext.length - 10);

    ciphertext.slice(0, header.payloadOffset).copy(dst);

    const counter = this.generateCounter(
      header.sequenceNumber,
      s.rolloverCounter,
      s.ssrc,
      this.srtpSessionSalt
    );
    const cipher = createDecipheriv(
      "aes-128-ctr",
      this.srtpSessionKey,
      counter
    );
    const payload = ciphertext.slice(header.payloadOffset);
    const buf = cipher.update(payload);
    buf.copy(dst, header.payloadOffset);

    return [dst, header];
  }

  encryptRTP(payload: Buffer, header: RtpHeader) {
    let dst = Buffer.from([]);
    dst = growBufferSize(dst, header.serializeSize + payload.length + 10);

    const s = this.getSRTPSRRCState(header.ssrc);
    this.updateRolloverCount(header.sequenceNumber, s);

    header.serialize(dst.length).copy(dst);
    let n = header.payloadOffset;

    const counter = this.generateCounter(
      header.sequenceNumber,
      s.rolloverCounter,
      s.ssrc,
      this.srtpSessionSalt
    );

    const cipher = createCipheriv("aes-128-ctr", this.srtpSessionKey, counter);
    const buf = cipher.update(payload);
    buf.copy(dst, header.payloadOffset);
    n += payload.length;

    const authTag = this.generateSrtpAuthTag(
      dst.slice(0, n),
      s.rolloverCounter
    );
    authTag.copy(dst, n);
    return dst;
  }
}
