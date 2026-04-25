import { createCipheriv } from "crypto";

import { RtpPacket } from "../../../src";
import { RtpHeader } from "../../../src/rtp/rtp";
import { ProtectionProfileAeadAes128Gcm } from "../../../src/srtp/const";
import { Context } from "../../../src/srtp/context/context";
import { SrtcpContext } from "../../../src/srtp/context/srtcp";
import { SrtpContext } from "../../../src/srtp/context/srtp";
import { SrtpAuthenticationError } from "../../../src/srtp/error";

describe("packages/rtp/tests/srtp/cipher/gcm.test.ts", () => {
  function tamper(buffer: Buffer, index: number, mask = 0x01) {
    const tampered = Buffer.from(buffer);
    tampered[index] ^= mask;
    return tampered;
  }

  const masterKey = Buffer.from([
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
    0x0c, 0x0d, 0x0e, 0x0f,
  ]);
  const masterSalt = Buffer.from([
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab,
  ]);
  const decryptedRTPPacket = Buffer.from([
    0x80, 0x0f, 0x12, 0x34, 0xde, 0xca, 0xfb, 0xad, 0xca, 0xfe, 0xba, 0xbe,
    0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab,
    0xab, 0xab, 0xab, 0xab,
  ]);
  const encryptedRTPPacket = Buffer.from([
    0x80, 0x0f, 0x12, 0x34, 0xde, 0xca, 0xfb, 0xad, 0xca, 0xfe, 0xba, 0xbe,
    0xc5, 0x00, 0x2e, 0xde, 0x04, 0xcf, 0xdd, 0x2e, 0xb9, 0x11, 0x59, 0xe0,
    0x88, 0x0a, 0xa0, 0x6e, 0xd2, 0x97, 0x68, 0x26, 0xf7, 0x96, 0xb2, 0x01,
    0xdf, 0x31, 0x31, 0xa1, 0x27, 0xe8, 0xa3, 0x92,
  ]);
  const decryptedRtcpPacket = Buffer.from([
    0x81, 0xc8, 0x00, 0x0b, 0xca, 0xfe, 0xba, 0xbe, 0xab, 0xab, 0xab, 0xab,
    0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab,
  ]);
  const encryptedRtcpPacket = Buffer.from([
    0x81, 0xc8, 0x00, 0x0b, 0xca, 0xfe, 0xba, 0xbe, 0xc9, 0x8b, 0x8b, 0x5d,
    0xf0, 0x39, 0x2a, 0x55, 0x85, 0x2b, 0x6c, 0x21, 0xac, 0x8e, 0x70, 0x25,
    0xc5, 0x2c, 0x6f, 0xbe, 0xa2, 0xb3, 0xb4, 0x46, 0xea, 0x31, 0x12, 0x3b,
    0xa8, 0x8c, 0xe6, 0x1e, 0x80, 0x00, 0x00, 0x01,
  ]);

  test("Encrypt RTP", () => {
    const ctx = new SrtpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );

    const rtp = RtpPacket.deSerialize(decryptedRTPPacket);

    const encrypted = ctx.encryptRtp(rtp.payload, rtp.header);
    expect(encrypted).toEqual(encryptedRTPPacket);
  });

  test("Decrypt RTP", () => {
    const ctx = new SrtpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );

    const [dec] = ctx.decryptRtp(encryptedRTPPacket);
    expect(dec).toEqual(decryptedRTPPacket);
  });

  test("Encrypt RTCP", () => {
    const ctx = new SrtcpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );

    const encrypted = ctx.encryptRTCP(decryptedRtcpPacket);
    expect(encrypted).toEqual(encryptedRtcpPacket);
  });

  test("Decrypt RTCP", () => {
    const ctx = new SrtcpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );

    const [dec] = ctx.decryptRTCP(encryptedRtcpPacket);
    expect(dec).toEqual(decryptedRtcpPacket);
  });

  test("Rejects RTP auth tag tampering and keeps receiving valid packets", () => {
    const ctx = new SrtpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );

    expect(() =>
      ctx.decryptRtp(tamper(encryptedRTPPacket, encryptedRTPPacket.length - 1)),
    ).toThrowError(SrtpAuthenticationError);

    const [dec] = ctx.decryptRtp(encryptedRTPPacket);
    expect(dec).toEqual(decryptedRTPPacket);
  });

  test("Rejects RTP ciphertext tampering", () => {
    const ctx = new SrtpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );

    expect(() => ctx.decryptRtp(tamper(encryptedRTPPacket, 12))).toThrowError(
      SrtpAuthenticationError,
    );
  });

  test("Rejects RTP header tampering covered by AAD", () => {
    const ctx = new SrtpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );

    expect(() => ctx.decryptRtp(tamper(encryptedRTPPacket, 1))).toThrowError(
      SrtpAuthenticationError,
    );
  });

  test("Rejects malformed RTP packet with oversized CSRC list", () => {
    const ctx = new SrtpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );
    const malformed = Buffer.from(encryptedRTPPacket);
    malformed[0] = (malformed[0] & 0xf0) | 0x0f;

    expect(() => ctx.decryptRtp(malformed)).toThrowError(
      SrtpAuthenticationError,
    );
  });

  test("Rejects malformed RTP packet with oversized header extension", () => {
    const ctx = new SrtpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );
    const malformed = Buffer.from(encryptedRTPPacket);
    malformed[0] |= 0x10;
    malformed[12] = 0x00;
    malformed[13] = 0x01;
    malformed[14] = 0xff;
    malformed[15] = 0xff;

    expect(() => ctx.decryptRtp(malformed)).toThrowError(
      SrtpAuthenticationError,
    );
  });

  test("Does not create SRTP state for unknown SSRC when authentication fails", () => {
    const ctx = new SrtpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );
    const forged = Buffer.from(encryptedRTPPacket);
    forged.writeUInt32BE(0x11223344, 8);

    expect(() => ctx.decryptRtp(forged)).toThrowError(SrtpAuthenticationError);
    expect(ctx.srtpSSRCStates).toEqual({});
  });

  test("Decrypts padded SRTP packets without treating the auth tag as pad count", () => {
    const encryptContext = new SrtpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );
    const decryptContext = new SrtpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );
    const header = new RtpHeader({
      sequenceNumber: 0x1234,
      timestamp: 0xdecafbad,
      ssrc: 0xcafebabe,
      payloadType: 15,
      version: 2,
      padding: true,
      paddingSize: 4,
    });
    const payload = Buffer.from([
      0xab, 0xab, 0xab, 0xab, 0x00, 0x00, 0x00, 0x04,
    ]);
    const expected = Buffer.from([
      0xa0, 0x0f, 0x12, 0x34, 0xde, 0xca, 0xfb, 0xad, 0xca, 0xfe, 0xba, 0xbe,
      0xab, 0xab, 0xab, 0xab, 0x00, 0x00, 0x00, 0x04,
    ]);

    const encrypted = encryptContext.encryptRtp(payload, header);
    const [decrypted] = decryptContext.decryptRtp(encrypted);

    expect(decrypted).toEqual(expected);
    expect(RtpPacket.deSerialize(decrypted).payload).toEqual(
      Buffer.from([0xab, 0xab, 0xab, 0xab]),
    );
  });

  test("Rejects RTCP E-bit tampering covered by AAD", () => {
    const ctx = new SrtcpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );
    const tamperedEncryptionFlag = Buffer.from(encryptedRtcpPacket);
    tamperedEncryptionFlag[encryptedRtcpPacket.length - 4] &= 0x7f;

    expect(() => ctx.decryptRTCP(tamperedEncryptionFlag)).toThrowError(
      SrtpAuthenticationError,
    );
  });

  test("Rejects RTCP index tampering covered by AAD", () => {
    const ctx = new SrtcpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );
    const tamperedIndex = tamper(
      encryptedRtcpPacket,
      encryptedRtcpPacket.length - 1,
    );

    expect(() => ctx.decryptRTCP(tamperedIndex)).toThrowError(
      SrtpAuthenticationError,
    );
  });

  test("Rejects short RTCP packet as authentication failure", () => {
    const ctx = new SrtcpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );

    expect(() => ctx.decryptRTCP(Buffer.from([0x81, 0xc8]))).toThrowError(
      SrtpAuthenticationError,
    );
  });

  test("Decrypts unencrypted AEAD SRTCP packets with E-bit cleared", () => {
    const ctx = new SrtcpContext(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );
    const packet = createUnencryptedAeadSrtcpPacket(decryptedRtcpPacket, 1);

    const [dec] = ctx.decryptRTCP(packet);

    expect(dec).toEqual(decryptedRtcpPacket);
  });

  function createUnencryptedAeadSrtcpPacket(
    rtcpPacket: Buffer,
    srtcpIndex: number,
  ) {
    const context = new Context(
      masterKey,
      masterSalt,
      ProtectionProfileAeadAes128Gcm,
    );
    const ssrc = rtcpPacket.readUInt32BE(4);
    const encodedIndex = Buffer.alloc(4);
    encodedIndex.writeUInt32BE(srtcpIndex);

    const iv = Buffer.from([
      0x00,
      0x00,
      (ssrc >>> 24) & 0xff,
      (ssrc >>> 16) & 0xff,
      (ssrc >>> 8) & 0xff,
      ssrc & 0xff,
      0x00,
      0x00,
      (srtcpIndex >>> 24) & 0xff,
      (srtcpIndex >>> 16) & 0xff,
      (srtcpIndex >>> 8) & 0xff,
      srtcpIndex & 0xff,
    ]);
    for (let i = 0; i < iv.length; i++) {
      iv[i] ^= context.srtcpSessionSalt[i];
    }

    const cipher = createCipheriv("aes-128-gcm", context.srtcpSessionKey, iv);
    cipher.setAAD(Buffer.concat([rtcpPacket, encodedIndex]));
    cipher.final();

    return Buffer.concat([rtcpPacket, cipher.getAuthTag(), encodedIndex]);
  }
});
