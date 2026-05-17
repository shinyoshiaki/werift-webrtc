import { expect, test } from "vitest";

import {
  buildWptProgressState as buildProgressState,
  formatWptProgressMarkdown as formatProgressMarkdown,
  formatWptProgressState as formatProgressState,
  parseWptProgressMarkdown as parseProgressMarkdown,
  parseWptProgressState as parseProgressState,
} from "../../tools/wpt-runner/progress";
import {
  type WptRunReport,
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

test("WPT progress markdown tracks partially passing targets with subtest details", () => {
  const report: WptRunReport = {
    generatedAt: "2026-05-13T00:00:00.000Z",
    summary: {
      passed: 1,
      failed: 2,
      timedOut: 0,
      skipped: 0,
      total: 3,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "passes",
        status: "PASS",
      },
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "fails",
        status: "FAIL",
        message: "boom",
      },
      {
        file: "webrtc/fully-failing.html",
        variant: "",
        subtest: "no-pass",
        status: "FAIL",
      },
    ],
    regressions: [],
  };

  // 実行: 初回の progress state を人間向け markdown と state JSON へ整形する。
  const state = buildProgressState(report);
  const markdown = formatProgressMarkdown(state);
  const parsed = parseProgressState(formatProgressState(state));

  // 検証: progress.md は成功率表と除外一覧だけを出し、state JSON は完全な追跡情報を保持する。
  expect(state.attemptRuns).toBe(0);
  expect(state.targets).toHaveLength(1);
  expect(markdown).toContain("## Target success rates");
  expect(markdown).toContain("## Excluded test cases");
  expect(markdown).toContain(
    "| webrtc/partial.html | (default) | 1 | 1 | 0 | 2 | 0 | 1/2 | 50.0% | active |",
  );
  expect(markdown).toContain("_No excluded test cases._");
  expect(markdown).not.toContain("wpt-progress-state:start");
  expect(markdown).not.toContain("| fails | FAIL | 0 | yes |");
  expect(parseProgressMarkdown(markdown)).toBeUndefined();
  expect(parsed).toEqual(state);
});

test("WPT progress excludes unresolved subtests after more than three failed attempts", () => {
  const report: WptRunReport = {
    generatedAt: "2026-05-13T00:00:00.000Z",
    summary: {
      passed: 1,
      failed: 1,
      timedOut: 0,
      skipped: 0,
      total: 2,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "passes",
        status: "PASS",
      },
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "still failing",
        status: "FAIL",
        message: "still broken",
      },
    ],
    regressions: [],
  };

  // 実行: 同じ失敗を4回の明示 rerun 後も繰り返し、除外ルールを発火させる。
  let state = buildProgressState(report);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    state = buildProgressState(report, state, {
      attemptFilter: "webrtc/partial.html",
      canonical: false,
    });
  }

  const target = state.targets[0];
  const failingSubtest = target.subtests.find(
    (subtest) => subtest.name === "still failing",
  );

  // 検証: 4回失敗した subtest は除外され、残りの有効分母では target が完了扱いになる。
  expect(state.attemptRuns).toBe(4);
  expect(target.status).toBe("done");
  expect(target.effectivePass).toBe(1);
  expect(target.effectiveTotal).toBe(1);
  expect(failingSubtest).toMatchObject({
    excluded: true,
    failedAttempts: 4,
    exclusionReason: "Excluded after 4 failed implementation attempts.",
  });
});

test("WPT progress keeps tracked targets even when the latest full run loses all PASS results", () => {
  const initialReport: WptRunReport = {
    generatedAt: "2026-05-13T00:00:00.000Z",
    summary: {
      passed: 1,
      failed: 1,
      timedOut: 0,
      skipped: 0,
      total: 2,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "passes",
        status: "PASS",
      },
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "fails",
        status: "FAIL",
      },
    ],
    regressions: [],
  };
  const nextReport: WptRunReport = {
    generatedAt: "2026-05-13T00:01:00.000Z",
    summary: {
      passed: 0,
      failed: 2,
      timedOut: 0,
      skipped: 0,
      total: 2,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "passes",
        status: "FAIL",
      },
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "fails",
        status: "FAIL",
      },
    ],
    regressions: [],
  };

  // 実行: 最新 run で PASS が消えた target を前回 state 付きで再集計する。
  const previousState = buildProgressState(initialReport);
  const nextState = buildProgressState(nextReport, previousState);

  // 検証: 最新 full run で PASS が消えても既存 target は履歴ごと保持される。
  expect(previousState.targets).toHaveLength(1);
  expect(nextState.targets).toHaveLength(1);
  expect(nextState.targets[0]).toMatchObject({
    file: "webrtc/partial.html",
    pass: 0,
    fail: 2,
    status: "active",
  });
});

