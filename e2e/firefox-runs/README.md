# Firefox E2E run records

Every run of the Firefox E2E suite (`e2e/vitest.firefox.config.mts`) through
`e2e/run-firefox.js` saves one run record with the commit it tested.

- **CI**: the `firefox-e2e` job of `.github/workflows/nodejs.yml` runs the
  whole suite on every push / PR (`npm run firefox:ci`, see
  [CI mode](#ci-mode)). Its record and the failure screenshots
  (`e2e/.vitest/attachments/`) are uploaded as the job's artifact, so CI
  holds the regular history.
- **Local**: `npm run firefox:record` saves the record in this directory.
  Commit it when it backs a Firefox result you verified locally (for example
  a Firefox fix); it must come from a committed, clean HEAD with no extra args.

## Run

```bash
cd e2e && npm i
npm run firefox:record                    # whole Firefox suite
npm run firefox:record -- tests/bundle    # extra vitest args / filters
```

The runner (`e2e/run-firefox.js`) installs Playwright Firefox into the
harness's private Playwright cache (`e2e/node_modules/.cache/ms-playwright`,
or `PLAYWRIGHT_BROWSERS_PATH`) when it is missing, starts the e2e server on a
free port, and runs vitest with `e2e/vitest.firefox.record.config.mts` (the
Firefox config plus the reporter `e2e/firefox-run-reporter.mjs`, which writes
each test's start and result as it happens). It stops the server by its
`/stop` endpoint, then by PID, and vitest with its browsers by process group
PID. The record is written however the run ends: vitest exits, the time limit
`FIREFOX_E2E_TIMEOUT_MIN` (default 60) or the idle limit `FIREFOX_E2E_IDLE_MIN`
(default 5 min without a test event; a test stuck past its own timeout was
seen in Firefox) stops it, the runner fails, or SIGINT /
SIGTERM stops the runner. The exit code is 0 only for a `passed` record with
no unfinished test and no module error; otherwise vitest's code (1 on the time
limit or a runner failure, 130 / 143 on a signal).

## CI mode

`npm run firefox:ci` (`run-firefox.js --ci`) is what the `firefox-e2e` job
runs. It differs from `firefox:record` only in:

- The record goes outside the repository: `FIREFOX_RECORDS_DIR`, else
  `$RUNNER_TEMP/firefox-runs`, else `<os tmpdir>/werift-firefox-runs`. The job
  sets `FIREFOX_RECORDS_DIR=$RUNNER_TEMP/firefox-runs` and uploads it. The
  committed records here are never touched.
- Nothing is pruned.
- `FIREFOX_E2E_TIMEOUT_MIN` defaults to 20, below the E2E step's
  `timeout-minutes: 25`; the job's 45 minutes leave room for setup, so even a
  suite that hangs ends with a record. An empty, non-numeric or non-positive
  `FIREFOX_E2E_TIMEOUT_MIN` / `FIREFOX_E2E_IDLE_MIN` falls back to the default.

The exit code rule is the same, so any result other than `passed` fails the
job. The job installs Firefox with `npx playwright install --with-deps
firefox` from `e2e/` into `PLAYWRIGHT_BROWSERS_PATH=e2e/node_modules/.cache/ms-playwright`.

## Retention

The runner keeps the newest `FIREFOX_RECORDS_KEEP` records (default 20) and
deletes older ones after saving each record; the record it just saved always
stays. Prune or clear by hand with:

```bash
cd e2e
npm run firefox:record:prune                  # keep the newest FIREFOX_RECORDS_KEEP (20)
npm run firefox:record:prune -- --keep 5      # keep the newest 5
npm run firefox:record:prune -- --keep 0      # clear every record
npm run firefox:record:prune -- --dry-run     # list what would be deleted
```

Only files named like a record are deleted (this README stays). Commit the
deletions with the new record; deleted records remain in git history.

## Record

One JSON file per run: `<UTC start time>-<short commit>[-dirty].json`
(format: `e2e/firefox-run-record.js`, `version` field).

| Field | Meaning |
| --- | --- |
| `commit` / `shortCommit` / `branch` | `HEAD` when the run started |
| `dirty` / `uncommittedFiles` / `uncommittedDiffSha256` | Uncommitted changes the run included (records in this directory are ignored). With `dirty: true`, the commit alone does not reproduce the tested code; the hash identifies the tracked diff |
| `startedAt` / `finishedAt` / `durationSec` | Run time |
| `outcome` / `stopReason` | `completed` (vitest exited), `timeout` (`stopReason` names the limit), `interrupted` (signal) or `error` (runner failure) |
| `exitCode` / `result` | `passed` only when the outcome is `completed` and vitest exited with 0 |
| `vitestArgs` | Extra args passed after `--` (empty: whole suite) |
| `environment` | Firefox, Playwright, vitest and Node.js versions, and the OS |
| `runEnded` / `endReason` / `unhandledErrors` | Whether vitest reported the end of the run, and its reason and unhandled errors |
| `totals` / `tests` | Per-test status, duration, retry count and error messages (truncated to 2000 chars; a test that passed on its retry keeps the first try's error) |
| `unfinished` | Tests that started without a result: where a hung or stopped run was |
| `moduleErrors` | Errors of a test file itself (for example an import failure) |

The suite config retries a failed test once (`retry: 1`).
