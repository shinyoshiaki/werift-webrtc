import { describe, expect, test } from "vitest";
import { UseSRTP } from "../../../src/handshake/extensions/useSrtp";

describe("handshake_extensions_useSrtp", () => {
  // type=14, length=5, profiles_len=2, profile=0x0001, mki_len=0
  const raw = Buffer.from([
    0x00, 0x0e, 0x00, 0x05, 0x00, 0x02, 0x00, 0x01, 0x00,
  ]);

  test("raw empty MKI", () => {
    // Act
    const c = UseSRTP.deSerialize(raw);
    // Assert: MKI is payload-only (empty)
    expect(c.type).toBe(14);
    expect(c.profiles).toEqual([1]);
    expect(c.mki.length).toBe(0);
    expect(raw).toEqual(c.serialize());
  });

  test("create with empty MKI payload", () => {
    // Arrange / Act
    const c = UseSRTP.create([1], Buffer.alloc(0));
    // Assert
    expect(c.serialize()).toEqual(raw);
    expect(c.mki.length).toBe(0);
  });

  test("fromData roundtrip", () => {
    // Arrange / Act
    const c = UseSRTP.deSerialize(raw);
    const ext = c.extension;
    // Assert
    expect(UseSRTP.fromData(ext.data).serialize()).toEqual(raw);
  });

  test("strict MKI length (truncated payload rejected)", () => {
    // Arrange: profiles ok, mki_len=5 but 0 payload bytes
    const bad = Buffer.from([
      0x00, 0x0e, 0x00, 0x05, 0x00, 0x02, 0x00, 0x01, 0x05,
    ]);
    // Act / Assert
    expect(() => UseSRTP.deSerialize(bad)).toThrow(/MKI length mismatch/i);
  });

  test("non-empty MKI payload roundtrip", () => {
    // Arrange
    const mki = Buffer.from([0xaa, 0xbb]);
    // Act
    const c = UseSRTP.create([1], mki);
    const again = UseSRTP.deSerialize(c.serialize());
    // Assert
    expect(again.mki.equals(mki)).toBe(true);
    expect(again.profiles).toEqual([1]);
  });
});
