# AGENTS.md

## Purpose

Instructions for coding agents working in `packages/webrtc`.

## Scope

* Applies to `src`, `tests`, `tools/wpt-runner`, and package-local docs.
* This package is the main public WebRTC API (`RTCPeerConnection`, media, data channel).
* Optional `werift/polyfill` (`src/polyfill`) installs browser globals and `getUserMedia` via required `mediaRegister`; `peerConnectionConfig` supplies per-install PC defaults, and fixed-codec register tracks constrain rather than expand PC capabilities. An empty array supplies plain empty audio/video tracks. It is not re-exported from `src/index.ts`. Node TypeScript without DOM uses `werift/polyfill` for constructor globals; DOM-lib projects should import `werift/polyfill/dom`. On Node it also complements a missing or `Node.js/<major>` `navigator.userAgent` with a Chromium-compatible value. Existing non-Node User-Agents are kept unless `userAgent` is passed.
* Lower-level protocol packages (`ice`, `dtls`, `rtp`, `sctp`, `common`) are dependencies; prefer fixing protocol bugs in those packages when the root cause lives there.
* Upstream WPT harness code lives under `tools/wpt-runner/` and must not leak stricter shims into default `src` behavior.

## Do

1. Prefer package-local validation (`npm test`, `npm run type`) before workspace-wide commands.
2. Keep Arrange helpers reusable; memleak Arrange utilities live in `tests/memleak/heapUtils.ts` and scenario setup in `tests/memleak/scenarios.ts`.
3. Add Japanese comments in Act / Assert phases when operation order or expectations are not obvious.
4. When adding package scripts, update this guide's Commands table in the same change.
5. Keep memleak tests out of the default vitest suite (`vitest.config.mts` excludes `tests/memleak/**`). The leak property (`tests/pbt/leak`) is deterministic and stays in `npm test`, each test with `retry: 0`; its heap-slope part (P3) runs only with `WERIFT_NEGOTIATION_LEAK_HEAP=1` (`npm run pbt:deep`).
6. For negotiation changes, the TSDoc of `NegotiationTransaction` (`src/negotiationTransaction.ts`), implementation comments and tests are the source of truth for invariants, signaling transitions, mutation timing and snapshot ownership. Record changed implementation rules there and verify them in tests. Keep `NEGOTIATION_TRANSACTION.md` and `NEGOTIATION_SPEC_COVERAGE.md` current as the ticket's design, leak findings and requirement-to-test map; a pending description may add routing keys but must not change a key the current session uses (reject before mutation or stage until commit). Keep `assertNegotiationInvariants` able to detect new state, and add a found failure as a deterministic case or replayed seed. Verdicts based on invariants, unchanged state, continued traffic or a baseline match belong in scenario properties; claims over arbitrary operation sequences belong in model oracles; timing, concurrency, special environments and concrete protocol values remain individual tests. Use werift-created descriptions in negotiation cases; browser and other implementation SDP interoperability belongs in `e2e/`.
7. Negotiation and leak properties live in `tests/pbt/`, one directory per property (`fuzz/`, `scenario/`, `model/`, `leak/`) with `shared/` for the seeded random stream. Keep Arrange helpers reusable, Japanese Act / Assert comments where intent is not obvious, and leak Arrange/measurement in `leak/leakProbe.ts`. The deterministic leak property runs in `npm test` with `retry: 0`; P3 heap slope runs only with `WERIFT_NEGOTIATION_LEAK_HEAP=1` under `npm run pbt:deep`. Fixed leak scenes and cycles live in `leak/scenes.ts`; new session state gets a `leakFootprint` metric and an explicit bound when intentionally retained.
8. Before requesting review of negotiation changes, run `npm run pbt:deep` (parallel; `--suite fuzz,scenario,model,leak`, `--seeds`, `--steps`, `--jobs`, `--heap-seeds`) and review every path writing live state while a description is pending. Replay uses `WERIFT_NEGOTIATION_SCENARIO_SEED` / `_STEPS`, `WERIFT_NEGOTIATION_MODEL_SEED` / `_STEPS`, and `WERIFT_NEGOTIATION_LEAK_SEED` / `_STEPS` / `_CYCLES`. A live pending value follows the effective-values rules implemented by `expectedLive` in `tests/negotiation/harness/negotiationTransactionUtils.ts`.
9. A change to applying created descriptions later or again must preserve the reuse contract in `tools/negotiation-diff/scenarios.ts`: compare with develop using `tools/negotiation-diff` as described in `run.ts` (never in the active worktree) and keep its difference count at 0. The runner also checks unsettled operations, unexpected failed states and transceiver states against develop.

## Don't

* Do not run memleak as part of `npm test` / CI; use `npm run memleak` only.
* Do not enable vitest `retry` for memleak (hides leak failures).
* Do not silence leak detections; open a follow-up for root-cause fixes if a real leak is found.
* Do not keep negotiation design rules, spec-to-test maps or test migration tables in separate documents; they drift from the code. Put a rule in the TSDoc of its implementation and verify it with a test.

## Commands

| Task | Command |
| --- | --- |
| test package | `npm test` |
| type-check package | `npm run type` |
| format package | `npm run format` |
| memory leak test (Node 24+, local only) | `npm run memleak` |
| deep negotiation property search incl. leak property (parallel, before review) | `npm run pbt:deep` |
| allowlisted upstream WPT | `npm run wpt` |
| WPT coverage | `npm run wpt:coverage` |

Memleak details, env vars, and report interpretation: `tests/memleak/README.md`.

## Validation

* Logic changes in `src`: `npm run type` and relevant `npm test` paths.
* Negotiation changes: the full `npm test` (includes the negotiation property tests with their fixed scenes and regression seeds), plus the deeper property searches above before review.
* Memleak harness changes: short smoke with reduced env (see `tests/memleak/README.md`), then optional full `npm run memleak`.
* WPT runner / allowlist: `npm run wpt`.

## Maintenance

* Keep this guide aligned with `package.json` scripts.
* When memleak scripts or artifact paths change, update `tests/memleak/README.md` and this Commands table together.
