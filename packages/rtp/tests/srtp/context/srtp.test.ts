import { RtpHeader, RtpPacket } from "../../../src/rtp/rtp";
import { SrtpContext } from "../../../src/srtp/context/srtp";

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
});
