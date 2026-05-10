import { expect, test } from "vitest";

import {
  formatProgressEvent,
  serializeWorkerResults,
} from "../../tools/wpt-runner/runner";

test("WPT progress output includes the running target name and counts", () => {
  // 実行: 実行開始イベントを標準出力向けの進捗行へ整形する。
  const line = formatProgressEvent({
    type: "start",
    target: {
      file: "webrtc/getstats.html",
      variant: "",
    },
    completed: 12,
    running: 4,
    total: 214,
  });

  // 検証: 進捗行から現在の対象ファイル名と全体進捗が読める。
  expect(line).toBe("[wpt] [12/214] running webrtc/getstats.html (4 active)");
});

test("WPT worker results keep a stable machine-readable stdout prefix", () => {
  // 実行: worker の結果を親プロセス向けの標準出力形式へ直列化する。
  const line = serializeWorkerResults([
    {
      file: "webrtc/getstats.html",
      variant: "",
      subtest: "sample",
      status: "FAIL",
    },
  ]);

  // 検証: 親プロセスは固定 prefix から結果 JSON を確実に抽出できる。
  expect(line).toContain("__WPT_WORKER_RESULT__:");
  expect(line).toContain('"subtest":"sample"');
});
