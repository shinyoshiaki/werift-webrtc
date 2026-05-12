import { expect, test } from "vitest";

import {
  formatMarkdownReport,
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

test("WPT markdown report lists files with at least one passing subtest", () => {
  // 実行: 部分成功した file+variant を含むレポートを markdown に整形する。
  const markdown = formatMarkdownReport({
    generatedAt: "2026-05-12T00:00:00.000Z",
    summary: {
      passed: 2,
      failed: 2,
      timedOut: 1,
      skipped: 0,
      total: 5,
    },
    results: [
      {
        file: "webrtc/RTCPeerConnection-removeTrack.https.html",
        variant: "",
        subtest: "passes",
        status: "PASS",
      },
      {
        file: "webrtc/RTCPeerConnection-removeTrack.https.html",
        variant: "",
        subtest: "fails",
        status: "FAIL",
      },
      {
        file: "webrtc/RTCPeerConnection-ontrack.https.html",
        variant: "?variant",
        subtest: "passes",
        status: "PASS",
      },
      {
        file: "webrtc/RTCPeerConnection-ontrack.https.html",
        variant: "?variant",
        subtest: "fails",
        status: "FAIL",
      },
      {
        file: "webrtc/RTCPeerConnection-ontrack.https.html",
        variant: "?variant",
        subtest: "times out",
        status: "TIMEOUT",
      },
    ],
    regressions: [],
  });

  // 検証: PASS を含む file+variant ごとの件数が一覧テーブルへ出力される。
  expect(markdown).toContain("## Files with at least one passing subtest");
  expect(markdown).toContain(
    "| webrtc/RTCPeerConnection-removeTrack.https.html | (default) | 1 | 1 | 0 |",
  );
  expect(markdown).toContain(
    "| webrtc/RTCPeerConnection-ontrack.https.html | ?variant | 1 | 1 | 1 |",
  );
});
