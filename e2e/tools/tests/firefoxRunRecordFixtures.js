/** Shared Arrange data for firefoxRunRecord.test.js. */
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/**
 * A git runner answering the commands collectGitInfo issues. `status` is the
 * `git status --porcelain` output, `diff` the `git diff HEAD` output.
 */
function fakeGit({ status = "", diff = "", branch = "ticket/x" } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "HEAD") return `${COMMIT}\n`;
    if (args[0] === "rev-parse") return `${branch}\n`;
    if (args[0] === "status") return status;
    if (args[0] === "diff") return diff;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return { run, calls };
}

/** Repository-relative file of the tests in reporterEvents. */
const TEST_FILE = "e2e/tests/bundle/max-bundle.test.ts";

/** NDJSON written by firefox-run-reporter.mjs, with absolute file paths. */
function reporterEvents(rootDir, events) {
  return events
    .map((event) =>
      JSON.stringify(
        event.file ? { ...event, file: `${rootDir}/${event.file}` } : event,
      ),
    )
    .map((line) => `${line}\n`)
    .join("");
}

/** The `start` event of test `suite <id>`. */
const started = (id) => ({
  type: "start",
  file: TEST_FILE,
  name: `suite ${id}`,
});

/** The `test` (result) event of test `suite <id>`. */
const finished = (id, state, { retryCount = 0, errors = [] } = {}) => ({
  type: "test",
  file: TEST_FILE,
  name: `suite ${id}`,
  state,
  durationMs: 100,
  retryCount,
  errors,
});

const gitInfo = {
  commit: COMMIT,
  shortCommit: COMMIT.slice(0, 9),
  branch: "ticket/x",
  dirty: false,
  uncommittedFiles: [],
  uncommittedDiffSha256: null,
};

module.exports = {
  COMMIT,
  TEST_FILE,
  fakeGit,
  finished,
  gitInfo,
  reporterEvents,
  started,
};
