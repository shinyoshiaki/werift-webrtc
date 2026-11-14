# Firefox E2E run records

CI does not run the Firefox E2E suite (`e2e/vitest.firefox.config.mts`).
Each local run of it saves one record here, and the records are committed, so
the history of Firefox runs stays in the repository with the commit each run
tested.

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
SIGTERM stops the runner. The exit code is vitest's (1 on the time limit or a
runner failure, 130 / 143 on a signal). Commit the new record file together
with the change it verified.

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
