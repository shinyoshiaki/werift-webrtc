import { expect, test } from "vitest";

import {
  findBaselineRegressions,
  replaceTargetResults,
  selectStableBaseline,
  selectTimeoutRetryTargets,
} from "../../tools/wpt-runner/baselineLogic";
import type {
  WptAllowlistFile,
  WptResultRecord,
} from "../../tools/wpt-runner/runner";

const record = (
  subtest: string,
  status: WptResultRecord["status"],
  file = "webrtc/a.html",
): WptResultRecord => ({ file, variant: "", subtest, status });

const noAllowlist: WptAllowlistFile = { targets: [] };

test("a baseline subtest that reports a lower status is a regression", () => {
  // Act: PASS → FAIL、FAIL → TIMEOUT、PASS → PASS を比べる
  const regressions = findBaselineRegressions(
    [record("x", "PASS"), record("y", "FAIL"), record("z", "PASS")],
    [record("x", "FAIL"), record("y", "TIMEOUT"), record("z", "PASS")],
  );

  // Assert: 下がった 2 件だけが回帰
  expect(regressions.map(({ subtest }) => subtest)).toEqual(["x", "y"]);
});

test("a baseline subtest that a file which ran does not report is a regression", () => {
  // Act: a.html はファイル全体が時間切れで x を報告せず、b.html は実行されていない
  const regressions = findBaselineRegressions(
    [record("x", "PASS"), record("y", "PASS", "webrtc/b.html")],
    [record("[timeout]", "TIMEOUT")],
  );

  // Assert: 実行したファイルの未報告 subtest だけが TIMEOUT の回帰になる
  expect(regressions).toEqual([
    expect.objectContaining({
      file: "webrtc/a.html",
      subtest: "x",
      status: "TIMEOUT",
    }),
  ]);
});

test("the stable baseline is the subtests PASS in every run", () => {
  // Act: x は全回 PASS、y は 1 回だけ FAIL、z は 2 回目に報告されない
  const baseline = selectStableBaseline(
    [
      [record("x", "PASS"), record("y", "PASS"), record("z", "PASS")],
      [
        record("x", "PASS"),
        record("y", "FAIL"),
        record("[timeout]", "TIMEOUT"),
      ],
      [record("x", "PASS"), record("y", "PASS"), record("z", "PASS")],
    ],
    noAllowlist,
  );

  // Assert: 全回 PASS の x だけを PASS として記録する
  expect(baseline).toEqual([record("x", "PASS")]);
});

test("the allowlist keeps disabled targets and excluded subtests out of the baseline", () => {
  // Arrange: b.html は無効、a.html の y は除外
  const allowlist: WptAllowlistFile = {
    targets: [
      {
        file: "webrtc/a.html",
        enabled: true,
        reason: "",
        baselineExclusions: ["y"],
      },
      { file: "webrtc/b.html", enabled: false, reason: "" },
    ],
  };
  const run = [
    record("x", "PASS"),
    record("y", "PASS"),
    record("w", "PASS", "webrtc/b.html"),
  ];

  // Act
  const baseline = selectStableBaseline([run, run], allowlist);

  // Assert: 除外されない x だけが残る
  expect(baseline).toEqual([record("x", "PASS")]);
});

test("only targets whose regressions are all timeouts are rerun", () => {
  // Act: a.html は時間切れだけ、b.html は FAIL を含む
  const keys = selectTimeoutRetryTargets([
    record("x", "TIMEOUT"),
    record("y", "TIMEOUT"),
    record("z", "TIMEOUT", "webrtc/b.html"),
    record("w", "FAIL", "webrtc/b.html"),
  ]);

  // Assert: a.html だけを再実行する
  expect([...keys]).toEqual(["webrtc/a.html::"]);
});

test("the rerun replaces every result of its targets", () => {
  // Act: a.html の結果を再実行の結果で置き換える
  const merged = replaceTargetResults(
    [record("[timeout]", "TIMEOUT"), record("y", "PASS", "webrtc/b.html")],
    [record("x", "PASS")],
    new Set(["webrtc/a.html::"]),
  );

  // Assert: a.html は再実行の結果だけ、b.html はそのまま
  expect(merged).toEqual([
    record("x", "PASS"),
    record("y", "PASS", "webrtc/b.html"),
  ]);
});
