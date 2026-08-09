import { describe, expect, test } from "vitest";
import { ContentType } from "../../../src/record/const";
import { serializeUnifiedHeader } from "../../../src/record/v1_3/header";
import {
  DTLS13_MAX_CIPHERTEXT_LENGTH,
  DTLS13_MAX_PLAINTEXT_LENGTH,
  DtlsRecordOverflowError,
  createEpochProtection,
  encryptRecord,
  parseNextRecord,
  serializePlaintextRecord,
} from "../../../src/record/v1_3/record";

describe("DTLS 1.3 record length limits (record_overflow)", () => {
  test("plaintext at 2^14 boundary serializes", () => {
    // Arrange: 上限ちょうど
    const frag = Buffer.alloc(DTLS13_MAX_PLAINTEXT_LENGTH, 0xab);
    // Act: codec の往復を検証する
    const wire = serializePlaintextRecord(ContentType.handshake, 0, 0, frag);
    // Assert: 上限内は受理
    expect(wire.length).toBe(13 + DTLS13_MAX_PLAINTEXT_LENGTH);
  });

  test("plaintext above 2^14 throws record_overflow on serialize", () => {
    // Arrange: 上限超過
    const frag = Buffer.alloc(DTLS13_MAX_PLAINTEXT_LENGTH + 1, 0xab);
    // Act / Assert: record_overflow 相当で拒否
    expect(() =>
      serializePlaintextRecord(ContentType.handshake, 0, 0, frag),
    ).toThrow(DtlsRecordOverflowError);
  });

  test("plaintext parse rejects contentLen above 2^14", () => {
    // Arrange: ヘッダ contentLen だけ 2^14+1（本体は短くてもよい）
    const header = Buffer.alloc(13);
    header.writeUInt8(ContentType.handshake, 0);
    header.writeUInt16BE(0xfefd, 1);
    header.writeUInt16BE(0, 3);
    header.writeUIntBE(0, 5, 6);
    header.writeUInt16BE(DTLS13_MAX_PLAINTEXT_LENGTH + 1, 11);
    // Act / Assert: codec の往復を検証する
    expect(() => parseNextRecord(header, () => undefined)).toThrow(
      /record_overflow/,
    );
  });

  test("ciphertext length above 2^14+256 throws record_overflow", () => {
    // Arrange: unified header の length フィールドだけ過大
    const over = DTLS13_MAX_CIPHERTEXT_LENGTH + 1;
    const header = serializeUnifiedHeader(2, 1, over);
    // 本体はヘッダのみ（長さ検証はヘッダ時点で失敗）
    // Act / Assert: record_overflow を検証する
    expect(() => parseNextRecord(header, () => undefined)).toThrow(
      DtlsRecordOverflowError,
    );
  });

  test("encryptRecord rejects plaintext above 2^14", () => {
    // Arrange: 前提を準備する
    const ep = createEpochProtection(3);
    ep.writeKeys = {
      key: Buffer.alloc(16, 1),
      iv: Buffer.alloc(12, 2),
      snKey: Buffer.alloc(16, 3),
    };
    const big = Buffer.alloc(DTLS13_MAX_PLAINTEXT_LENGTH + 1, 7);
    // Act / Assert: レコード保護を検証する
    expect(() =>
      encryptRecord(big, ContentType.applicationData, ep),
    ).toThrow(DtlsRecordOverflowError);
  });

  test("encryptRecord accepts plaintext at 2^14 boundary", () => {
    // Arrange: 前提を準備する
    const ep = createEpochProtection(3);
    ep.writeKeys = {
      key: Buffer.alloc(16, 1),
      iv: Buffer.alloc(12, 2),
      snKey: Buffer.alloc(16, 3),
    };
    const ok = Buffer.alloc(DTLS13_MAX_PLAINTEXT_LENGTH, 7);
    // Act: レコード保護を検証する
    const wire = encryptRecord(ok, ContentType.applicationData, ep);
    // Assert: 暗号化レコードが生成される
    expect(wire.length).toBeGreaterThan(ok.length);
  });
});
