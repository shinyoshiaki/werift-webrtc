import { createCipheriv, createDecipheriv, createHmac } from "crypto";

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
    const headerBuffer = header.serialize(header.serializeSize);

    const counter = this.generateCounter(
      header.sequenceNumber,
      rolloverCounter,
      header.ssrc,
      this.srtpSessionSalt
    );

    const cipher = createCipheriv("aes-128-ctr", this.srtpSessionKey, counter);
    const enc = cipher.update(payload);

    const authTag = this.generateSrtpAuthTag(
      rolloverCounter,
      headerBuffer,
      enc
    );
    return Buffer.concat([headerBuffer, enc, authTag]);
  }

  decryptRtp(cipherText: Buffer, rolloverCounter: number): [Buffer, RtpHeader] {
    const header = RtpHeader.deSerialize(cipherText);

    let dst = Buffer.from([]);
    dst = growBufferSize(dst, cipherText.length - this.authTagLength);

    cipherText = cipherText.subarray(0, cipherText.length - this.authTagLength);

    cipherText.subarray(0, header.payloadOffset).copy(dst);

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
    const actualTag = encrypted.subarray(encrypted.length - 10);

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
    const buf = cipher.update(out.subarray(8));
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

    for (let i = 0; i < sessionSalt.length; i++) {
      counter[i] = counter[i] ^ sessionSalt[i];
    }
    return counter;
  }

  generateSrtpAuthTag(roc: number, ...buffers: Buffer[]) {
    const srtpSessionAuth = createHmac("sha1", this.srtpSessionAuthTag);
    const rocRaw = Buffer.alloc(4);
    rocRaw.writeUInt32BE(roc);

    for (const buf of buffers) {
      srtpSessionAuth.update(buf);
    }
    return srtpSessionAuth.update(rocRaw).digest().subarray(0, 10);
  }
}

const srtcpIndexSize = 4;
