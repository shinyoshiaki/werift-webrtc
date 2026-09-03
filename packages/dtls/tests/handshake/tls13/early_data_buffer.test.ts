import { EarlyDataBuffer } from "../../../src/engine/v1_3/early-data-buffer";

describe("EarlyDataBuffer", () => {
  test("preserves order and drops the newest packet on overflow", () => {
    // Arrange: 2 レコードだけ保持できるバッファを用意する。
    const buffer = new EarlyDataBuffer(2, 8, 2_000);

    // Act: 上限を越える 3 件目を追加する。
    expect(buffer.push(Buffer.from("a"), 0)).toBe(true);
    expect(buffer.push(Buffer.from("b"), 1)).toBe(true);
    expect(buffer.push(Buffer.from("c"), 2)).toBe(false);

    // Assert: 古い順序を維持し、新しいレコードだけを破棄する。
    expect(buffer.drain(3).map((data) => data.toString())).toEqual(["a", "b"]);
    expect(buffer.snapshot()).toMatchObject({
      droppedPackets: 1,
      droppedBytes: 1,
    });
  });

  test("drops the complete ordered queue when its head expires", () => {
    // Arrange: retention が 2 秒の ordered queue を作成する。
    const buffer = new EarlyDataBuffer(256, 256 * 1024, 2_000);
    buffer.push(Buffer.from("head"), 0);
    buffer.push(Buffer.from("tail"), 1_500);

    // Act: 先頭の期限後に drain する。
    const drained = buffer.drain(2_001);

    // Assert: 欠損した prefix の後続だけを公開しない。
    expect(drained).toEqual([]);
    expect(buffer.snapshot()).toMatchObject({
      bufferedPackets: 0,
      droppedPackets: 2,
      droppedBytes: 8,
    });
  });
});
