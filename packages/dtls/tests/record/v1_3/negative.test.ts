import { describe, expect, test } from "vitest";
import { parseUnifiedHeader } from "../../../src/record/v1_3/header";
import { serializeUnifiedHeader } from "../../../src/record/v1_3/header";
import { parseDatagramRecords } from "../../../src/record/v1_3/record";

describe("record/v1_3 negative", () => {
  test("truncated unified header throws", () => {
    // Arrange
    const buf = Buffer.from([0x2f]); // only first byte

    // Act / Assert: ヘッダ不足はエラー
    expect(() => parseUnifiedHeader(buf)).toThrow(/truncated/);
  });

  test("oversized length does not parse past buffer", () => {
    // Arrange: length claims 1000 but body is short
    const header = serializeUnifiedHeader(2, 1, 1000);
    const data = Buffer.concat([header, Buffer.alloc(10)]);

    // Act
    const records = parseDatagramRecords(data, () => undefined);

    // Assert: 不完全レコードは消費せず空
    expect(records.length).toBe(0);
  });

  test("invalid first byte is rejected", () => {
    // Arrange
    const data = Buffer.from([0x00, 0x01, 0x02]);

    // Act / Assert
    expect(() => parseDatagramRecords(data, () => undefined)).toThrow(
      /invalid DTLS record/,
    );
  });

  test("CID bit set is rejected on parse", () => {
    // Arrange: C=1
    const data = Buffer.from([
      0x30,
      0x00,
      0x01,
      0x00,
      0x10,
      ...Buffer.alloc(16),
    ]);

    // Act / Assert
    expect(() => parseDatagramRecords(data, () => undefined)).toThrow(
      /Connection ID/,
    );
  });
});
