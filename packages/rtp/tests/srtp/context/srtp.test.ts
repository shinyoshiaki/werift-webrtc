import { RtpHeader, RtpPacket } from "../../../src/rtp/rtp";
import { SrtpContext } from "../../../src/srtp/context/srtp";
import { SrtpAuthenticationError } from "../../../src/srtp/error";

describe("srtp/context/srtp", () => {
  function buildTestContext() {
    const masterKey = Buffer.from([
      0x0d, 0xcd, 0x21, 0x3e, 0x4c, 0xbc, 0xf2, 0x8f, 0x01, 0x7f, 0x69, 0x94,
      0x40, 0x1e, 0x28, 0x89,
    ]);
    const masterSalt = Buffer.from([
      0x62, 0x77, 0x60, 0x38, 0xc0, 0x6d, 0xc9, 0x41, 0x9f, 0x6d, 0xd9, 0x43,
      0x3e, 0x7c,
    ]);

    return new SrtpContext(masterKey, masterSalt, 1);
  }
  function tamper(buffer: Buffer, index: number, mask = 0x01) {
    const tampered = Buffer.from(buffer);
    tampered[index] ^= mask;
    return tampered;
  }
  const rtpTestCaseDecrypted = Buffer.from([
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
  ]);
  const rtpTestCases: [number, Buffer][] = [
    [
      5000,
      Buffer.from([
        0x6d, 0xd3, 0x7e, 0xd5, 0x99, 0xb7, 0x2d, 0x28, 0xb1, 0xf3, 0xa1, 0xf0,
        0xc, 0xfb, 0xfd, 0x8,
      ]),
    ],
    [
      5001,
      Buffer.from([
        0xda, 0x47, 0xb, 0x2a, 0x74, 0x53, 0x65, 0xbd, 0x2f, 0xeb, 0xdc, 0x4b,
        0x6d, 0x23, 0xf3, 0xde,
      ]),
    ],
    [
      5002,
      Buffer.from([
        0x6e, 0xa7, 0x69, 0x8d, 0x24, 0x6d, 0xdc, 0xbf, 0xec, 0x2, 0x1c, 0xd1,
        0x60, 0x76, 0xc1, 0xe,
      ]),
    ],
    [
      5003,
      Buffer.from([
        0x24, 0x7e, 0x96, 0xc8, 0x7d, 0x33, 0xa2, 0x92, 0x8d, 0x13, 0x8d, 0xe0,
        0x76, 0x9f, 0x8, 0xdc,
      ]),
    ],
    [
      5004,
      Buffer.from([
        0x75, 0x43, 0x28, 0xe4, 0x3a, 0x77, 0x59, 0x9b, 0x2e, 0xdf, 0x7b, 0x12,
        0x68, 0xb, 0x57, 0x49,
      ]),
    ],
  ];
  test("TestRTPLifecyleNewAlloc", () => {
    rtpTestCases.forEach(([sequenceNumber, encrypted]) => {
      const encryptContext = buildTestContext();
      const decryptContext = buildTestContext();

      const decryptedPkt = new RtpPacket(
        new RtpHeader({ sequenceNumber, version: 0 }),
        rtpTestCaseDecrypted,
      );
      const decryptedRaw = decryptedPkt.serialize();
      const encryptedPkt = new RtpPacket(
        new RtpHeader({ sequenceNumber, version: 0 }),
        encrypted,
      );
      const encryptedRaw = encryptedPkt.serialize();

      const actualEncrypted = encryptContext.encryptRtp(
        rtpTestCaseDecrypted,
        decryptedPkt.header,
      );
      expect(actualEncrypted).toEqual(encryptedRaw);

      const [actualDecrypted] = decryptContext.decryptRtp(encryptedRaw);
      expect(actualDecrypted).toEqual(decryptedRaw);
    });
  });

  // 意味あるかこれ？
  test("TestRTPLifecyleInPlace", () => {
    rtpTestCases.forEach(([sequenceNumber, encrypted]) => {
      const encryptContext = buildTestContext();
      const decryptContext = buildTestContext();

      const decryptPkt = new RtpPacket(
        new RtpHeader({ sequenceNumber, version: 0 }),
        rtpTestCaseDecrypted,
      );
      const decryptedRaw = decryptPkt.serialize();

      const encryptedPkt = new RtpPacket(
        new RtpHeader({ sequenceNumber, version: 0 }),
        encrypted,
      );
      const encryptedRaw = encryptedPkt.serialize();

      const actualEncrypted = encryptContext.encryptRtp(
        rtpTestCaseDecrypted,
        decryptPkt.header,
      );
      expect(actualEncrypted).toEqual(encryptedRaw);

      const decryptInput = Buffer.from(encryptedRaw);

      const [actualDecrypted, decryptHeader] =
        decryptContext.decryptRtp(decryptInput);
      expect(decryptHeader.sequenceNumber).toBe(sequenceNumber);
      expect(actualDecrypted).toEqual(decryptedRaw);
    });
  });

  test("Rejects tampered SRTP auth tag without advancing rollover state", () => {
    const encryptContext = buildTestContext();
    const decryptContext = buildTestContext();
    const ssrc = 5000;

    const beforeRolloverPacket = new RtpPacket(
      new RtpHeader({ sequenceNumber: 65535, ssrc, version: 0 }),
      rtpTestCaseDecrypted,
    );
    const rolloverPacket = new RtpPacket(
      new RtpHeader({ sequenceNumber: 0, ssrc, version: 0 }),
      rtpTestCaseDecrypted,
    );

    const encryptedBeforeRollover = encryptContext.encryptRtp(
      beforeRolloverPacket.payload,
      beforeRolloverPacket.header,
    );
    const encryptedRollover = encryptContext.encryptRtp(
      rolloverPacket.payload,
      rolloverPacket.header,
    );

    const [decryptedBeforeRollover] = decryptContext.decryptRtp(
      encryptedBeforeRollover,
    );
    expect(decryptedBeforeRollover).toEqual(beforeRolloverPacket.serialize());

    const stateBeforeFailure = {
      ...decryptContext.srtpSSRCStates[ssrc],
    };
    const tamperedAuthTag = tamper(
      encryptedRollover,
      encryptedRollover.length - 1,
    );

    expect(() => decryptContext.decryptRtp(tamperedAuthTag)).toThrowError(
      SrtpAuthenticationError,
    );
    expect(decryptContext.srtpSSRCStates[ssrc]).toEqual(stateBeforeFailure);

    const [decryptedAfterFailure] =
      decryptContext.decryptRtp(encryptedRollover);
    expect(decryptedAfterFailure).toEqual(rolloverPacket.serialize());
    expect(decryptContext.srtpSSRCStates[ssrc]).toMatchObject({
      lastSequenceNumber: 0,
      rolloverCounter: 1,
    });
  });

  test("Rejects tampered SRTP ciphertext", () => {
    const decryptContext = buildTestContext();
    const [sequenceNumber, encrypted] = rtpTestCases[0];
    const encryptedRaw = new RtpPacket(
      new RtpHeader({ sequenceNumber, version: 0 }),
      encrypted,
    ).serialize();

    expect(() =>
      decryptContext.decryptRtp(tamper(encryptedRaw, 12)),
    ).toThrowError(SrtpAuthenticationError);
  });

  test("Rejects malformed SRTP packet with oversized CSRC list", () => {
    const decryptContext = buildTestContext();
    const [sequenceNumber, encrypted] = rtpTestCases[0];
    const malformed = new RtpPacket(
      new RtpHeader({ sequenceNumber, version: 0 }),
      encrypted,
    ).serialize();
    malformed[0] = (malformed[0] & 0xf0) | 0x0f;

    expect(() => decryptContext.decryptRtp(malformed)).toThrowError(
      SrtpAuthenticationError,
    );
  });

  test("Rejects malformed SRTP packet with oversized header extension", () => {
    const decryptContext = buildTestContext();
    const [sequenceNumber, encrypted] = rtpTestCases[0];
    const malformed = new RtpPacket(
      new RtpHeader({ sequenceNumber, version: 0 }),
      encrypted,
    ).serialize();
    malformed[0] |= 0x10;
    malformed[12] = 0x00;
    malformed[13] = 0x01;
    malformed[14] = 0xff;
    malformed[15] = 0xff;

    expect(() => decryptContext.decryptRtp(malformed)).toThrowError(
      SrtpAuthenticationError,
    );
  });

  test("Does not create SRTP state for unknown SSRC when authentication fails", () => {
    const decryptContext = buildTestContext();
    const [sequenceNumber, encrypted] = rtpTestCases[0];
    const forged = new RtpPacket(
      new RtpHeader({ sequenceNumber, version: 0 }),
      encrypted,
    ).serialize();
    forged.writeUInt32BE(0x11223344, 8);

    expect(() => decryptContext.decryptRtp(forged)).toThrowError(
      SrtpAuthenticationError,
    );
    expect(decryptContext.srtpSSRCStates).toEqual({});
  });
});
