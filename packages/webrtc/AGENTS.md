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
5. Keep memleak tests out of the default vitest suite (`vitest.config.mts` excludes `tests/memleak/**`).
6. For negotiation changes (`negotiationTransaction.ts`, description apply paths in `peerConnection.ts`, `src/negotiation/*`, router / receiver / sender tables), the implementation and the tests are the source of truth: the invariant, phases, signaling transitions, per-subsystem mutation timing and snapshot owners are the TSDoc of `NegotiationTransaction` (`src/negotiationTransaction.ts`), and each rule is documented at the code that implements it and verified by a test. Record a new or changed rule there and in a test. A pending description may add routing keys but must not change a key the current session uses (reject before mutation or stage until commit). Keep `assertNegotiationInvariants` in `tests/negotiation/harness/negotiationTransactionUtils.ts` able to detect a new class of state, and add a found failure as a deterministic case or a replayed seed. A test whose verdict is only invariants, unchanged state, continued traffic or a baseline match belongs to a property of `tests/pbt/scenario/negotiationScenarioProperty.test.ts` as a fixed scene (scenario text), not to a new individual test; a claim that holds after any operation sequence (traffic, JSEP transition, rollback, events, idempotence, trickle, RTCP feedback, selected pair, commit) belongs to an oracle of the model property (`tests/pbt/model/oracles.ts`), with the operations it needs in the generator of `model/generator.ts` (SDP rewrites on the wire in `model/wireMutations.ts`) and a found failure as a short operation list in `model/scenes.ts`; timing, concurrency, special environments and concrete ICE / DTLS / BUNDLE / RFC codec values stay individual tests. A case uses only descriptions and candidates werift creates itself: interoperability with browsers and other implementations (their SDP shapes, candidates such as mDNS) is the end-to-end tests' responsibility (`e2e/`), so do not fabricate another peer's description in `tests/negotiation/cases`. Negotiation tests live in `tests/negotiation/`: the shared infrastructure in `tests/negotiation/harness/` (Arrange helpers and `assertNegotiationInvariants` in `negotiationTransactionUtils.ts`, the case harness in `negotiationCase.ts`) and the cases in `tests/negotiation/cases/`. Property tests live in `tests/pbt/`: one directory per property test (`fuzz/`, `scenario/`, `model/`) and `shared/` for the seeded random stream (`random.ts`) they all draw from; keep a new property test in its own directory. A remaining individual test is a TypeScript case of the harness (`describeCases` / `negotiationCase` with `ref`, Japanese `// Arrange:` / `// Act:` / `// Assert:` comments, description operations through `c.offer` / `c.setRemote` / ... so the invariants run after each; see the header of `tests/negotiation/harness/negotiationCase.ts`); table-driven matrices use the `negotiationTest` fixtures (`videoPeers`, `session`, `closing`) of `negotiationTransactionUtils.ts`, imported as `test`. Negotiation tests end with `expectSessionContinues` (next offer, ICE restart, added DataChannel / transceiver, offer from the peer, traffic); files that call `enforceSessionContinuation()` (every `describeCases` block does) fail a test that skips it without `exemptFromContinuation(pc, reason)` (`exempt` in a case's meta). A fix that changes behavior against `develop` must pass that helper and the develop comparison of Do 8.
7. Before requesting review of a negotiation change, run the deeper property searches with `npm run pbt:deep` (parallel; `--suite fuzz,scenario,model`, `--seeds`, `--steps`, `--jobs`) — it runs the same searches as these single-process commands (the episode fuzzer `WERIFT_NEGOTIATION_FUZZ_SEEDS=300 WERIFT_NEGOTIATION_FUZZ_STEPS=20 npx vitest run tests/pbt/fuzz/negotiationTransactionProperty.test.ts` the scenario properties `WERIFT_NEGOTIATION_SCENARIO_SEEDS=300 npx vitest run tests/pbt/scenario/negotiationScenarioProperty.test.ts` and the model property `WERIFT_NEGOTIATION_MODEL_SEEDS=300 npx vitest run tests/pbt/model/negotiationModelProperty.test.ts -t seed`; `WERIFT_NEGOTIATION_SCENARIO_SEED` / `_STEPS` and `WERIFT_NEGOTIATION_MODEL_SEED` / `_STEPS` replay a printed seed and print a shrunk scene) and a self-review that lists every path writing live state while a description is pending. A value that is live while a description is pending follows the table in the TSDoc of `expectedLive` (`tests/negotiation/harness/negotiationTransactionUtils.ts`); encode a new rule there before changing the implementation.
8. A change to how created descriptions are applied later or again must keep the description reuse contract of `tools/negotiation-diff/scenarios.ts` (`--check` exits 1 on a mismatch): compare with develop locally with `tools/negotiation-diff` (procedure in the header of `run.ts`; never in the active worktree) and keep its difference count at 0. The runner draws configurations, application operations, close timings and peer mutations; `compare.ts` also fails on unsettled operations, `failed` connections without an injected fault and transceiver states that differ from develop.

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
| deep negotiation property search (parallel, before review) | `npm run pbt:deep` |
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
