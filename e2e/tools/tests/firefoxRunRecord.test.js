const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  CI_TIMEOUT_MIN,
  RECORDS_DIR,
  buildRecord,
  collectGitInfo,
  recordFileName,
  runOptions,
  runnerExitCode,
  selectRecordsToPrune,
  summarizeEvents,
} = require("../../firefox-run-record.js");
const { keepFromEnv, pruneRecords } = require("../../firefox-runs-prune.js");
const {
  COMMIT,
  TEST_FILE,
  fakeGit,
  finished,
  gitInfo,
  recordNames,
  recordsDirWith,
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

test("pruning selects the oldest records beyond the kept count", () => {
  // Arrange: 順不同に並んだ 4 件の記録と、記録ではないファイル
  const [a, b, c, d] = recordNames([1, 2, 3, 4]);
  const names = [c, "README.md", a, d, b, "notes.txt"];
  // Act: 新しい 2 件を残す場合、全件消す場合、件数より多く残す場合を選ぶ
  const keepTwo = selectRecordsToPrune(names, 2);
  const clear = selectRecordsToPrune(names, 0);
  const keepMany = selectRecordsToPrune(names, 10);
  // Assert: 古い順に選ばれ、記録以外のファイルは選ばれない
  assert.deepEqual(keepTwo, [a, b]);
  assert.deepEqual(clear, [a, b, c, d]);
  assert.deepEqual(keepMany, []);
  // 不正な件数は拒否する
  assert.throws(() => selectRecordsToPrune(names, -1), /non-negative integer/);
  assert.throws(() => selectRecordsToPrune(names, Number.NaN), /non-negative/);
});

test("pruneRecords deletes old records and keeps other files", () => {
  // Arrange: 3 件の記録と README.md がある一時ディレクトリ
  const { existsSync, readdirSync, rmSync } = require("node:fs");
  const [a, b, c] = recordNames([1, 2, 3]);
  const dir = recordsDirWith([a, b, c]);
  try {
    // Act: dry-run で 1 件残す場合を確かめてから、実際に 1 件残して消す
    const listed = pruneRecords(dir, 1, { dryRun: true });
    const afterDryRun = readdirSync(dir).sort();
    const deleted = pruneRecords(dir, 1);
    // Assert: dry-run は何も消さず、実行後は最新の記録と README.md だけが残る
    assert.deepEqual(listed, [a, b]);
    assert.deepEqual(afterDryRun, [a, b, c, "README.md"].sort());
    assert.deepEqual(deleted, [a, b]);
    assert.deepEqual(readdirSync(dir).sort(), [c, "README.md"].sort());
    // ディレクトリがなければ何もしない
    assert.deepEqual(pruneRecords(`${dir}-missing`, 0), []);
    assert.equal(existsSync(`${dir}-missing`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the kept count comes from FIREFOX_RECORDS_KEEP or defaults to 20", () => {
  // Act / Assert: 未設定・空は既定の 20、設定値はそのまま数値になる
  assert.equal(keepFromEnv({}), 20);
  assert.equal(keepFromEnv({ FIREFOX_RECORDS_KEEP: "" }), 20);
  assert.equal(keepFromEnv({ FIREFOX_RECORDS_KEEP: "5" }), 5);
});

/** Paths runOptions resolves against in these tests. */
const runPaths = { repoRoot: "/repo", tmpdir: "/tmp" };

test("a local run records into firefox-runs/, prunes, and keeps the 60 min limit", () => {
  // Act: --ci なしの引数と空の環境から実行設定を作る
  const options = runOptions(["tests/bundle"], {}, runPaths);
  // Assert: repo 内の firefox-runs/ に書いて prune し、vitest の引数はそのまま
  assert.equal(options.ci, false);
  assert.equal(options.recordsDir, `/repo/${RECORDS_DIR}`);
  assert.equal(options.prune, true);
  assert.equal(options.timeoutMin, 60);
  assert.equal(options.idleMin, 5);
  assert.deepEqual(options.vitestArgs, ["tests/bundle"]);
  assert.equal(options.label, "firefox:record");
});

test("CI mode records outside the repository, never prunes, and lowers the time limit", () => {
  // Act: --ci 付きで、出力先の環境変数ごとに実行設定を作る
  const explicit = runOptions(
    ["--ci", "tests/ice"],
    { FIREFOX_RECORDS_DIR: "/out/records", RUNNER_TEMP: "/runner" },
    runPaths,
  );
  const runnerTemp = runOptions(["--ci"], { RUNNER_TEMP: "/runner" }, runPaths);
  const fallback = runOptions(["--ci"], {}, runPaths);
  const overridden = runOptions(
    ["--ci"],
    { FIREFOX_E2E_TIMEOUT_MIN: "45", FIREFOX_E2E_IDLE_MIN: "3" },
    runPaths,
  );
  // Assert: FIREFOX_RECORDS_DIR → $RUNNER_TEMP/firefox-runs → tmpdir の順に repo の外へ書く
  assert.equal(explicit.recordsDir, "/out/records");
  assert.equal(runnerTemp.recordsDir, "/runner/firefox-runs");
  assert.equal(fallback.recordsDir, "/tmp/werift-firefox-runs");
  for (const options of [explicit, runnerTemp, fallback]) {
    assert.equal(options.ci, true);
    assert.equal(options.prune, false);
    assert.equal(options.recordsDir.startsWith(`/repo/${RECORDS_DIR}`), false);
    assert.equal(options.timeoutMin, CI_TIMEOUT_MIN);
    assert.equal(options.label, "firefox:ci");
  }
  // Assert: --ci は vitest に渡さず、時間制限は環境変数で上書きできる
  assert.deepEqual(explicit.vitestArgs, ["tests/ice"]);
  assert.deepEqual(fallback.vitestArgs, []);
  assert.equal(overridden.timeoutMin, 45);
  assert.equal(overridden.idleMin, 3);
});

test("the runner exits 0 only for a passed record without unfinished tests or module errors", () => {
  // Arrange: 成功・失敗・時間切れ・未完了・module error の記録
  const recordWith = ({ exitCode = 0, outcome = "completed", summary = {} }) =>
    buildRecord({
      git: gitInfo,
      startedAt: new Date(0),
      finishedAt: new Date(1000),
      exitCode,
      outcome,
      vitestArgs: [],
      environment: {},
      summary: { ...summarizeEvents("", "/repo"), ...summary },
    });
  // Act / Assert: passed だけが 0 になる
  assert.equal(runnerExitCode(recordWith({})), 0);
  // vitest の失敗はその exit code のまま
  assert.equal(runnerExitCode(recordWith({ exitCode: 1 })), 1);
  // 時間切れで止めた実行は vitest の exit code が 0 でも非 0
  assert.equal(runnerExitCode(recordWith({ outcome: "timeout" })), 1);
  // シグナルで止めた実行はそのコード
  assert.equal(
    runnerExitCode(recordWith({ exitCode: 143, outcome: "interrupted" })),
    143,
  );
  // 未完了のテストや module error が残れば exit code 0 でも非 0
  assert.equal(
    runnerExitCode(
      recordWith({ summary: { unfinished: [{ file: "a", name: "b" }] } }),
    ),
    1,
  );
  assert.equal(
    runnerExitCode(recordWith({ summary: { moduleErrors: [{ file: "a" }] } })),
    1,
  );
});
