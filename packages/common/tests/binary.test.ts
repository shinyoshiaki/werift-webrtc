import { bufferArrayXor, random16, random32 } from "../src";

describe("binary", () => {
  test("bufferArrayXor", () => {
    const xored = bufferArrayXor([
      Buffer.from([0, 0, 1, 1, 1, 0, 1, 1]),
      Buffer.from([0, 1, 0, 1, 0, 0, 1, 1]),
      Buffer.from([0, 0, 1, 1, 0, 1, 0, 0]),
    ]);
    expect(xored.equals(Buffer.from([0, 1, 0, 1, 1, 1, 0, 0]))).toBeTruthy();
  });

  test("big-endian uint16/uint32 max value read/write", () => {
    // Arrange
    const u16 = Buffer.allocUnsafe(2);
    const u32 = Buffer.allocUnsafe(4);

    // Act: 16/32 bit 最大値を big-endian で書き込む
    u16.writeUInt16BE(0xffff, 0);
    u32.writeUInt32BE(0xffffffff, 0);

    // Assert: 同じ最大値が読めること
    expect(u16.readUInt16BE(0)).toBe(0xffff);
    expect(u32.readUInt32BE(0)).toBe(0xffffffff);
  });

  test("random16/random32 return values in unsigned range", () => {
    // Act
    const r16 = random16();
    const r32 = random32();

    // Assert: 符号なし 16/32 bit 範囲に収まること
    expect(r16).toBeGreaterThanOrEqual(0);
    expect(r16).toBeLessThanOrEqual(0xffff);
    expect(r32).toBeGreaterThanOrEqual(0);
    expect(r32).toBeLessThanOrEqual(0xffffffff);
  });
});
