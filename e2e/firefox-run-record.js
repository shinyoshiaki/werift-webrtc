/**
 * Builds the run record that `run-firefox.js` saves for every Firefox E2E
 * run: which commit (and which uncommitted changes) ran, in which Firefox,
 * with which per-test result. A local run (`npm run firefox:record`) saves it
 * under `firefox-runs/` (committed when it backs a local result); the CI job
 * (`npm run firefox:ci`) saves it outside the repository and uploads it as an
 * artifact. Pure functions only; the runner does the I/O.
 */
const { createHash } = require("node:crypto");
const { join, relative, resolve } = require("node:path");

/** Record format version, bumped when a field changes meaning. */
const RECORD_VERSION = 1;

/** Directory of the records, relative to the repository root. */
const RECORDS_DIR = "e2e/firefox-runs";

/** Longest failure message kept per test (the record stays reviewable). */
const MAX_FAILURE_LENGTH = 2000;

/**
 * Git state of the run. `run` executes a git command and returns its stdout.
 * Changes under `firefox-runs/` (earlier records not yet committed) do not
 * count as uncommitted source changes.
 */
function collectGitInfo(run) {
  const commit = run(["rev-parse", "HEAD"]).trim();
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const uncommittedFiles = run([
    "status",
    "--porcelain",
    "--untracked-files=all",
  ])
    .split("\n")
    .filter((line) => line.trim())
    // A rename (`R  old -> new`) counts as its new path.
    .map((line) => line.slice(3).split(" -> ").pop().trim())
    .filter((file) => !file.startsWith(`${RECORDS_DIR}/`))
    .sort();
  const diff = uncommittedFiles.length
    ? run(["diff", "HEAD", "--", ".", `:(exclude)${RECORDS_DIR}`])
    : "";
  return {
    commit,
    shortCommit: commit.slice(0, 9),
    branch,
    dirty: uncommittedFiles.length > 0,
    uncommittedFiles,
    // Identifies the tracked uncommitted changes the run included.
    uncommittedDiffSha256: diff
      ? createHash("sha256").update(diff).digest("hex")
      : null,
  };
}

function truncate(text) {
  return text.length > MAX_FAILURE_LENGTH
    ? `${text.slice(0, MAX_FAILURE_LENGTH)}… (${text.length - MAX_FAILURE_LENGTH} more chars)`
    : text;
}

/**
 * Totals and per-test results from the event lines of
 * `firefox-run-reporter.mjs` (NDJSON). `rootDir` makes the file paths
 * repository-relative. A test that started but has no result (the run hung or
 * was stopped there) is listed in `unfinished`. Error messages of a test that
 * passed on its retry are kept, so a flaky pass stays visible.
 */
function summarizeEvents(ndjson, rootDir) {
  const events = ndjson
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        // A line cut off by a killed process.
        return [];
      }
    });
  const fileOf = (event) => relative(rootDir, event.file);
  const keyOf = (event) => `${event.file}\u0000${event.name}`;
  const finished = new Set();
  const tests = [];
  for (const event of events.filter((e) => e.type === "test")) {
    finished.add(keyOf(event));
    tests.push({
      file: fileOf(event),
      name: event.name,
      status: event.state,
      durationMs: event.durationMs,
      ...(event.retryCount ? { retryCount: event.retryCount } : {}),
      ...(event.errors?.length
        ? { failureMessages: event.errors.map((message) => truncate(message)) }
        : {}),
    });
  }
  const unfinished = events
    .filter((e) => e.type === "start" && !finished.has(keyOf(e)))
    .map((e) => ({ file: fileOf(e), name: e.name }));
  const moduleErrors = events
    .filter((e) => e.type === "module")
    .map((e) => ({ file: fileOf(e), errors: e.errors.map(truncate) }));
  const end = events.find((e) => e.type === "end");
  const count = (status) => tests.filter((t) => t.status === status).length;
  return {
    // false: vitest never reported the end of the run (hung, killed, crashed).
    runEnded: !!end,
    endReason: end?.reason ?? null,
    unhandledErrors: (end?.errors ?? []).map(truncate),
    totals: {
      files: new Set([...tests, ...unfinished].map((t) => t.file)).size,
      tests: tests.length,
      passed: count("passed"),
      failed: count("failed"),
      skipped: tests.length - count("passed") - count("failed"),
      unfinished: unfinished.length,
    },
    tests,
    unfinished,
    moduleErrors,
  };
}

