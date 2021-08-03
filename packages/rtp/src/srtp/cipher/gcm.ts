import { createCipheriv, createDecipheriv } from "crypto";
import { range } from "lodash";

import { bufferWriter } from "../../../../common/src";
import { growBufferSize } from "../../helper";
import { RtcpHeader } from "../../rtcp/header";
import { RtpHeader } from "../../rtp/rtp";
import { CipherAesBase } from ".";

export class CipherAesGcm extends CipherAesBase {
  readonly aeadAuthTagLen = 16;

  constructor(
    srtpSessionKey: Buffer,
    srtpSessionSalt: Buffer,
    srtcpSessionKey: Buffer,
    srtcpSessionSalt: Buffer
  ) {
    super(srtpSessionKey, srtpSessionSalt, srtcpSessionKey, srtcpSessionSalt);
  }

  encryptRtp(header: RtpHeader, payload: Buffer, rolloverCounter: number) {
    const dst = Buffer.alloc(
      header.serializeSize + payload.length + this.aeadAuthTagLen
    );
    const hdr = header.serialize(header.serializeSize);
    hdr.copy(dst);

    const { payloadOffset } = header;

    const iv = this.rtpInitializationVector(header, rolloverCounter);

    const cipher = createCipheriv("aes-128-gcm", this.srtpSessionKey, iv);
    cipher.setAAD(hdr);
    const enc = cipher.update(payload);
    cipher.final();
    enc.copy(dst, payloadOffset);

    const authTag = cipher.getAuthTag();
    authTag.copy(dst, payloadOffset + enc.length);

    return dst;
  }

  decryptRtp(cipherText: Buffer, rolloverCounter: number): [Buffer, RtpHeader] {
    const header = RtpHeader.deSerialize(cipherText);

    let dst = Buffer.from([]);
    dst = growBufferSize(dst, cipherText.length - this.aeadAuthTagLen);
    cipherText.slice(0, header.payloadOffset).copy(dst);

    const iv = this.rtpInitializationVector(header, rolloverCounter);

    const enc = cipherText.slice(
      header.payloadOffset,
      cipherText.length - this.aeadAuthTagLen
    );

    const cipher = createDecipheriv("aes-128-gcm", this.srtpSessionKey, iv);
    const dec = cipher.update(enc);

    dec.copy(dst, header.payloadOffset);

    return [dst, header];
  }

  encryptRTCP(rtcpPacket: Buffer, srtcpIndex: number): Buffer {
    const ssrc = rtcpPacket.readUInt32BE(4);

    const addPos = rtcpPacket.length + this.aeadAuthTagLen;
    let dst = Buffer.from([]);
    dst = growBufferSize(dst, addPos + srtcpIndexSize);
    rtcpPacket.slice(0, 8).copy(dst);

    const iv = this.rtcpInitializationVector(ssrc, srtcpIndex);
    const aad = this.rtcpAdditionalAuthenticatedData(rtcpPacket, srtcpIndex);

    const cipher = createCipheriv("aes-128-gcm", this.srtcpSessionKey, iv);
    cipher.setAAD(aad);
    const enc = cipher.update(rtcpPacket.slice(8));
    cipher.final();
    enc.copy(dst, 8);

    const authTag = cipher.getAuthTag();
    authTag.copy(dst, 8 + enc.length);
    aad.slice(8, 12).copy(dst, addPos);

    return dst;
  }

  decryptRTCP(encrypted: Buffer): [Buffer, RtcpHeader] {
    const header = RtcpHeader.deSerialize(encrypted);
    const aadPos = encrypted.length - srtcpIndexSize;

    const dst = Buffer.alloc(aadPos - this.aeadAuthTagLen);
    encrypted.slice(0, 8).copy(dst);

    const ssrc = encrypted.readUInt32BE(4);

    let srtcpIndex = encrypted.readUInt32BE(encrypted.length - 4);
    srtcpIndex &= ~(rtcpEncryptionFlag << 24);

    const iv = this.rtcpInitializationVector(ssrc, srtcpIndex);
    const aad = this.rtcpAdditionalAuthenticatedData(encrypted, srtcpIndex);

    const cipher = createDecipheriv("aes-128-gcm", this.srtcpSessionKey, iv);
    cipher.setAAD(aad);
    const dec = cipher.update(encrypted.slice(8, aadPos));

    dec.copy(dst, 8);

    return [dst, header];
  }

  // https://tools.ietf.org/html/rfc7714#section-8.1
  private rtpInitializationVector(header: RtpHeader, rolloverCounter: number) {
    const iv = bufferWriter(
      [2, 4, 4, 2],
      [0, header.ssrc, rolloverCounter, header.sequenceNumber]
    );
    range(0, iv.length).forEach((i) => {
      iv[i] = iv[i] ^ this.srtpSessionSalt[i];
    });
    return iv;
  }

  // https://tools.ietf.org/html/rfc7714#section-9.1
  private rtcpInitializationVector(ssrc: number, srtcpIndex: number) {
    const iv = bufferWriter([2, 4, 2, 4], [0, ssrc, 0, srtcpIndex]);
    range(0, iv.length).forEach((i) => {
      iv[i] = iv[i] ^ this.srtcpSessionSalt[i];
    });
    return iv;
  }

  // https://datatracker.ietf.org/doc/html/rfc7714#section-17
  private rtcpAdditionalAuthenticatedData(
    rtcpPacket: Buffer,
    srtcpIndex: number
  ) {
    const aad = Buffer.concat([
      rtcpPacket.slice(0, 8),
      bufferWriter([4], [srtcpIndex]),
    ]);
    aad[8] |= rtcpEncryptionFlag;
    return aad;
  }
}

const srtcpIndexSize = 4;
const rtcpEncryptionFlag = 0x80;
