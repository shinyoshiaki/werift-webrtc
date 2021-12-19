import { createCipheriv, createDecipheriv, createHmac } from "crypto";
import { range } from "lodash";

import { growBufferSize } from "../../helper";
import { RtcpHeader } from "../../rtcp/header";
import { RtpHeader } from "../../rtp/rtp";
import { CipherAesBase } from ".";

export class CipherAesCtr extends CipherAesBase {
  readonly authTagLength = 10;

  constructor(
    srtpSessionKey: Buffer,
    srtpSessionSalt: Buffer,
    srtcpSessionKey: Buffer,
    srtcpSessionSalt: Buffer,
    private srtpSessionAuthTag: Buffer,
    private srtcpSessionAuthTag: Buffer
  ) {
    super(srtpSessionKey, srtpSessionSalt, srtcpSessionKey, srtcpSessionSalt);
  }

  encryptRtp(header: RtpHeader, payload: Buffer, rolloverCounter: number) {
    const dst = Buffer.alloc(
      header.serializeSize + payload.length + this.authTagLength
    );
    header.serialize(dst.length).copy(dst);

    const { payloadOffset } = header;

    const counter = this.generateCounter(
      header.sequenceNumber,
      rolloverCounter,
      header.ssrc,
      this.srtpSessionSalt
    );

    const cipher = createCipheriv("aes-128-ctr", this.srtpSessionKey, counter);
    const enc = cipher.update(payload);
    enc.copy(dst, payloadOffset);
    const totalLength = payloadOffset + payload.length;

    const authTag = this.generateSrtpAuthTag(
      dst.slice(0, totalLength),
      rolloverCounter
    );
    authTag.copy(dst, totalLength);
    return dst;
  }

  decryptRtp(cipherText: Buffer, rolloverCounter: number): [Buffer, RtpHeader] {
    const header = RtpHeader.deSerialize(cipherText);

    let dst = Buffer.from([]);
    dst = growBufferSize(dst, cipherText.length - this.authTagLength);

    cipherText = cipherText.slice(0, cipherText.length - this.authTagLength);

    cipherText.slice(0, header.payloadOffset).copy(dst);

    const counter = this.generateCounter(
      header.sequenceNumber,
      rolloverCounter,
      header.ssrc,
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

  encryptRTCP(rtcpPacket: Buffer, srtcpIndex: number): Buffer {
    let out = Buffer.from(rtcpPacket);
    const ssrc = out.readUInt32BE(4);

    const counter = this.generateCounter(
      srtcpIndex & 0xffff,
      srtcpIndex >> 16,
      ssrc,
      this.srtcpSessionSalt
    );
    const cipher = createCipheriv("aes-128-ctr", this.srtcpSessionKey, counter);
    // Encrypt everything after header
    const buf = cipher.update(out.slice(8));
    buf.copy(out, 8);
    out = Buffer.concat([out, Buffer.alloc(4)]);
    out.writeUInt32BE(srtcpIndex, out.length - 4);
    out[out.length - 4] |= 0x80;
    const authTag = this.generateSrtcpAuthTag(out);
    out = Buffer.concat([out, authTag]);

    return out;
  }

  decryptRTCP(encrypted: Buffer): [Buffer, RtcpHeader] {
    const header = RtcpHeader.deSerialize(encrypted);

    const tailOffset = encrypted.length - (this.authTagLength + srtcpIndexSize);
    const out = Buffer.from(encrypted).slice(0, tailOffset);

    const isEncrypted = encrypted[tailOffset] >> 7;
    if (isEncrypted === 0) return [out, header];

    let srtcpIndex = encrypted.readUInt32BE(tailOffset);
    srtcpIndex &= ~(1 << 31);

    const ssrc = encrypted.readUInt32BE(4);

    // todo impl compare
    const actualTag = encrypted.slice(encrypted.length - 10);

    const counter = this.generateCounter(
      srtcpIndex & 0xffff,
      srtcpIndex >> 16,
      ssrc,
      this.srtcpSessionSalt
    );
    const cipher = createDecipheriv(
      "aes-128-ctr",
      this.srtcpSessionKey,
      counter
    );
    const buf = cipher.update(out.slice(8));
    buf.copy(out, 8);
    return [out, header];
  }

  generateSrtcpAuthTag(buf: Buffer) {
    const srtcpSessionAuth = createHmac("sha1", this.srtcpSessionAuthTag);
    return srtcpSessionAuth.update(buf).digest().slice(0, 10);
  }

  generateCounter(
    sequenceNumber: number,
    rolloverCounter: number,
    ssrc: number,
    sessionSalt: Buffer
  ) {
    const counter = Buffer.alloc(16);
    counter.writeUInt32BE(ssrc, 4);
    counter.writeUInt32BE(rolloverCounter, 8);
    counter.writeUInt32BE(Number(BigInt(sequenceNumber) << 16n), 12);

    range(sessionSalt.length).forEach((i) => {
      counter[i] = counter[i] ^ sessionSalt[i];
    });
    return counter;
  }

  generateSrtpAuthTag(buf: Buffer, roc: number) {
    const srtpSessionAuth = createHmac("sha1", this.srtpSessionAuthTag);
    const rocRaw = Buffer.alloc(4);
    rocRaw.writeUInt32BE(roc);

    return srtpSessionAuth.update(buf).update(rocRaw).digest().slice(0, 10);
  }
}

const srtcpIndexSize = 4;
