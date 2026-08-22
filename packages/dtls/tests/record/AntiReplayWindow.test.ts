import { describe, expect, test } from "vitest";
import { AntiReplayWindow } from "../../src/record/antiReplayWindow";

describe("AntiReplayWindow", () => {
  test("constructor & reset", () => {
    // Arrange: 前提を準備する
    const wnd = new AntiReplayWindow() as any;
    // Assert: 期待どおりの結果を検証する
    expect(wnd.window).toEqual([0, 0]);
    expect(wnd.ceiling).toEqual(63);
    // Act: 期待どおりの結果を検証する
    wnd.window = [1, 2, 3];
    wnd.ceiling = -1;
    wnd.reset();
    // Assert: 期待どおりの結果を検証する
    expect(wnd.window).toEqual([0, 0]);
    expect(wnd.ceiling).toEqual(63);
  });

  test("basic accept and mark within initial window", () => {
    // Arrange: 前提を準備する
    const wnd = new AntiReplayWindow();
    // Act / Assert: 期待どおりの結果を検証する
    expect(wnd.mayReceive(-1)).toBe(false);
    expect(wnd.mayReceive(0)).toBe(true);
    expect(wnd.mayReceive(63)).toBe(true);
    expect(wnd.mayReceive(64)).toBe(true);

    wnd.markAsReceived(5);
    expect(wnd.hasReceived(5)).toBe(true);
    expect(wnd.mayReceive(5)).toBe(false);
    expect((wnd as any).ceiling).toEqual(63);
  });

  test("32-record jump keeps prior marks and accepts unreceived in-window seqs", () => {
    // Arrange: 前提を準備する
    const wnd = new AntiReplayWindow();
    // Act: 期待どおりの結果を検証する
    wnd.markAsReceived(10);
    wnd.markAsReceived(20);
    // Jump ceiling 63 → 95 (amount = 32). JS `>>> 32` is a no-op — must not corrupt.
    wnd.markAsReceived(95);
    // Assert: 期待どおりの結果を検証する
    // After jump of 32 from ceiling 63 to 95, lowerBound=32. seq 10,20 fall out.
    expect(wnd.hasReceived(10)).toBe(false);
    expect(wnd.hasReceived(20)).toBe(false);
    expect(wnd.hasReceived(95)).toBe(true);
    // Unreceived seq still inside window must be acceptable (not false-positive replay)
    expect(wnd.mayReceive(50)).toBe(true);
    expect(wnd.mayReceive(94)).toBe(true);
    // Already received is rejected
    expect(wnd.mayReceive(95)).toBe(false);
  });

  test("64-record jump clears prior marks without false replay on new range", () => {
    // Arrange: 前提を準備する
    const wnd = new AntiReplayWindow();
    // Act: リプレイを検証する
    wnd.markAsReceived(5);
    wnd.markAsReceived(40);
    // Jump by 64 (full window width): ceiling 63 → 127
    wnd.markAsReceived(127);
    // Assert: リプレイを検証する
    expect(wnd.hasReceived(5)).toBe(false);
    expect(wnd.hasReceived(40)).toBe(false);
    expect(wnd.hasReceived(127)).toBe(true);
    // Fresh seqs in the new window are not treated as replay
    expect(wnd.mayReceive(70)).toBe(true);
    expect(wnd.mayReceive(100)).toBe(true);
    expect(wnd.mayReceive(126)).toBe(true);
    wnd.markAsReceived(100);
    expect(wnd.hasReceived(100)).toBe(true);
    expect(wnd.mayReceive(100)).toBe(false);
  });

  test("mixed 32-word then sub-word shift preserves mid-window bits", () => {
    // Arrange: 前提を準備する
    const wnd = new AntiReplayWindow();
    // Act: 期待どおりの結果を検証する
    wnd.markAsReceived(50);
    // Jump by 40 (= 32 + 8): exercises whole-word then residual shift
    wnd.markAsReceived(63 + 40); // ceiling was 63 → 103
    // Assert: 期待どおりの結果を検証する
    expect(wnd.hasReceived(50)).toBe(true);
    // Unreceived neighbors must still be allowed (not false replay)
    expect(wnd.mayReceive(51)).toBe(true);
    expect(wnd.mayReceive(49)).toBe(true);
    expect(wnd.mayReceive(102)).toBe(true);
  });

  test("fault injection: 32-jump must not mark unreceived seq as already received", () => {
    // Arrange: 前提を準備する
    const wnd = new AntiReplayWindow();
    wnd.markAsReceived(0);
    wnd.markAsReceived(31);
    // Act: 期待どおりの結果を検証する
    wnd.markAsReceived(63 + 32); // 95
    // Assert: 期待どおりの結果を検証する
    for (let s = 32; s < 95; s++) {
      if (s === 0 || s === 31) continue; // already out of window
      expect(wnd.mayReceive(s)).toBe(true);
      expect(wnd.hasReceived(s)).toBe(false);
    }
    expect(wnd.hasReceived(95)).toBe(true);
  });
});
