import type { CipherAesCtr } from "../../../src/srtp/cipher/ctr";
import { ProtectionProfileAes128CmHmacSha1_80 } from "../../../src/srtp/const";
import {
  aes128EcbEncrypt,
  Context,
  SrtpRolloverCounterOverflowError,
  type SrtpSsrcState,
} from "../../../src/srtp/context/context";
import {
  createRolloverTestContext,
  type RolloverStep,
  runRolloverSequence,
  sequenceRange,
} from "../../utils";

describe("srtp/context", () => {
  test("TestValidSessionKeys", () => {
    const masterKey = Buffer.from([
      0xe1, 0xf9, 0x7a, 0x0d, 0x3e, 0x01, 0x8b, 0xe0, 0xd6, 0x4f, 0xa3, 0x2c,
      0x06, 0xde, 0x41, 0x39,
    ]);
    const masterSalt = Buffer.from([
      0x0e, 0xc6, 0x75, 0xad, 0x49, 0x8a, 0xfe, 0xeb, 0xb6, 0x96, 0x0b, 0x3a,
      0xab, 0xe6,
    ]);

    const expectedSessionKey = Buffer.from([
      0xc6, 0x1e, 0x7a, 0x93, 0x74, 0x4f, 0x39, 0xee, 0x10, 0x73, 0x4a, 0xfe,
      0x3f, 0xf7, 0xa0, 0x87,
    ]);
    const expectedSessionSalt = Buffer.from([
      0x30, 0xcb, 0xbc, 0x08, 0x86, 0x3d, 0x8c, 0x85, 0xd4, 0x9d, 0xb3, 0x4a,
      0x9a, 0xe1,
    ]);
    const expectedSessionAuthTag = Buffer.from([
      0xce, 0xbe, 0x32, 0x1f, 0x6f, 0xf7, 0x71, 0x6b, 0x6f, 0xd4, 0xab, 0x49,
      0xaf, 0x25, 0x6a, 0x15, 0x6d, 0x38, 0xba, 0xa4,
    ]);

    const c = new Context(
      masterKey,
      masterSalt,
      ProtectionProfileAes128CmHmacSha1_80,
    );

    const sessionKey = c.generateSessionKey(0x00);
    expect(sessionKey).toEqual(expectedSessionKey);

    const sessionSalt = c.generateSessionSalt(2);
    expect(sessionSalt).toEqual(expectedSessionSalt);

    const sessionAuthTag = c.generateSessionAuthTag(1);
    expect(sessionAuthTag).toEqual(expectedSessionAuthTag);
  });

  test("aes128EcbEncrypt does not add padding and encrypts 16-byte block", () => {
    // Arrange: RFC 由来の master key と 16 byte plaintext
    const key = Buffer.from([
      0xe1, 0xf9, 0x7a, 0x0d, 0x3e, 0x01, 0x8b, 0xe0, 0xd6, 0x4f, 0xa3, 0x2c,
      0x06, 0xde, 0x41, 0x39,
    ]);
    const plaintext = Buffer.from([
      0x0e, 0xc6, 0x75, 0xad, 0x49, 0x8a, 0xfe, 0xeb, 0xb6, 0x96, 0x0b, 0x3a,
      0xab, 0xe6, 0x00, 0x00,
    ]);

    // Act: padding なしで AES-ECB 1 block を暗号化する
    const ciphertext = aes128EcbEncrypt(key, plaintext);

    // Assert: 出力も 16 byte で、既知 session key と一致すること
    expect(ciphertext.length).toBe(16);
    expect(ciphertext).toEqual(
      Buffer.from([
        0xc6, 0x1e, 0x7a, 0x93, 0x74, 0x4f, 0x39, 0xee, 0x10, 0x73, 0x4a, 0xfe,
        0x3f, 0xf7, 0xa0, 0x87,
      ]),
    );
  });

  test("TestValidPacketCounter", () => {
    const masterKey = Buffer.from([
      0x0d, 0xcd, 0x21, 0x3e, 0x4c, 0xbc, 0xf2, 0x8f, 0x01, 0x7f, 0x69, 0x94,
      0x40, 0x1e, 0x28, 0x89,
    ]);
    const masterSalt = Buffer.from([
      0x62, 0x77, 0x60, 0x38, 0xc0, 0x6d, 0xc9, 0x41, 0x9f, 0x6d, 0xd9, 0x43,
      0x3e, 0x7c,
    ]);
    const c = new Context(
      masterKey,
      masterSalt,
      ProtectionProfileAes128CmHmacSha1_80,
    );
    const expectedCounter = Buffer.from([
      0xcf, 0x90, 0x1e, 0xa5, 0xda, 0xd3, 0x2c, 0x15, 0x00, 0xa2, 0x24, 0xae,
      0xae, 0xaf, 0x00, 0x00,
    ]);

    const counter = (c.cipher as CipherAesCtr).generateCounter(
      32846,
      0,
      4160032510,
      c.srtpSessionSalt,
    );
    expect(counter).toEqual(expectedCounter);
  });

  // 旧実装は「直前に処理した seq」との ±100 比較で共有 ROC を増減させていたため、
  // NACK 再送や順不同パケットで後続パケットの ROC がずれ続けていた (#764)。
  // 以下は RFC 3711 Appendix A に従い「パケットごとの推定 ROC」と
  // 「最高 index (ROC, s_l)」を区別して検証する。
  describe("rollover counter (RFC 3711 Appendix A)", () => {
    const at = (steps: RolloverStep[], index: number) =>
      steps[index < 0 ? steps.length + index : index];

    test("A: retransmitted seq 0 after wrap keeps ROC=1 for itself and later packets", () => {
      // Arrange
      const { context, state } = createRolloverTestContext();
      const sequence = [65534, 65535, ...sequenceRange(0, 151), 0, 152];

      // Act: 折り返し後に seq 0 を再送し、続けて 152 を処理する
      const steps = runRolloverSequence(context, state, sequence);

      // Assert: 再送 0 と 152 はどちらも ROC=1 (旧実装では 2 になっていた)
      expect(at(steps, -2)).toMatchObject({ sequenceNumber: 0, roc: 1 });
      expect(at(steps, -1)).toMatchObject({ sequenceNumber: 152, roc: 1 });
      // Assert: 再送で最高 index は後退も二重加算もしない
      expect(at(steps, -2).highest).toEqual({
        rolloverCounter: 1,
        lastSequenceNumber: 151,
      });
      expect(state).toMatchObject({
        rolloverCounter: 1,
        lastSequenceNumber: 152,
      });
    });

    test("A: next wrap after retransmission reaches ROC=2 (not 3)", () => {
      // Arrange
      const { context, state } = createRolloverTestContext();
      runRolloverSequence(context, state, [
        65534,
        65535,
        ...sequenceRange(0, 151),
        0,
      ]);

      // Act: 次の折り返しまで連続して進める
      const steps = runRolloverSequence(context, state, [
        ...sequenceRange(152, 65535),
        0,
      ]);

      // Assert: 折り返し直前は ROC=1、折り返し後は ROC=2
      expect(at(steps, -2)).toMatchObject({ sequenceNumber: 65535, roc: 1 });
      expect(at(steps, -1)).toMatchObject({ sequenceNumber: 0, roc: 2 });
    });

    test("B: late retransmission of 65535 uses ROC=0 and later packets stay ROC=1", () => {
      // Arrange
      const { context, state } = createRolloverTestContext();
      const sequence = [65534, 65535, ...sequenceRange(0, 99), 65535, 100];

      // Act
      const steps = runRolloverSequence(context, state, sequence);

      // Assert: 再送 65535 は前周 (ROC=0)
      expect(at(steps, -2)).toMatchObject({ sequenceNumber: 65535, roc: 0 });
      // Assert: 最高 index は後退しない
      expect(at(steps, -2).highest).toEqual({
        rolloverCounter: 1,
        lastSequenceNumber: 99,
      });
      // Assert: 後続の 100 は ROC=1 (旧実装では 0 のままだった)
      expect(at(steps, -1)).toMatchObject({ sequenceNumber: 100, roc: 1 });
    });

    test("out-of-order and duplicate packets keep ROC and advance highest index correctly", () => {
      // Arrange
      const { context, state } = createRolloverTestContext();

      // Act
      const steps = runRolloverSequence(context, state, [10, 12, 11, 11, 13]);

      // Assert: 全パケット ROC=0
      expect(steps.map((s) => s.roc)).toEqual([0, 0, 0, 0, 0]);
      // Assert: 古い 11 や重複 11 で最高 index は変わらず、13 で進む
      expect(steps.map((s) => s.highest.lastSequenceNumber)).toEqual([
        10, 12, 12, 12, 13,
      ]);
    });

    test("first packet with high seq wraps to ROC=1 on seq 0", () => {
      // Arrange
      const { context, state } = createRolloverTestContext();

      // Act
      const steps = runRolloverSequence(context, state, [65535, 0]);

      // Assert: 初回 65535 は ROC=0、次の 0 は ROC=1
      expect(steps.map((s) => s.roc)).toEqual([0, 1]);
      expect(state).toMatchObject({
        rolloverCounter: 1,
        lastSequenceNumber: 0,
      });
    });

    test("first packet seq 0: previous-cycle 65535 is clamped to ROC=0 and not committed", () => {
      // 旧テスト `0 → 65535 → 1` は 1 で ROC=1 を期待していたが、
      // 65535 は前周 (ROC=-1) の遅延パケットなので 1 は ROC=0 が正しい。
      // Arrange
      const { context, state } = createRolloverTestContext();

      // Act
      const steps = runRolloverSequence(context, state, [0, 65535, 1]);

      // Assert: 65535 は ROC=0 に丸められ、最高 index は (0, 0) のまま
      expect(steps[1]).toEqual({
        sequenceNumber: 65535,
        roc: 0,
        highest: { rolloverCounter: 0, lastSequenceNumber: 0 },
      });
      // Assert: 続く 1 は ROC=0 で最高 index が進む
      expect(steps[2]).toEqual({
        sequenceNumber: 1,
        roc: 0,
        highest: { rolloverCounter: 0, lastSequenceNumber: 1 },
      });
    });

    test("late packet from previous cycle uses packet ROC=0 while stored ROC stays 1", () => {
      // 旧テストは `65530 → 0 → 65530` で保存 ROC が 0 に戻ることを期待していたが、
      // 保存 ROC は最高 index のものなので 1 のまま、パケット ROC だけ 0 になる。
      // Arrange
      const { context, state } = createRolloverTestContext();

      // Act
      const steps = runRolloverSequence(context, state, [65530, 0, 65530, 5]);

      // Assert: パケット ROC
      expect(steps.map((s) => s.roc)).toEqual([0, 1, 0, 1]);
      // Assert: 遅延 65530 で保存 ROC は 1 のまま
      expect(steps[2].highest).toEqual({
        rolloverCounter: 1,
        lastSequenceNumber: 0,
      });
      expect(state).toMatchObject({
        rolloverCounter: 1,
        lastSequenceNumber: 5,
      });
    });

    test("three or more consecutive wraps advance ROC 0 → 1 → 2 → 3", () => {
      // Arrange
      const { context, state } = createRolloverTestContext();
      const cycle = sequenceRange(0, 65535);

      // Act: 3 周分 + 折り返し 1 回分を連続で処理する
      const steps = runRolloverSequence(context, state, [
        ...cycle,
        ...cycle,
        ...cycle,
        ...cycle.slice(0, 10),
      ]);

      // Assert: 各周の先頭パケットの ROC
      expect([0, 65536, 131072, 196608].map((i) => steps[i].roc)).toEqual([
        0, 1, 2, 3,
      ]);
      expect(state).toMatchObject({
        rolloverCounter: 3,
        lastSequenceNumber: 9,
      });
    });

    test.each([
      // s_l < 0x8000: seq - s_l > 0x8000 なら前周
      {
        name: "s_l<0x8000 diff=0x8000",
        highest: [1, 0x100],
        seq: 0x8100,
        roc: 1,
      },
      {
        name: "s_l<0x8000 diff=0x8001",
        highest: [1, 0x100],
        seq: 0x8101,
        roc: 0,
      },
      // s_l >= 0x8000: s_l - 0x8000 > seq なら次周
      {
        name: "s_l>=0x8000 diff=0x8000",
        highest: [1, 0x8100],
        seq: 0x100,
        roc: 1,
      },
      {
        name: "s_l>=0x8000 diff=0x8001",
        highest: [1, 0x8100],
        seq: 0xff,
        roc: 2,
      },
    ])("half-cycle boundary: $name", ({ highest, seq, roc }) => {
      // Arrange
      const { context, state } = createRolloverTestContext({
        rolloverCounter: highest[0],
        lastSequenceNumber: highest[1],
        rolloverHasProcessed: true,
      });

      // Act
      const actual = context.estimateRolloverCounter(seq, state);

      // Assert: 半周 (0x8000) ちょうどは同周、0x8001 で前周/次周と判定する
      expect(actual).toBe(roc);
      // Assert: 推定は state を変更しない
      expect(state).toMatchObject({
        rolloverCounter: highest[0],
        lastSequenceNumber: highest[1],
      });
    });

    test("rejects packets beyond ROC=0xFFFFFFFF", () => {
      // Arrange
      const { context, state } = createRolloverTestContext({
        rolloverCounter: 0xffffffff,
        lastSequenceNumber: 65535,
        rolloverHasProcessed: true,
      });

      // Act / Assert: 次周 (2^32) は表現できないので明示的なエラーで拒否する
      expect(() => context.estimateRolloverCounter(0, state)).toThrowError(
        SrtpRolloverCounterOverflowError,
      );
      // Assert: state は変わらない
      expect(state).toMatchObject({
        rolloverCounter: 0xffffffff,
        lastSequenceNumber: 65535,
      });
    });

    test("deprecated updateRolloverCount returns packet ROC and commits only newer index", () => {
      // Arrange
      const { context, state } = createRolloverTestContext();

      // Act: 互換ラッパーで折り返しと遅延パケットを処理する
      const rocs = [65535, 0, 65535, 1].map((seq) =>
        context.updateRolloverCount(seq, state),
      );

      // Assert: 戻り値はパケット ROC、保存値は最高 index
      expect(rocs).toEqual([0, 1, 0, 1]);
      expect(state).toMatchObject({
        rolloverCounter: 1,
        lastSequenceNumber: 1,
      });
    });
  });
});
