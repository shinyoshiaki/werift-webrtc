import { AV1Obu, leb128decode } from "../../src/codec/av1";
import { leb128encode } from "../../src/codec/leb128";

describe("codec/av1 leb128", () => {
  test.each([
    [0, "00"],
    [127, "7f"],
    [128, "8001"],
    [255, "ff01"],
    [16384, "808001"],
  ])("encode/decode round-trip for %i", (value, hex) => {
    // Act: encode して decode で戻す
    const encoded = leb128encode(value as number);
    const [decoded, bytes] = leb128decode(encoded);

    // Assert: 期待 hex と往復結果が一致すること
    expect(encoded.toString("hex")).toBe(hex);
    expect(decoded).toBe(value);
    expect(bytes).toBe(encoded.length);
  });

  test("rejects negative, non-integer, and unsafe values on encode", () => {
    // Act / Assert: 不正入力を拒否すること
    expect(() => leb128encode(-1)).toThrow();
    expect(() => leb128encode(1.5)).toThrow();
    expect(() => leb128encode(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  test("rejects incomplete decode input", () => {
    // Arrange: continuation bit が立ったまま終端がない入力
    const incomplete = Buffer.from([0x80]);

    // Act / Assert: 終端のない入力を拒否すること
    expect(() => leb128decode(incomplete)).toThrow(/incomplete/);
  });

  test("AV1 OBU serialize with size field uses leb128encode", () => {
    // Arrange
    const obu = new AV1Obu();
    obu.obu_forbidden_bit = 0;
    obu.obu_type = "OBU_FRAME";
    obu.obu_extension_flag = 0;
    obu.obu_has_size_field = 1;
    obu.obu_reserved_1bit = 0;
    obu.payload = Buffer.alloc(128, 0xab);

    // Act: size field 付きで serialize する
    const serialized = obu.serialize();

    // Assert: header(1) + leb128(128=0x80 0x01) + payload
    expect(serialized.subarray(1, 3).toString("hex")).toBe("8001");
    expect(serialized.subarray(3).equals(obu.payload)).toBe(true);
  });
});
