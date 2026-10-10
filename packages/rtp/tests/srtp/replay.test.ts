import {
  ProtectionProfileAeadAes128Gcm,
  ProtectionProfileAes128CmHmacSha1_80,
} from "../../src/srtp/const";
import { SrtpAuthenticationError, SrtpReplayError } from "../../src/srtp/error";
import { SrtpReplayWindow } from "../../src/srtp/replay";
import { createSrtpContextPair } from "../utils";

describe("srtp/replay (RFC 3711 §3.3.2)", () => {
  test("SrtpReplayWindow は重複と window 外の古い index を拒否する", () => {
    // Arrange: 既定 64 の window
    const window = new SrtpReplayWindow();

    // Act: 100 を受理した後、順不同の 99 と大きく進んだ 200 を受理する
    window.accept(100);
    const outOfOrder = window.check(99);
    window.accept(99);
    window.accept(200);

    // Assert: 順不同の未受信 index は通し、重複と window 外は拒否する
    expect(outOfOrder).toBe(true);
    expect(window.check(200)).toBe(false);
    expect(window.check(137)).toBe(true);
    expect(window.check(136)).toBe(false);
    expect(window.check(100)).toBe(false);
    expect(window.check(201)).toBe(true);
  });

  describe.each([
    ["AES_CM_128_HMAC_SHA1_80", ProtectionProfileAes128CmHmacSha1_80],
    ["AEAD_AES_128_GCM", ProtectionProfileAeadAes128Gcm],
  ] as const)("%s", (_name, profile) => {
    test("SRTP の再送 (replay) を拒否し、順不同の新しい packet は受理する", () => {
      // Arrange
      const pair = createSrtpContextPair(profile);
      const p10 = pair.protectRtp(10);
      const p11 = pair.protectRtp(11);
      const p9 = pair.protectRtp(9);

      // Act: 10 を受信してから同じ packet をもう一度受信する
      pair.receiver.decryptRtp(p10);
      const replay = () => pair.receiver.decryptRtp(p10);

      // Assert: replay は認証失敗系の SrtpReplayError で破棄される
      expect(replay).toThrow(SrtpReplayError);
      expect(replay).toThrow(SrtpAuthenticationError);
      // Assert: 後続と、window 内の未受信 packet は通常どおり復号できる
      expect(pair.receiver.decryptRtp(p11)[1].sequenceNumber).toBe(11);
      expect(pair.receiver.decryptRtp(p9)[1].sequenceNumber).toBe(9);
    });

    test("sequence rollover 後も ROC を含む index で replay を判定する", () => {
      // Arrange: 65534 → 65535 → 0 (ROC=1) → 1 の順に保護する
      const pair = createSrtpContextPair(profile);
      const packets = [65534, 65535, 0, 1].map((seq) => pair.protectRtp(seq));

      // Act: rollover をまたいで全件受信する
      const received = packets.map(
        (packet) => pair.receiver.decryptRtp(packet)[1].sequenceNumber,
      );

      // Assert: rollover 後の seq 0/1 は新しい index として受理される
      expect(received).toEqual([65534, 65535, 0, 1]);
      expect(pair.receiver.srtpSSRCStates[0x1234].rolloverCounter).toBe(1);
      // Assert: rollover 前 packet の再送は replay として拒否される
      expect(() => pair.receiver.decryptRtp(packets[1])).toThrow(
        SrtpReplayError,
      );
    });

    test("改ざん packet は replay window を進めない", () => {
      // Arrange
      const pair = createSrtpContextPair(profile);
      const genuine = pair.protectRtp(20);
      const tampered = Buffer.from(genuine);
      tampered[tampered.length - 1] ^= 0x01;

      // Act / Assert: 改ざん版は認証失敗 (replay ではない) で破棄される
      expect(() => pair.receiver.decryptRtp(tampered)).toThrow(
        SrtpAuthenticationError,
      );
      expect(() => pair.receiver.decryptRtp(tampered)).not.toThrow(
        SrtpReplayError,
      );
      // Assert: 同じ index の正規 packet は受理される
      expect(pair.receiver.decryptRtp(genuine)[1].sequenceNumber).toBe(20);
    });

    test("SRTCP の再送 (replay) を SRTCP index で拒否する", () => {
      // Arrange: index 1 と 2 の SRTCP packet
      const pair = createSrtpContextPair(profile);
      const first = pair.protectRtcp();
      const second = pair.protectRtcp();

      // Act: 1 件目を受信してから再送する
      pair.rtcpReceiver.decryptRTCP(first);

      // Assert: 再送は拒否し、次の index は受理する
      expect(() => pair.rtcpReceiver.decryptRTCP(first)).toThrow(
        SrtpReplayError,
      );
      expect(() => pair.rtcpReceiver.decryptRTCP(second)).not.toThrow();
    });
  });
});
