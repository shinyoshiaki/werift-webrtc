import { describe, expect, test } from "vitest";
import { UseSRTP } from "../../../src/handshake/extensions/useSrtp";

describe("handshake_extensions_useSrtp", () => {
  // type=14, length=5, profiles_len=2, profile=0x0001, mki_len=0
  const raw = Buffer.from([
    0x00, 0x0e, 0x00, 0x05, 0x00, 0x02, 0x00, 0x01, 0x00,
  ]);

  test("raw empty MKI", () => {
    // Act: use_srtp/MKI を検証する
    const c = UseSRTP.deSerialize(raw);
    // Assert: use_srtp/MKI を検証する
    expect(c.type).toBe(14);
    expect(c.profiles).toEqual([1]);
    expect(c.mki.length).toBe(0);
    expect(raw).toEqual(c.serialize());
  });

  test("create with empty MKI payload", () => {
    // Arrange: 前提を準備する
    const c = UseSRTP.create([1], Buffer.alloc(0));
    // Assert: use_srtp/MKI を検証する
    expect(c.serialize()).toEqual(raw);
    expect(c.mki.length).toBe(0);
  });

  test("Buffer.from([0x00]) is a 1-byte MKI payload, not empty", () => {
    // Arrange: 前提を準備する
    const mistaken = UseSRTP.create([1], Buffer.from([0x00]));
    // Assert: use_srtp/MKI を検証する
    const wire = mistaken.serialize();
    expect(wire[wire.length - 2]).toBe(1);
    expect(wire[wire.length - 1]).toBe(0x00);
    expect(mistaken.mki.length).toBe(1);
  });

  test("fromData roundtrip", () => {
    // Arrange: 前提を準備する
    const c = UseSRTP.deSerialize(raw);
    const ext = c.extension;
    // Assert: codec の往復を検証する
    expect(UseSRTP.fromData(ext.data).serialize()).toEqual(raw);
  });

  test("strict MKI length (truncated payload rejected)", () => {
    // Arrange: 前提を準備する
    const bad = Buffer.from([
      0x00, 0x0e, 0x00, 0x05, 0x00, 0x02, 0x00, 0x01, 0x05,
    ]);
    // Act / Assert: 不正入力を拒否する
    expect(() => UseSRTP.deSerialize(bad)).toThrow(/MKI length mismatch/i);
  });

  test("non-empty MKI payload roundtrip", () => {
    // Arrange: 前提を準備する
    const mki = Buffer.from([0xaa, 0xbb]);
    // Act: codec の往復を検証する
    const c = UseSRTP.create([1], mki);
    const again = UseSRTP.deSerialize(c.serialize());
    // Assert: codec の往復を検証する
    expect(again.mki.equals(mki)).toBe(true);
    expect(again.profiles).toEqual([1]);
  });
});
