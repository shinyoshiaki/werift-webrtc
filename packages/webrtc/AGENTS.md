# AGENTS.md

## Purpose

Instructions for coding agents working in `packages/webrtc`.

## Scope

* Applies to `src`, `tests`, `tools/wpt-runner`, and package-local docs.
* This package is the main public WebRTC API (`RTCPeerConnection`, media, data channel).
* Optional `werift/polyfill` installs browser globals and `getUserMedia` via `mediaRegister`; an empty register provides plain empty audio/video tracks. `peerConnectionConfig` supplies per-install defaults. It is not re-exported from `src/index.ts`; Node projects without DOM types use `werift/polyfill`, while DOM projects can import `werift/polyfill/dom`.
* Lower-level protocol packages (`ice`, `dtls`, `rtp`, `sctp`, `common`) are dependencies; fix protocol bugs in those packages when the root cause lives there.
* Upstream WPT harness code lives under `tools/wpt-runner/`; do not leak stricter shims into default `src` behavior.

## Do

1. Prefer package-local validation (`npm test`, `npm run type`) before workspace-wide commands.
2. Keep Arrange helpers reusable. Memleak Arrange utilities live in `tests/memleak/heapUtils.ts` and scenarios in `tests/memleak/scenarios.ts`.
3. Add Japanese comments in Act / Assert phases when operation order or expectations are not obvious.
4. When adding package scripts, update this guide's Commands table in the same change.
5. Keep `tests/memleak/**` out of the default Vitest suite. The deterministic leak property in `tests/pbt/leak/` is part of `npm test`; set each of its tests to `retry: 0`. Its heap-slope part (P3) runs only with `WERIFT_NEGOTIATION_LEAK_HEAP=1` (`npm run pbt:deep`).
6. For negotiation changes (`negotiationTransaction.ts`, description apply paths in `peerConnection.ts`, `src/negotiation/*`, router / receiver / sender tables), the implementation and tests are the source of truth. `NegotiationTransaction` TSDoc documents phases, signaling transitions, per-subsystem mutation timing, and snapshot ownership; document each new or changed rule there and verify it with a test. A pending description may add routing keys but must not change a key the current session uses (reject before mutation or stage until commit). Keep `assertNegotiationInvariants` in `tests/negotiation/harness/negotiationTransactionUtils.ts` able to detect new state classes. Put invariant-only cases in `tests/pbt/scenario/negotiationScenarioProperty.test.ts`; operation-sequence claims belong in `tests/pbt/model/oracles.ts` with needed operations in `model/generator.ts` (wire SDP mutations in `model/wireMutations.ts`) and minimized failures in `model/scenes.ts`. Timing, concurrency, special environments, and concrete ICE / DTLS / BUNDLE / RFC codec values stay individual tests. Cases use descriptions and candidates created by werift; browser and other-implementation interoperability belongs in `e2e/`.
7. Property tests live in `tests/pbt/`: negotiation suites in `fuzz/`, `scenario/`, `model/`, and `leak/`; media suites in `twcc/`, `bwe/`, and `sender/`. Put each property test in its own directory with its `generator.ts`; shared seeded randomness and replay configuration live in `shared/random.ts` and `shared/seeds.ts`. The leak property keeps setup and measurement in `leak/leakProbe.ts`, scenes and cycles in `leak/scenes.ts`; add a `leakFootprint` metric for new session state and document intentional bounds in `BOUNDED_METRICS`.
8. Before reviewing negotiation changes, run the deeper searches with `npm run pbt:deep` (default suites: `fuzz,scenario,model,leak`; supports `--seeds`, `--steps`, `--jobs`, and `--heap-seeds`). It runs the corresponding negotiation properties with 300 seeds by default; replay printed seeds using their `WERIFT_NEGOTIATION_*_SEED` / `_STEPS` variables. For media properties, run `npm run pbt:deep -- --suite twcc,bwe,sender`. Review all paths that write live state while a description is pending. A value live during a pending description follows `expectedLive` in `tests/negotiation/harness/negotiationTransactionUtils.ts`; encode new rules there before changing implementation.
9. A change to how created descriptions are applied later or again must preserve the description reuse contract in `tools/negotiation-diff/scenarios.ts` (`--check` exits 1 on mismatch). Compare with develop in a separate temporary worktree using `tools/negotiation-diff` (see `run.ts` header); never check out develop in the active worktree. Keep difference count at 0.

## Don't

* Do not run memleak as part of `npm test` / CI; use `npm run memleak` only.
* Do not enable Vitest retry for memleak (it hides leak failures).
* Do not silence leak detections; open a follow-up for root-cause fixes if a real leak is found.
* Do not keep negotiation design rules, spec-to-test maps, or test migration tables in separate documents; put rules in implementation TSDoc and verify them with tests.

## Commands

| Task | Command |
| --- | --- |
| test package | `npm test` |
| type-check package | `npm run type` |
| format package | `npm run format` |
| package-local GCC/TWCC simulation (CI-excluded) | `npm run test:sim` |
| memory leak test (Node 24+, local only) | `npm run memleak` |
| deep negotiation property search including leak property | `npm run pbt:deep` |
| deep media property search (TWCC / BWE / sender) | `npm run pbt:deep -- --suite twcc,bwe,sender` |
| leak property evidence (`repeat [N]`, `inject`) | `npm run leak:verify -- repeat 10` / `npm run leak:verify -- inject` |
| allowlisted upstream WPT | `npm run wpt` |
| WPT coverage | `npm run wpt:coverage` |

Memleak details, env vars, and report interpretation: `tests/memleak/README.md`.
Package-local bottleneck sims: `simulations/` (`npm run test:sim`). Chrome peer sims live under `e2e/simulations/` (`cd e2e && npm run test:sim`). Both are CI-excluded; run them manually before GCC / TWCC / BottleneckLink changes.

## Validation

* Logic changes in `src`: `npm run type` and relevant `npm test` paths.
* GCC / TWCC / BottleneckLink changes: `npm run test:sim` and `cd e2e && npm run test:sim` when the Chrome path may be affected.
* TWCC / BWE / sender send-path changes: `npm run pbt:deep -- --suite twcc,bwe,sender`; replay failed seeds from their test title.
* Negotiation changes: full `npm test` plus `npm run pbt:deep` before review.
* Memleak harness changes: short smoke with reduced env (see `tests/memleak/README.md`), then optional full `npm run memleak`.
* WPT runner / allowlist changes: `npm run wpt`.

## Maintenance

* Keep this guide aligned with `package.json` scripts.
* When memleak scripts or artifact paths change, update `tests/memleak/README.md` and this Commands table together.
