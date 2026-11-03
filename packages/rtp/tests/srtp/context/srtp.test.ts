import { RtpHeader, RtpPacket } from "../../../src/rtp/rtp";
import { ProtectionProfileAes128CmHmacSha1_80 } from "../../../src/srtp/const";
import { SrtpRolloverCounterOverflowError } from "../../../src/srtp/context/context";
import { SrtpAuthenticationError } from "../../../src/srtp/error";
import {
  createSrtpContextPair,
  createSrtpTestContext,
  decryptSrtpSequence,
  encryptSrtpSequence,
  sequenceRange,
  tamperBuffer,
} from "../../utils";

describe("srtp/context/srtp", () => {
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
      const encryptContext = createSrtpTestContext();
      const decryptContext = createSrtpTestContext();

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
      const encryptContext = createSrtpTestContext();
      const decryptContext = createSrtpTestContext();

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
    const encryptContext = createSrtpTestContext();
    const decryptContext = createSrtpTestContext();
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
    const tamperedAuthTag = tamperBuffer(
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
    const decryptContext = createSrtpTestContext();
    const [sequenceNumber, encrypted] = rtpTestCases[0];
    const encryptedRaw = new RtpPacket(
      new RtpHeader({ sequenceNumber, version: 0 }),
      encrypted,
    ).serialize();

    expect(() =>
      decryptContext.decryptRtp(tamperBuffer(encryptedRaw, 12)),
    ).toThrowError(SrtpAuthenticationError);
  });

  test("Rejects malformed SRTP packet with oversized CSRC list", () => {
    const decryptContext = createSrtpTestContext();
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
    const decryptContext = createSrtpTestContext();
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
    const decryptContext = createSrtpTestContext();
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

  test("Decrypts padded SRTP packets without reading pad count before authentication", () => {
    const encryptContext = createSrtpTestContext();
    const decryptContext = createSrtpTestContext();
    const header = new RtpHeader({
      sequenceNumber: 5000,
      ssrc: 1,
      version: 2,
      padding: true,
      paddingSize: 4,
    });
    const payload = Buffer.from([
      0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x04,
    ]);
    const expected = new RtpPacket(
      new RtpHeader({
        sequenceNumber: 5000,
        ssrc: 1,
        version: 2,
        padding: true,
        paddingSize: 4,
      }),
      Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    ).serialize();

    const encrypted = encryptContext.encryptRtp(payload, header);
    const [decrypted] = decryptContext.decryptRtp(encrypted);

    expect(decrypted).toEqual(expected);
    expect(RtpPacket.deSerialize(decrypted).payload).toEqual(
      Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    );
  });

  describe("rollover with retransmission and reordering (AES-128-CM/HMAC-SHA1)", () => {
    test("A: receiver decrypts retransmitted seq 0 and following packets", () => {
      // Arrange
      const { sender, receiver } = createSrtpContextPair(
        ProtectionProfileAes128CmHmacSha1_80,
      );
      const packets = encryptSrtpSequence(sender, [
        65534,
        65535,
        ...sequenceRange(0, 151),
        0,
        152,
      ]);

      // Act: 再送を含む全パケットを順に復号する
      const results = decryptSrtpSequence(
        receiver,
        packets.map((p) => p.encrypted),
      );

      // Assert: 全パケットが認証・復号に成功し、元の RTP と一致する
      expect(results.filter((r) => !r.ok)).toEqual([]);
      results.forEach((r, i) => {
        expect(r.ok && r.decrypted).toEqual(packets[i].plain);
      });
      // Assert: 受信側の最高 index は (1, 152)
      expect(receiver.srtpSSRCStates[5000]).toMatchObject({
        rolloverCounter: 1,
        lastSequenceNumber: 152,
      });
    });

    test("B: receiver decrypts late retransmission of 65535 and following packets", () => {
      // Arrange
      const { sender, receiver } = createSrtpContextPair(
        ProtectionProfileAes128CmHmacSha1_80,
      );
      const packets = encryptSrtpSequence(sender, [
        65534,
        65535,
        ...sequenceRange(0, 99),
        65535,
        ...sequenceRange(100, 120),
      ]);

      // Act
      const results = decryptSrtpSequence(
        receiver,
        packets.map((p) => p.encrypted),
      );

      // Assert: 再送 65535 も後続 100.. も全て復号できる
      expect(results.filter((r) => !r.ok)).toEqual([]);
      expect(receiver.srtpSSRCStates[5000]).toMatchObject({
        rolloverCounter: 1,
        lastSequenceNumber: 120,
      });
    });

    test("C: network reordering of 65535 after wrap does not stall the receiver", () => {
      // Arrange: 65535 だけ 99 の後に遅れて届くように並べ替える
      const { sender, receiver } = createSrtpContextPair(
        ProtectionProfileAes128CmHmacSha1_80,
      );
      const packets = encryptSrtpSequence(sender, [
        65534,
        65535,
        ...sequenceRange(0, 200),
      ]);
      const delayed = packets[1];
      const reordered = [
        packets[0],
        ...packets.slice(2, 102),
        delayed,
        ...packets.slice(102),
      ];

      // Act
      const results = decryptSrtpSequence(
        receiver,
        reordered.map((p) => p.encrypted),
      );

      // Assert: 遅延パケットと後続のどちらも復号できる
      expect(results.filter((r) => !r.ok)).toEqual([]);
      expect(results[101].ok && results[101].decrypted).toEqual(delayed.plain);
      // Assert: 最高 index は遅延パケットで後退していない
      expect(receiver.srtpSSRCStates[5000]).toMatchObject({
        rolloverCounter: 1,
        lastSequenceNumber: 200,
      });
    });

    test("tampered retransmission is rejected without changing receiver state", () => {
      // Arrange
      const { sender, receiver } = createSrtpContextPair(
        ProtectionProfileAes128CmHmacSha1_80,
      );
      const packets = encryptSrtpSequence(sender, [
        65535,
        ...sequenceRange(0, 120),
        0,
        121,
      ]);
      const retransmission = packets.at(-2)!.encrypted;
      decryptSrtpSequence(
        receiver,
        packets.slice(0, -2).map((p) => p.encrypted),
      );
      const stateBefore = { ...receiver.srtpSSRCStates[5000] };

      // Act / Assert: 改ざんした再送は認証エラーになる
      expect(() =>
        receiver.decryptRtp(
          tamperBuffer(retransmission, retransmission.length - 1),
        ),
      ).toThrowError(SrtpAuthenticationError);
      // Assert: 最高 index は変わらない
      expect(receiver.srtpSSRCStates[5000]).toEqual(stateBefore);

      // Act: 正しい再送と後続パケットを復号する
      const results = decryptSrtpSequence(receiver, [
        retransmission,
        packets.at(-1)!.encrypted,
      ]);

      // Assert: どちらも復号できる
      expect(results.map((r) => r.ok)).toEqual([true, true]);
    });

    test("rejects decrypt beyond ROC=0xFFFFFFFF as authentication failure", () => {
      // Arrange: 送信側は seq 65535 で、受信側は ROC 上限の状態にする
      const { sender, receiver } = createSrtpContextPair(
        ProtectionProfileAes128CmHmacSha1_80,
      );
      const [packet] = encryptSrtpSequence(sender, [0]);
      receiver.srtpSSRCStates[5000] = {
        ssrc: 5000,
        rolloverCounter: 0xffffffff,
        lastSequenceNumber: 65535,
        rolloverHasProcessed: true,
      };

      // Act / Assert: 受信経路をクラッシュさせず認証エラーとして拒否する
      expect(() => receiver.decryptRtp(packet.encrypted)).toThrowError(
        SrtpAuthenticationError,
      );
    });

    test("rejects encrypt beyond ROC=0xFFFFFFFF", () => {
      // Arrange
      const { sender } = createSrtpContextPair(
        ProtectionProfileAes128CmHmacSha1_80,
      );
      sender.srtpSSRCStates[5000] = {
        ssrc: 5000,
        rolloverCounter: 0xffffffff,
        lastSequenceNumber: 65535,
        rolloverHasProcessed: true,
      };

      // Act / Assert: cipher の例外ではなく明示的なエラーで拒否する
      expect(() => encryptSrtpSequence(sender, [0])).toThrowError(
        SrtpRolloverCounterOverflowError,
      );
    });
  });
});