/** The record saved for one run. */
function buildRecord({
  git,
  startedAt,
  finishedAt,
  exitCode,
  outcome = "completed",
  stopReason = null,
  vitestArgs,
  environment,
  summary,
}) {
  return {
    version: RECORD_VERSION,
    suite: "e2e firefox (vitest.firefox.config.mts)",
    commit: git.commit,
    shortCommit: git.shortCommit,
    branch: git.branch,
    dirty: git.dirty,
    uncommittedFiles: git.uncommittedFiles,
    uncommittedDiffSha256: git.uncommittedDiffSha256,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSec: Math.round((finishedAt - startedAt) / 1000),
    exitCode,
    // completed: vitest exited by itself; timeout: the runner's time limit
    // stopped it; interrupted: SIGINT / SIGTERM stopped the runner; error: the
    // runner failed (server start, vitest spawn) before vitest finished.
    outcome,
    // Which limit stopped a `timeout` run (null otherwise).
    stopReason,
    result: outcome === "completed" && exitCode === 0 ? "passed" : "failed",
    vitestArgs,
    environment,
    runEnded: summary.runEnded,
    endReason: summary.endReason,
    unhandledErrors: summary.unhandledErrors,
    totals: summary.totals,
    tests: summary.tests,
    unfinished: summary.unfinished,
    moduleErrors: summary.moduleErrors,
  };
}

/** File name of a record: sortable by start time, then the commit. */
function recordFileName(record) {
  const stamp = record.startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${record.shortCommit}${record.dirty ? "-dirty" : ""}.json`;
}

/** Time limit of a CI run (minutes), below the E2E step's `timeout-minutes`. */
const CI_TIMEOUT_MIN = 20;

/**
 * Runner options from its arguments and environment. `--ci` (CI mode, the
 * `firefox-e2e` job) writes the record outside the repository
 * (`FIREFOX_RECORDS_DIR`, else `$RUNNER_TEMP/firefox-runs`, else
 * `<tmpdir>/werift-firefox-runs`), never prunes, and lowers the default time
 * limit to {@link CI_TIMEOUT_MIN}, so a hung suite still ends with a record
 * before the job's own timeout. Other args go to vitest.
 */
/**
 * Minutes from an environment variable. An unset, empty, non-numeric,
 * non-finite or non-positive value (e.g. a CI variable expanded while unset)
 * falls back to `fallback`, so it never fires the time limit at once.
 */
function positiveMinutes(value, fallback) {
  if (value === undefined || value.trim() === "") return fallback;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : fallback;
}

function runOptions(argv, env, { repoRoot, tmpdir }) {
  const ci = argv.includes("--ci");
  const vitestArgs = argv.filter((arg) => arg !== "--ci");
  const recordsDir = ci
    ? resolve(
        env.FIREFOX_RECORDS_DIR ||
          (env.RUNNER_TEMP
            ? join(env.RUNNER_TEMP, "firefox-runs")
            : join(tmpdir, "werift-firefox-runs")),
      )
    : join(repoRoot, RECORDS_DIR);
  const timeoutMin = positiveMinutes(
    env.FIREFOX_E2E_TIMEOUT_MIN,
    ci ? CI_TIMEOUT_MIN : 60,
  );
  const idleMin = positiveMinutes(env.FIREFOX_E2E_IDLE_MIN, 5);
  return {
    ci,
    vitestArgs,
    recordsDir,
    prune: !ci,
    timeoutMin,
    idleMin,
    label: ci ? "firefox:ci" : "firefox:record",
  };
}

/**
 * Exit code of the runner: 0 only for a `passed` record (completed, vitest
 * exited with 0), so a failure, a time limit, unfinished tests or a module
 * error fail the CI job; otherwise the runner's code (at least 1).
 */
function runnerExitCode(record) {
  const clean =
    record.result === "passed" &&
    record.unfinished.length === 0 &&
    record.moduleErrors.length === 0;
  if (clean) return 0;
  return record.exitCode || 1;
}

/** Records kept by default: the runner prunes older ones after each run. */
const DEFAULT_RECORDS_KEEP = 20;

/** A record file name as recordFileName writes it (README.md and others excluded). */
const RECORD_FILE_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]+(?:-dirty)?\.json$/;

/**
 * Record files to delete so that the newest `keep` remain. File names sort by
 * start time (recordFileName), so the oldest go first. Other files are never
 * selected. `keep` must be a non-negative integer (0 clears every record).
 */
function selectRecordsToPrune(fileNames, keep) {
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error(`keep must be a non-negative integer: ${keep}`);
  }
  const records = fileNames
    .filter((name) => RECORD_FILE_PATTERN.test(name))
    .sort();
  return records.slice(0, Math.max(0, records.length - keep));
}

module.exports = {
  CI_TIMEOUT_MIN,
  DEFAULT_RECORDS_KEEP,
  RECORDS_DIR,
  RECORD_VERSION,
  buildRecord,
  collectGitInfo,
  recordFileName,
  runOptions,
  runnerExitCode,
  selectRecordsToPrune,
  summarizeEvents,
};
