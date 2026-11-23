import { vi } from "vitest";
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

  test("drops the newest packet when the byte cap would be exceeded", () => {
    // Arrange: record 数には余裕があり、8 byte までだけ保持できるバッファ
    const buffer = new EarlyDataBuffer(256, 8, 2_000);

    // Act: 合計 8 byte まで追加した後、1 byte 超過する record を追加する
    expect(buffer.push(Buffer.from("abcd"), 0)).toBe(true);
    expect(buffer.push(Buffer.from("efgh"), 1)).toBe(true);
    expect(buffer.push(Buffer.from("i"), 2)).toBe(false);

    // Assert: byte 上限でも古い record を残し、新しい record だけを落とす
    expect(buffer.drain(3).map((data) => data.toString())).toEqual([
      "abcd",
      "efgh",
    ]);
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

  test("expires the queue even when the retention timer fires before the wall clock reaches the deadline", () => {
    // Arrange: setTimeout だけを fake にし、Date.now は個別に制御する
    // (Node の timer は monotonic clock のため、Date.now より 1ms 程度早く発火し得る)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let wallClock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => wallClock);
    const buffer = new EarlyDataBuffer(256, 256 * 1024, 2_000);
    buffer.push(Buffer.from("early"));

    try {
      // Act: timer は 2000ms 後に発火するが、その時点の wall clock は 1999ms
      wallClock = 1_999;
      vi.advanceTimersByTime(2_000);
      const atEarlyFire = buffer.snapshot();
      wallClock = 2_000;
      vi.advanceTimersByTime(1);

      // Assert: 早期発火時は保持し、期限到達後に timer を再武装して破棄する
      expect(atEarlyFire.bufferedPackets).toBe(1);
      expect(buffer.snapshot()).toMatchObject({
        bufferedPackets: 0,
        droppedPackets: 1,
        droppedBytes: 5,
      });
    } finally {
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  test("snapshot reports expiry without waiting for the retention timer", () => {
    // Arrange: timer を一切進めない状態で packet を保持する
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let wallClock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => wallClock);
    const buffer = new EarlyDataBuffer(256, 256 * 1024, 2_000);
    buffer.push(Buffer.from("a"));
    buffer.push(Buffer.from("b"));

    try {
      // Act: wall clock だけ期限を越えさせて観測する
      wallClock = 2_000;
      const snapshot = buffer.snapshot();

      // Assert: timer 未発火でも期限切れの queue は保持数に含めない
      expect(snapshot).toMatchObject({
        bufferedPackets: 0,
        droppedPackets: 2,
        droppedBytes: 2,
      });
      expect(buffer.packets).toEqual([]);
    } finally {
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  test("takeOne re-arms the retention timer for the next head", () => {
    // Arrange: 0ms と 1500ms に受信した 2 件を保持する
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let wallClock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => wallClock);
    const buffer = new EarlyDataBuffer(256, 256 * 1024, 2_000);
    buffer.push(Buffer.from("head"));
    wallClock = 1_500;
    buffer.push(Buffer.from("next"));

    try {
      // Act: 先頭だけを取り出し、残りの先頭 (1500ms) の期限まで timer を進める
      wallClock = 1_600;
      const taken = buffer.takeOne()?.toString();
      wallClock = 2_000;
      vi.advanceTimersByTime(400);
      const beforeDeadline = buffer.snapshot();
      wallClock = 3_500;
      vi.advanceTimersByTime(1_500);

      // Assert: 旧先頭の期限では残りを捨てず、新しい先頭の期限で破棄する
      expect(taken).toBe("head");
      expect(beforeDeadline.bufferedPackets).toBe(1);
      expect(buffer.snapshot()).toMatchObject({
        bufferedPackets: 0,
        droppedPackets: 1,
        droppedBytes: 4,
      });
    } finally {
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  test("abort cleanup prevents the retention timer from mutating state", () => {
    // Arrange: retention timer を制御できる clock で pre-auth packet を保持する。
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const buffer = new EarlyDataBuffer(256, 256 * 1024, 2_000);
    buffer.push(Buffer.from("pending"));

    try {
      // Act: fingerprint failure/close と同じ順序で queue と timer を破棄する。
      buffer.clear(true);
      buffer.dispose();
      const afterAbort = buffer.snapshot();
      vi.advanceTimersByTime(2_001);

      // Assert: lifecycle 終了後の timer callback は統計を再更新しない。
      expect(buffer.snapshot()).toEqual(afterAbort);
      expect(afterAbort).toMatchObject({
        bufferedPackets: 0,
        droppedPackets: 1,
        droppedBytes: 7,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
