import { describe, expect, test } from "vitest";
import { parseUnifiedHeader } from "../../../src/record/v1_3/header";
import { serializeUnifiedHeader } from "../../../src/record/v1_3/header";
import { parseDatagramRecords } from "../../../src/record/v1_3/record";

describe("record/v1_3 negative", () => {
  test("truncated unified header throws", () => {
    // Arrange: 前提を準備する
    const buf = Buffer.from([0x2f]); // only first byte

    // Act / Assert: ヘッダ不足はエラー
    expect(() => parseUnifiedHeader(buf)).toThrow(/truncated/);
  });

  test("oversized length throws DtlsDecodeError (strict truncation)", () => {
    // Arrange: 前提を準備する
    const header = serializeUnifiedHeader(2, 1, 1000);
    const data = Buffer.concat([header, Buffer.alloc(10)]);

    // Act / Assert: 不完全レコードは actionable な decode error
    expect(() => parseDatagramRecords(data, () => undefined)).toThrow(
      /truncated|DtlsDecodeError/,
    );
  });

  test("invalid first byte is rejected", () => {
    // Arrange: 前提を準備する
    const data = Buffer.from([0x00, 0x01, 0x02]);

    // Act / Assert: 不正入力を拒否する
    expect(() => parseDatagramRecords(data, () => undefined)).toThrow(
      /invalid DTLS record/,
    );
  });

  test("CID bit set is rejected on parse", () => {
    // Arrange: 前提を準備する
    const data = Buffer.from([
      0x30,
      0x00,
      0x01,
      0x00,
      0x10,
      ...Buffer.alloc(16),
    ]);

    // Act / Assert: codec の往復を検証する
    expect(() => parseDatagramRecords(data, () => undefined)).toThrow(
      /Connection ID/,
    );
  });
});
