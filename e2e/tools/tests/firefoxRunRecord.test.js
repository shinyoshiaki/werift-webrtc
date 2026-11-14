const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  RECORDS_DIR,
  buildRecord,
  collectGitInfo,
  recordFileName,
  summarizeEvents,
} = require("../../firefox-run-record.js");
const {
  COMMIT,
  TEST_FILE,
  fakeGit,
  finished,
  gitInfo,
  reporterEvents,
  started,
} = require("./firefoxRunRecordFixtures.js");

test("a clean worktree records only the commit", () => {
  // Arrange: 未コミット変更のない worktree
  const git = fakeGit();
  // Act: git の状態を集める
  const info = collectGitInfo(git.run);
  // Assert: commit と branch だけが入り、dirty ではなく diff も取らない
  assert.deepEqual(info, {
    commit: COMMIT,
    shortCommit: COMMIT.slice(0, 9),
    branch: "ticket/x",
    dirty: false,
    uncommittedFiles: [],
    uncommittedDiffSha256: null,
  });
  assert.equal(
    git.calls.some((args) => args[0] === "diff"),
    false,
  );
});

test("uncommitted source changes are recorded, earlier records are not", () => {
  // Arrange: ソースの変更・rename・未コミットの過去の記録がある worktree
  const git = fakeGit({
    status: [
      " M packages/webrtc/src/sdp.ts",
      "R  e2e/old.js -> e2e/new.js",
      `?? ${RECORDS_DIR}/20261114T000000Z-0123abcd.json`,
      "",
    ].join("\n"),
    diff: "diff --git a/x b/x\n",
  });
  // Act: git の状態を集める
  const info = collectGitInfo(git.run);
  // Assert: ソースの変更だけが dirty として残り、記録ディレクトリは除外される
  assert.equal(info.dirty, true);
  assert.deepEqual(info.uncommittedFiles, [
    "e2e/new.js",
    "packages/webrtc/src/sdp.ts",
  ]);
  assert.match(info.uncommittedDiffSha256, /^[0-9a-f]{64}$/);
  // diff の取得からも記録ディレクトリを除外している
  const diffArgs = git.calls.find((args) => args[0] === "diff");
  assert.ok(diffArgs.includes(`:(exclude)${RECORDS_DIR}`));
});

test("reporter events become totals and repository-relative per-test results", () => {
  // Arrange: 成功・retry 後の成功・失敗・skip と、切れた行を含む reporter の出力
  const root = "/repo";
  const ndjson = reporterEvents(root, [
    started("a"),
    finished("a", "passed"),
    started("b"),
    finished("b", "passed", { retryCount: 1, errors: ["Error: first try"] }),
    started("c"),
    finished("c", "failed", { errors: ["x".repeat(2500)] }),
    finished("d", "skipped"),
    { type: "end", reason: "failed", errors: [] },
  ]);
  // Act: 集計する
  const summary = summarizeEvents(`${ndjson}{"type":"te`, root);
  // Assert: 件数、相対パス、retry の記録、長い失敗メッセージの切り詰めを確認する
  assert.deepEqual(summary.totals, {
    files: 1,
    tests: 4,
    passed: 2,
    failed: 1,
    skipped: 1,
    unfinished: 0,
  });
  assert.equal(summary.runEnded, true);
  assert.equal(summary.endReason, "failed");
  assert.equal(summary.tests[0].file, TEST_FILE);
  assert.equal(summary.tests[0].failureMessages, undefined);
  assert.equal(summary.tests[1].retryCount, 1);
  assert.deepEqual(summary.tests[1].failureMessages, ["Error: first try"]);
  assert.match(summary.tests[2].failureMessages[0], /… \(500 more chars\)$/);
});

test("a hung run lists the tests that started without a result", () => {
  // Arrange: 2 件目の途中で止まり、終了イベントのない reporter の出力
  const root = "/repo";
  const ndjson = reporterEvents(root, [
    started("a"),
    finished("a", "failed", { errors: ["Error: timeout"] }),
    started("b"),
  ]);
  // Act: 集計する
  const summary = summarizeEvents(ndjson, root);
  // Assert: 結果のないテストが unfinished に入り、run は終わっていない扱いになる
  assert.equal(summary.runEnded, false);
  assert.equal(summary.totals.unfinished, 1);
  assert.deepEqual(summary.unfinished, [{ file: TEST_FILE, name: "suite b" }]);
});

test("a run without reporter output still gives an empty summary", () => {
  // Act: vitest が何も書かなかった (起動失敗など) 場合を集計する
  const summary = summarizeEvents("", "/repo");
  // Assert: 0 件の集計になり、記録は作れる
  assert.equal(summary.runEnded, false);
  assert.deepEqual(summary.totals, {
    files: 0,
    tests: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    unfinished: 0,
  });
  assert.deepEqual(summary.tests, []);
});

test("the record carries the commit and outcome, and its file name sorts by start time", () => {
  // Arrange: 失敗した実行の入力
  const startedAt = new Date("2026-11-14T01:02:03.456Z");
  const finishedAt = new Date("2026-11-14T01:12:03.456Z");
  // Act: 記録とファイル名を作る (clean / dirty の両方)
  const record = buildRecord({
    git: gitInfo,
    startedAt,
    finishedAt,
    exitCode: 1,
    vitestArgs: ["tests/bundle"],
    environment: { firefox: "157.0" },
    summary: summarizeEvents("", "/repo"),
  });
  const timedOut = buildRecord({
    git: gitInfo,
    startedAt,
    finishedAt,
    exitCode: 0,
    outcome: "timeout",
    stopReason: "no test event for 5 min (FIREFOX_E2E_IDLE_MIN)",
    vitestArgs: [],
    environment: {},
    summary: summarizeEvents("", "/repo"),
  });
  const dirtyName = recordFileName({ ...record, dirty: true });
  // Assert: commit・結果・所要時間が入り、ファイル名は時刻 + commit になる
  assert.equal(record.commit, COMMIT);
  assert.equal(record.result, "failed");
  assert.equal(record.outcome, "completed");
  // 時間切れで止めた実行は exit code に関係なく failed
  assert.equal(timedOut.result, "failed");
  assert.equal(timedOut.outcome, "timeout");
  assert.match(timedOut.stopReason, /FIREFOX_E2E_IDLE_MIN/);
  assert.equal(record.stopReason, null);
  assert.equal(record.durationSec, 600);
  assert.deepEqual(record.vitestArgs, ["tests/bundle"]);
  assert.equal(recordFileName(record), "20261114T010203Z-012345678.json");
  assert.equal(dirtyName, "20261114T010203Z-012345678-dirty.json");
});
