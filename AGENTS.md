# AGENTS.md

## Purpose

Repository-wide instructions for coding agents working in `werift-webrtc`.
Rules that apply to one package or directory belong in the nearest `AGENTS.md`.

## Scope

* Applies to the repository root and to changes that cross packages.
* `werift` is a pure TypeScript WebRTC implementation for Node.js. Supported runtimes are Linux, macOS, and other Unix-like systems; native Windows is not supported.
* Core packages: `common`, `ice`, `dtls`, `rtp`, `sctp`, `webrtc`. Protocol flow is `ICE -> DTLS -> SCTP/RTP`.
* `packages/webrtc` is the public API; the lower-level packages are reusable protocol layers.

## Do

1. Read the nearest `AGENTS.md` before editing files in that directory.
2. Run `git submodule update --init --recursive` after checkout before WPT-related work.
3. Keep every `AGENTS.md` short, operational, and grounded in the local `package.json` and stable directory structure.
4. Update the relevant package guide when scripts, stable entrypoints, neighboring package dependencies, or validation expectations change.
5. Update this root guide last when a change affects the shared template, workspace commands, or package list.
6. Prefer package-level validation first, then widen to workspace commands only when the change crosses package boundaries.
7. Write test code in three phases: Arrange / Act / Assert.
8. Extract Arrange-phase setup into utilities wherever practical.
9. Keep Arrange utility functions in a single file so they can be reused from other test files.
10. In Act / Assert phases, add Japanese comments at an appropriate granularity for each operation so the test intent and verification points are clear.
11. Fix root causes. Do not silence failing tests, type errors, protocol validation, or interop issues.
12. Follow existing patterns: manager-style orchestration in `packages/webrtc`, asynchronous notifications based on the custom `Event` class, and package-local error handling instead of broad catch-and-ignore logic. Use handling.
13. When changing public API, protocol behavior, examples, or WPT wiring, update the nearest docs or examples that demonstrate the behavior.
14. Keep upstream-WPT-only strict behavior inside `packages/webrtc/tools/wpt-runner/*` wrappers. Do not leak stricter WPT shims into the default `packages/webrtc/src` API when that would regress existing werift convenience behavior.
15. Keep CI-facing nested dependency bootstraps cache-friendly and non-auditing (`--prefer-offline --no-audit --no-fund --no-update-notifier`).
16. Compare behavior against another revision in a separate temporary worktree (`git worktree add --detach <tmp-dir> <rev>`), never by checking out, resetting, or stashing the active worktree. External tooling may auto-commit the active worktree at any time.
17. Reproduce a failing E2E with only the affected test file first; run the full E2E suite as final validation.
18. Before long-running verification, state the current revision, uncommitted changes, and intent so interrupted work can be resumed.
19. Resolve conflicts in generated docs (`doc/`, `packages/*/doc`) by regenerating them from the finalized source (`npm run doc`), not by merging the text.
20. After a merge, check that public APIs match the generated docs, READMEs, and `changelog.md`.
21. When code and docs disagree, decide the correct behavior from history, requirements, specs, and compatibility, then fix the side that is wrong.

## Don't

* Don't reintroduce third-party TypeScript runners such as `tsx`. Run TypeScript with `node --experimental-transform-types --import <rel>/tools/node-ts/register.mjs` (Node.js 22.18+, see `devEngines`).
* Don't add multi-level class inheritance in `packages/dtls/src/engine/v1_3` (see that directory's `AGENTS.md`).
* Don't stop test servers or browsers with pattern-based kills (`pkill -f`, `killall`); they can match the agent's own shell. Stop them by PID or through the runner's stop path.
* Don't end a turn while a background test or build you started is still running, unless you report it as unfinished.
* Don't put credentials, secrets, or machine-specific setup in any `AGENTS.md`.

## Commands

| Task | Command |
| --- | --- |
| build all packages | `npm run build` |
| type-check workspace | `npm run type` |
| package / unit tests | `npm run test:small` |
| full suite including E2E | `npm run test` |
| install Playwright browsers | `npm run install:browsers` |
| E2E only (verbose: `e2e:verbose`) | `npm run e2e` |
| broad workspace validation | `npm run ci` |
| examples smoke (Chromium + gst/ffmpeg) | `npm run examples:e2e` |
| install examples smoke Chromium | `npm run examples:e2e:install` |
| TypeScript resolve hook tests | `npm run test:node-ts` |
| allowlisted upstream WPT | `npm run wpt` |
| WPT coverage | `npm run wpt:coverage` |
| format code | `npm run format` |
| regenerate docs | `npm run doc` |
| verify docs match sources | `npm run doc:check` |
| memory leak test (Node 24+, local only, not in CI) | `cd packages/webrtc && npm run memleak` |

Package builds don't run the formatter; run `npm run format` before review.
For targeted work, start with the package's own commands, for example `cd packages/webrtc && npm test`.

## Validation

Start with the narrowest package command, and widen to workspace commands only when a change crosses package boundaries.

* Docs-only edits: no code validation needed. Public API / Typedoc surface changes: `npm run doc:check` so committed `doc/` and `packages/*/doc` match sources (also part of `npm run ci`).
* Single-package logic: that package's test and/or type-check command.
* Cross-package, public API, or protocol changes: `npm run type` and `npm run test:small`; `npm run ci` when the change spans the full stack.
* WPT runner, dummy media, or allowlist changes: `npm run wpt`; also `npm run wpt:coverage` when coverage or baseline wiring changes.
* Browser interop or signaling changes: run `npm run install:browsers` once from the repo root (covers `e2e`, `packages/ice-server/chrome-e2e`, and `examples/turn-loopback/chrome-e2e`), then the relevant example and/or `npm run e2e`. For a failing E2E, reproduce with only the affected test file first, then run the full suite as final validation. Root `examples/` demos in the `examples/e2e` catalog also need `npm run examples:e2e`.
* Infrastructure-backed E2E: run the targeted scenario with its opt-in environment flag, so the real dependency path is exercised.
* `integration/werift-mediasoup-interop`: follow that directory's `AGENTS.md`.

## Maintenance

* Every guide uses this section order: Purpose, Scope, Do, Don't, Commands, Validation, Maintenance. Package guides differ mainly in responsibilities, validation, references, and cross-package cautions.
* Keep guides short and operational. List only commands that exist in the local `package.json`, and leave feature catalogs, example payloads, and other fast-changing details to READMEs.
* Update the nearest `AGENTS.md` in the same change when scripts, stable entrypoints, neighboring package dependencies, or validation expectations change. Update this root guide last, when the shared template, workspace commands, or package list change.
* When test conventions change, keep the Arrange / Act / Assert and shared-utility rules aligned between this guide and the package guides.
