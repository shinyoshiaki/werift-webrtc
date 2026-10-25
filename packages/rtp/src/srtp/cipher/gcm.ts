import { createCipheriv, createDecipheriv } from "crypto";

import { CipherAesBase } from ".";
import { createBufferWriter } from "../../../../common/src";
import { growBufferSize } from "../../helper";
import type { RtcpHeader } from "../../rtcp/header";
import type { RtpHeader } from "../../rtp/rtp";
import { SrtpAuthenticationError } from "../error";
import {
  finalizeSrtpRtpHeader,
  parseSrtcpHeader,
  parseSrtpRtpHeader,
} from "../packet";

export class CipherAesGcm extends CipherAesBase {
  readonly aeadAuthTagLen = 16;
  readonly rtpIvWriter = createBufferWriter([2, 4, 4, 2], true);
  readonly rtcpIvWriter = createBufferWriter([2, 4, 2, 4], true);
  readonly aadWriter = createBufferWriter([4], true);

  constructor(
    srtpSessionKey: Buffer,
    srtpSessionSalt: Buffer,
    srtcpSessionKey: Buffer,
    srtcpSessionSalt: Buffer,
  ) {
    super(srtpSessionKey, srtpSessionSalt, srtcpSessionKey, srtcpSessionSalt);
  }

  encryptRtp(header: RtpHeader, payload: Buffer, rolloverCounter: number) {
    const hdr = header.serialize(header.serializeSize);

    const iv = this.rtpInitializationVector(header, rolloverCounter);

    const cipher = createCipheriv("aes-128-gcm", this.srtpSessionKey, iv);
    cipher.setAAD(hdr);
    const enc = cipher.update(payload);
    cipher.final();

    const authTag = cipher.getAuthTag();

    const dst = Buffer.concat([hdr, enc, authTag]);
    return dst;
  }

  decryptRtp(
    cipherText: Buffer,
    rolloverCounter: number,
    header = parseSrtpRtpHeader(cipherText, this.aeadAuthTagLen),
  ): [Buffer, RtpHeader] {
    const headerBuffer = cipherText.subarray(0, header.payloadOffset);
    const authTagOffset = cipherText.length - this.aeadAuthTagLen;
    const authTag = cipherText.subarray(authTagOffset);

    let dst = Buffer.from([]);
    dst = growBufferSize(dst, cipherText.length - this.aeadAuthTagLen);
    headerBuffer.copy(dst);

    const iv = this.rtpInitializationVector(header, rolloverCounter);

    const enc = cipherText.slice(header.payloadOffset, authTagOffset);

    const decipher = createDecipheriv("aes-128-gcm", this.srtpSessionKey, iv);
    decipher.setAAD(headerBuffer);
    decipher.setAuthTag(authTag);
    const dec = decipher.update(enc);
    finalizeAuthenticatedDecryption(decipher, "SRTP");

    dec.copy(dst, header.payloadOffset);

    return [
      dst,
      finalizeSrtpRtpHeader(header, dst, "Failed to authenticate SRTP packet"),
    ];
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
    const header = parseSrtcpHeader(
      encrypted,
      this.aeadAuthTagLen,
      srtcpIndexSize,
    );
    const srtcpIndexOffset = encrypted.length - srtcpIndexSize;
    const authTagOffset = srtcpIndexOffset - this.aeadAuthTagLen;

    const ssrc = encrypted.readUInt32BE(4);
    const encodedSrtcpIndex = encrypted.readUInt32BE(srtcpIndexOffset);
    const isEncrypted = encodedSrtcpIndex >>> 31 === 1;
    const srtcpIndex = encodedSrtcpIndex & ~(rtcpEncryptionFlag << 24);

    const iv = this.rtcpInitializationVector(ssrc, srtcpIndex);
    const aad = isEncrypted
      ? Buffer.concat([
          encrypted.subarray(0, 8),
          encrypted.subarray(srtcpIndexOffset),
        ])
      : Buffer.concat([
          encrypted.subarray(0, authTagOffset),
          encrypted.subarray(srtcpIndexOffset),
        ]);
    const cipherText = isEncrypted
      ? encrypted.slice(8, authTagOffset)
      : Buffer.alloc(0);
    const dst = isEncrypted
      ? Buffer.alloc(authTagOffset)
      : Buffer.from(encrypted.subarray(0, authTagOffset));
    if (isEncrypted) {
      encrypted.slice(0, 8).copy(dst);
    }

    const decipher = createDecipheriv("aes-128-gcm", this.srtcpSessionKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(encrypted.subarray(authTagOffset, srtcpIndexOffset));
    const dec = decipher.update(cipherText);
    finalizeAuthenticatedDecryption(decipher, "SRTCP");

    if (isEncrypted) {
      dec.copy(dst, 8);
    }

    return [dst, header];
  }

  // https://tools.ietf.org/html/rfc7714#section-8.1
  private rtpInitializationVector(header: RtpHeader, rolloverCounter: number) {
    const iv = this.rtpIvWriter([
      0,
      header.ssrc,
      rolloverCounter,
      header.sequenceNumber,
    ]);
    for (let i = 0; i < iv.length; i++) {
      iv[i] ^= this.srtpSessionSalt[i];
    }
    return iv;
  }

  // https://tools.ietf.org/html/rfc7714#section-9.1
  private rtcpInitializationVector(ssrc: number, srtcpIndex: number) {
    const iv = this.rtcpIvWriter([0, ssrc, 0, srtcpIndex]);
    for (let i = 0; i < iv.length; i++) {
      iv[i] ^= this.srtcpSessionSalt[i];
    }
    return iv;
  }

  // https://datatracker.ietf.org/doc/html/rfc7714#section-17
  private rtcpAdditionalAuthenticatedData(
    rtcpPacket: Buffer,
    srtcpIndex: number,
  ) {
    const aad = Buffer.concat([
      rtcpPacket.subarray(0, 8),
      this.aadWriter([srtcpIndex]),
    ]);
    aad[8] |= rtcpEncryptionFlag;
    return aad;
  }
}

const srtcpIndexSize = 4;
const rtcpEncryptionFlag = 0x80;

function finalizeAuthenticatedDecryption(
  decipher: ReturnType<typeof createDecipheriv>,
  packetType: "SRTP" | "SRTCP",
) {
  try {
    decipher.final();
  } catch {
    throw new SrtpAuthenticationError(
      `Failed to authenticate ${packetType} packet`,
    );
  }
}
