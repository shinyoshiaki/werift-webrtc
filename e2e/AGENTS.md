# AGENTS.md

## Purpose

Instructions for coding agents working in `e2e/`, the browser E2E suite: browser tests under `tests/` (vitest browser mode) against a werift server under `server/`.

## Scope

* `tests/**` run in the browser; `server/**` is the werift side (one handler per test label in `server/main.ts`); `tools/tests/**` are Node-only tests of the harness scripts.
* Chrome: `vitest.config.mts`, run by CI (`npm run ci` → `run-ci.js`).
* Firefox: `vitest.firefox.config.mts`, local only, not in CI. Its official path is `npm run firefox:record` (`run-firefox.js`), which saves a run record under `firefox-runs/` (see `firefox-runs/README.md`).
* Settings shared by both configs live in `vitest.shared.mts`; each config adds only its browser provider. `vitest.firefox.record.config.mts` extends the Firefox config with the run-record reporter.
* `tests/dtls/**` is the DTLS version suite (DTLS 1.2 / 1.3 against Chromium): its own config `vitest.dtls.config.mts`, run by CI after the Chrome suite (`run-dtls-ci.js`), and excluded from the Chrome and Firefox configs (`vitest.shared.mts`). Its shared setup is `tests/dtls/fixture.ts`, which builds on `tests/fixture.ts`; the Chromium launch arguments are in `tests/dtls/chromiumLaunch.ts`.
* `tests/sped/**` is the opt-in Chromium SPED interop suite (Chromium with `WebRTC-IceHandshakeDtls/Enabled/` against werift `sped: true`): its own config `vitest.sped.config.mts`, run by `npm run sped:ci`, not by CI or `npm run e2e`. Its shared setup is `tests/sped/fixture.ts`, which builds on `tests/dtls/fixture.ts`.
* `simulations/` is a separate suite (`npm run test:sim`) and stays out of both configs.

## Do

1. Read the root `AGENTS.md` first.
2. Run Firefox through `npm run firefox:record [-- <vitest args>]`, and commit the record with the change it verified. A record that backs a result must come from a committed, clean HEAD (no `-dirty`) with no extra args.
3. For manual Firefox debugging, start the server yourself and stop it through `/stop`: `E2E_PORT=<port> npm run server`, then `VITE_E2E_PORT=<port> PLAYWRIGHT_BROWSERS_PATH=$PWD/node_modules/.cache/ms-playwright npm run firefox -- <file>` (the Firefox that `firefox:record` installs), then `E2E_PORT=<port> node stop.js`.
4. Skip a test in Firefox only with `itSkipOnFirefox(reason)` from `tests/fixture.ts`, with a reason from `firefoxKnownIssue` (a werift bug: `[firefox-known:<name>] <first 8 chars of the ticket ID>: ...`) or `firefoxUnsupported` (Firefox lacks what the test needs: `[firefox-unsupported:<feature>] ...`). Add new reasons to those constants. When a known issue is fixed, find its skips with `grep -rn "firefox-known:<name>" e2e/tests` and remove them.
5. When a test checks a browser-specific format or counter (SDP layout, `webkitAudioDecodedByteCount`), keep the browser-neutral check for every browser and limit only the format check, instead of skipping the test.
6. Write tests as Arrange / Act / Assert with Japanese comments, and keep shared setup in `tests/fixture.ts` (the DTLS suite's own setup in `tests/dtls/fixture.ts`).

## Don't

* Don't add Firefox to CI (`.github/workflows/nodejs.yml`) or to `run-ci.js`.
* Don't skip a Firefox test without a tagged reason, and don't leave a test undefined in Firefox: a suite with no test is a module error in the run record.
* Don't work around werift bugs in `server/handler/*` or by rewriting SDP; record them as tickets and skip with `firefoxKnownIssue`.
* Don't edit run records by hand. Prune them with `npm run firefox:record:prune`.
* Don't stop the server or browsers with `npm run clean`, `pkill -f` or `killall`.

## Commands

| Task | Command |
| --- | --- |
| Chrome suite as CI runs it (build, server, vitest, stop) | `npm run ci` |
| DTLS version suite against a running server | `npm run dtls` |
| Chromium SPED interop suite (build, server, vitest, stop; opt-in, not in CI) | `npm run sped:ci` |
| Firefox suite with a run record | `npm run firefox:record [-- <vitest args>]` |
| prune / clear Firefox run records | `npm run firefox:record:prune [-- --keep <n> \| --dry-run]` |
| Firefox suite against a running server | `npm run firefox` |
| e2e server from TypeScript sources | `npm run server` |
| type-check server and tests | `npm run type` |
| harness script tests | `npm run test:tools` |
| format | `npm run format` |

## Validation

* Test or fixture changes: `npm run type`, then the affected file with `npm run firefox:record -- <file>` and the Chrome suite (`npm run e2e` at the root).
* Config changes (`vitest*.mts`): the whole Chrome suite and a whole `npm run firefox:record`.
* DTLS suite changes (`tests/dtls/**`, `vitest.dtls.config.mts`, `run-dtls-*.js`): the DTLS suite through `npm run e2e` at the root (it runs after the Chrome suite), plus `npm run sped:ci` when `tests/dtls/fixture.ts` or the SPED handling changes.
* SPED suite or werift SPED changes (`tests/sped/**`, `vitest.sped.config.mts`, SPED in `packages/ice` / `packages/webrtc`): `npm run sped:ci`.
* Harness script changes (`run-firefox.js`, `firefox-run-record.js`, `firefox-run-reporter.mjs`, `firefox-runs-prune.js`): `npm run test:tools`, and update `firefox-runs/README.md`.

## Maintenance

* Update this guide when scripts, configs or the skip policy change, and keep the Arrange / Act / Assert rule aligned with the root guide.
