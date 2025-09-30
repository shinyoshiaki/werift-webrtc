import { describe, expect, test } from "vitest";
import {
  UNKNOWN_SIZE,
  decodeVintEncodedNumber,
  vintEncodedNumber,
} from "../../src/extra/container/webm/ebml/ebml";

describe("EBML vint encode/decode", () => {
  const samples = [
    0,
    1,
    10,
    0x7e, // max 1-byte payload (7 bits) before length grows
    0x7f, // boundary -> needs 2 bytes (since 0x7f encodes as length marker + value bits)
    0x3ffe, // max 2-byte payload
    0x3fff, // needs 3 bytes
    0x1ffffe, // max 3-byte payload
    0x1fffff, // needs 4 bytes
    0xffffffe - 1, // near 4-byte boundary
  ];

  test.each(samples)("roundtrip %s", (num) => {
    const raw = vintEncodedNumber(num).bytes;
    const { value, length } = decodeVintEncodedNumber(raw);
    expect(typeof length).toBe("number");
    expect(value).toBe(num);
  });

  test("multiple sequential numbers in a buffer", () => {
    const values = [1, 127, 128, 30000];
    const encodedParts = values.map((v) => vintEncodedNumber(v).bytes);
    const total = encodedParts.reduce((p, c) => p + c.length, 0);
    const buf = Buffer.concat(encodedParts);

    let pos = 0;
    for (const v of values) {
      const { value, length } = decodeVintEncodedNumber(buf, pos);
      expect(value).toBe(v);
      pos += length;
    }
    expect(pos).toBe(total);
  });

  test("throws on unknown size sentinel", () => {
    // UNKNOWN_SIZE includes length marker already. Try decode at offset 0.
    expect(() => decodeVintEncodedNumber(UNKNOWN_SIZE)).toThrow();
  });
});
