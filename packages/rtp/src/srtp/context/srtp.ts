import { createCipheriv, createDecipheriv } from "crypto";

import { growBufferSize } from "../../helper";
import { RtpHeader } from "../../rtp/rtp";
import { Context } from "./context";

export class SrtpContext extends Context {
  constructor(masterKey: Buffer, masterSalt: Buffer, profile: number) {
    super(masterKey, masterSalt, profile);
  }

  decryptRTP(cipherText: Buffer, header?: RtpHeader): [Buffer, RtpHeader] {
    header = header || RtpHeader.deSerialize(cipherText);

    const s = this.getSrtpSsrcState(header.ssrc);

    let dst = Buffer.from([]);
    dst = growBufferSize(dst, cipherText.length - 10);
    this.updateRolloverCount(header.sequenceNumber, s);

    cipherText = cipherText.slice(0, cipherText.length - 10);

    cipherText.slice(0, header.payloadOffset).copy(dst);

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
    const payload = cipherText.slice(header.payloadOffset);
    const buf = cipher.update(payload);
    buf.copy(dst, header.payloadOffset);

    return [dst, header];
  }

  encryptRTP(payload: Buffer, header: RtpHeader) {
    const s = this.getSrtpSsrcState(header.ssrc);
    this.updateRolloverCount(header.sequenceNumber, s);

    const dst = Buffer.alloc(header.serializeSize + payload.length + 10);
    header.serialize(dst.length).copy(dst);
    const { payloadOffset } = header;

    const counter = this.generateCounter(
      header.sequenceNumber,
      s.rolloverCounter,
      s.ssrc,
      this.srtpSessionSalt
    );

    const cipher = createCipheriv("aes-128-ctr", this.srtpSessionKey, counter);
    const buf = cipher.update(payload);
    buf.copy(dst, payloadOffset);
    const totalLength = payloadOffset + payload.length;

    const authTag = this.generateSrtpAuthTag(
      dst.slice(0, totalLength),
      s.rolloverCounter
    );
    authTag.copy(dst, totalLength);
    return dst;
  }
}