test("WPT progress keeps generatedAt stable when a full rerun does not change content", () => {
  const initialReport: WptRunReport = {
    generatedAt: "2026-05-13T00:00:00.000Z",
    summary: {
      passed: 1,
      failed: 1,
      timedOut: 0,
      skipped: 0,
      total: 2,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "passes",
        status: "PASS",
      },
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "fails",
        status: "FAIL",
        message: "boom",
      },
    ],
    regressions: [],
  };
  const rerunReport: WptRunReport = {
    ...initialReport,
    generatedAt: "2026-05-13T00:05:00.000Z",
  };

  // 実行: 同一内容の full rerun を重ねる。
  const firstState = buildProgressState(initialReport);
  const secondState = buildProgressState(rerunReport, firstState);

  // 検証: 内容が不変なら generatedAt を維持して CI 後の不要差分を防ぐ。
  expect(secondState.targets).toEqual(firstState.targets);
  expect(secondState.generatedAt).toBe(firstState.generatedAt);
});

test("WPT progress keeps exclusion notes aligned with the current failed-attempt count", () => {
  const report: WptRunReport = {
    generatedAt: "2026-05-13T00:00:00.000Z",
    summary: {
      passed: 1,
      failed: 1,
      timedOut: 0,
      skipped: 0,
      total: 2,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "passes",
        status: "PASS",
      },
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "still failing",
        status: "FAIL",
        message: "still broken",
      },
    ],
    regressions: [],
  };

  // 実行: 除外後も同じ明示 rerun を継続し、failedAttempts をさらに進める。
  let state = buildProgressState(report);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    state = buildProgressState(report, state, {
      attemptFilter: "webrtc/partial.html",
      canonical: false,
    });
  }

  const failingSubtest = state.targets[0].subtests.find(
    (subtest) => subtest.name === "still failing",
  );

  // 検証: 除外理由の文言は実際の failedAttempts と一致する。
  expect(failingSubtest).toMatchObject({
    excluded: true,
    failedAttempts: 5,
    exclusionReason: "Excluded after 5 failed implementation attempts.",
  });
});

test("WPT progress fills excluded subtests with a fallback lastError when none is recorded", () => {
  const report: WptRunReport = {
    generatedAt: "2026-05-13T00:00:00.000Z",
    summary: {
      passed: 1,
      failed: 1,
      timedOut: 0,
      skipped: 0,
      total: 2,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "passes",
        status: "PASS",
      },
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "still failing",
        status: "FAIL",
      },
    ],
    regressions: [],
  };

  // 実行: 詳細エラーなしの失敗を明示 rerun で除外閾値まで繰り返し、markdown へ整形する。
  let state = buildProgressState(report);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    state = buildProgressState(report, state, {
      attemptFilter: "webrtc/partial.html",
      canonical: false,
    });
  }
  const markdown = formatProgressMarkdown(state);

  // 検証: 除外済み subtest にも status ベースの lastError が必ず残る。
  expect(
    state.targets[0].subtests.find(
      (subtest) => subtest.name === "still failing",
    ),
  ).toMatchObject({
    excluded: true,
    lastError:
      "No detailed failure message was captured for the latest FAIL result.",
  });
  expect(markdown).toContain(
    "| still failing | FAIL | 4 | Excluded after 4 failed implementation attempts. | No detailed failure message was captured for the latest FAIL result. |",
  );
});

test("WPT filtered reruns keep canonical full-run counts while updating failed attempts", () => {
  const fullReport: WptRunReport = {
    generatedAt: "2026-05-13T00:00:00.000Z",
    summary: {
      passed: 1,
      failed: 1,
      timedOut: 0,
      skipped: 0,
      total: 2,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "passes",
        status: "PASS",
      },
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "fails",
        status: "FAIL",
        message: "boom",
      },
    ],
    regressions: [],
  };
  const filteredReport: WptRunReport = {
    generatedAt: "2026-05-13T00:01:00.000Z",
    summary: {
      passed: 0,
      failed: 1,
      timedOut: 0,
      skipped: 0,
      total: 1,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "fails",
        status: "FAIL",
        message: "still broken",
      },
    ],
    regressions: [],
  };

  // 実行: full run を正本にした後、filtered rerun を試行回数更新専用で重ねる。
  const previousState = buildProgressState(fullReport);
  const nextState = buildProgressState(filteredReport, previousState, {
    attemptFilter: "webrtc/partial.html",
    canonical: false,
  });

  // 検証: 正本の PASS/FAIL 集計は維持しつつ、対象 subtest の試行回数だけ進む。
  expect(nextState.generatedAt).toBe(previousState.generatedAt);
  expect(nextState.attemptLog).toEqual([
    {
      file: "webrtc/partial.html",
      filter: "webrtc/partial.html",
      latestError: "still broken",
      latestStatus: "FAIL",
      runId: "attempt-1",
      subtest: "fails",
      timestamp: "2026-05-13T00:01:00.000Z",
      variant: "",
    },
  ]);
  expect(nextState.targets[0]).toMatchObject({
    pass: 1,
    fail: 1,
    total: 2,
    status: "active",
  });
  expect(
    nextState.targets[0].subtests.find((subtest) => subtest.name === "fails"),
  ).toMatchObject({
    latestStatus: "FAIL",
    failedAttempts: 1,
    lastError: "still broken",
  });
});

