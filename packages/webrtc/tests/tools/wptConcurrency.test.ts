import { expect, test } from "vitest";

import { resolveTargetConcurrency } from "../../tools/wpt-runner/concurrencyLogic";

test("WebRTC WPT runner uses the detected CPU parallelism by default", () => {
  // 実行: 環境変数指定がない状態で CPU 並列度から実行数を解決する。
  const concurrency = resolveTargetConcurrency({
    availableParallelism: 12,
    cpuCount: 8,
  });

  // 検証: runner は利用可能な CPU コア数に合わせて同時実行数を引き上げる。
  expect(concurrency).toBe(12);
});

test("WebRTC WPT runner falls back to CPU count when availableParallelism is unavailable", () => {
  // 実行: availableParallelism が使えない環境の代替値を解決する。
  const concurrency = resolveTargetConcurrency({
    cpuCount: 6,
  });

  // 検証: fallback でも CPU コア数ぶんの並列実行を維持する。
  expect(concurrency).toBe(6);
});

test("WebRTC WPT runner accepts an explicit concurrency override", () => {
  // 実行: 明示設定された同時実行数を runner 設定として解決する。
  const concurrency = resolveTargetConcurrency({
    availableParallelism: 12,
    cpuCount: 8,
    input: "4",
  });

  // 検証: 明示 override がある場合は検出値より優先して適用される。
  expect(concurrency).toBe(4);
});