test("WPT full reruns do not increase failedAttempts without an explicit target filter", () => {
  const report: WptRunReport = {
    generatedAt: "2026-05-13T00:00:00.000Z",
    summary: {
      passed: 1,
      failed: 1,
      timedOut: 0,
      skipped: 0,
      total: 2,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "passes",
        status: "PASS",
      },
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "fails",
        status: "FAIL",
      },
    ],
    regressions: [],
  };

  // 実行: full run を繰り返しても explicit rerun でなければ attempt は進めない。
  const previousState = buildProgressState(report);
  const nextState = buildProgressState(report, previousState);

  // 検証: failedAttempts と attempt log は据え置かれる。
  expect(nextState.attemptRuns).toBe(0);
  expect(nextState.attemptLog).toEqual([]);
  expect(
    nextState.targets[0].subtests.find((subtest) => subtest.name === "fails"),
  ).toMatchObject({
    failedAttempts: 0,
    excluded: false,
  });
});

test("WPT broad reruns do not count as subtest implementation attempts", () => {
  const report: WptRunReport = {
    generatedAt: "2026-05-13T00:00:00.000Z",
    summary: {
      passed: 1,
      failed: 1,
      timedOut: 0,
      skipped: 0,
      total: 2,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "passes",
        status: "PASS",
      },
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "fails",
        status: "FAIL",
        message: "still broken",
      },
    ],
    regressions: [],
  };

  // 実行: webrtc/ のような広い filter 付き rerun を重ねる。
  const previousState = buildProgressState(report);
  const nextState = buildProgressState(report, previousState, {
    attemptFilter: "webrtc/",
    canonical: false,
  });

  // 検証: broad rerun は attempt log にも failedAttempts にも反映しない。
  expect(nextState.attemptRuns).toBe(0);
  expect(nextState.attemptLog).toEqual([]);
  expect(
    nextState.targets[0].subtests.find((subtest) => subtest.name === "fails"),
  ).toMatchObject({
    failedAttempts: 0,
    excluded: false,
  });
});

test("WPT filtered reruns clear stale synthetic timeout subtests when the rerun completes", () => {
  const timedOutReport: WptRunReport = {
    generatedAt: "2026-05-13T00:00:00.000Z",
    summary: {
      passed: 0,
      failed: 0,
      timedOut: 1,
      skipped: 0,
      total: 1,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "[timeout]",
        status: "TIMEOUT",
        message: "timed out",
      },
    ],
    regressions: [],
  };
  const recoveredReport: WptRunReport = {
    generatedAt: "2026-05-13T00:01:00.000Z",
    summary: {
      passed: 1,
      failed: 0,
      timedOut: 0,
      skipped: 0,
      total: 1,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "passes",
        status: "PASS",
      },
    ],
    regressions: [],
  };

  // 実行: timeout した target を成功した filtered rerun で上書きする。
  const previousState = buildProgressState(timedOutReport);
  const nextState = buildProgressState(recoveredReport, previousState, {
    attemptFilter: "webrtc/partial.html",
    canonical: false,
  });

  // 検証: stale な [timeout] は残らず、最新 run の subtest 一覧へ置き換わる。
  expect(nextState.targets[0].subtests).toEqual([
    {
      excluded: false,
      exclusionReason: undefined,
      failedAttempts: 0,
      lastError: undefined,
      latestStatus: "PASS",
      name: "passes",
    },
  ]);
  expect(nextState.targets[0]).toMatchObject({
    effectivePass: 1,
    effectiveTotal: 1,
    status: "done",
  });
});

test("WPT legacy progress without attemptLog resets attemptRuns to auditable reruns only", () => {
  const report: WptRunReport = {
    generatedAt: "2026-05-13T00:00:00.000Z",
    summary: {
      passed: 1,
      failed: 1,
      timedOut: 0,
      skipped: 0,
      total: 2,
    },
    results: [
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "passes",
        status: "PASS",
      },
      {
        file: "webrtc/partial.html",
        variant: "",
        subtest: "fails",
        status: "FAIL",
      },
    ],
    regressions: [],
  };

  // 実行: attemptLog を持たない旧 state から新しい progress state へ移行する。
  const legacyState = {
    attemptRuns: 5,
    generatedAt: "2026-05-12T00:00:00.000Z",
    targets: [],
  } as any;
  const nextState = buildProgressState(report, legacyState);

  // 検証: 監査不能な旧 attemptRuns は引き継がず、明示 rerun の記録だけを正本にする。
  expect(nextState.attemptRuns).toBe(0);
  expect(nextState.attemptLog).toEqual([]);
});
