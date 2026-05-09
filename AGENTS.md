# AGENTS.md

## Purpose

Instructions for coding agents working in `werift-webrtc`.
Keep this file short and repo-specific.
If a rule applies only to a specific package or subdirectory, put it in the nearest `AGENTS.md`.

## Scope

* Applies to the repository root and cross-package changes.
* Runtime target: Linux, macOS, and other Unix-like environments only. Native Windows is not supported.
* Package-specific execution details should be documented in the nearest package-level `AGENTS.md`.
* `werift` is a pure TypeScript WebRTC implementation for Node.js.
* Core packages are `common`, `ice`, `dtls`, `rtp`, `sctp`, and `webrtc`.
* Protocol flow is `ICE -> DTLS -> SCTP/RTP`.
* `packages/webrtc` is the main public API. Lower-level packages are reusable protocol layers.

## Do

1. Read the nearest `AGENTS.md` before editing files in that directory.
2. Keep every `AGENTS.md` short, operational, and grounded in the local `package.json` and stable directory structure.
3. Update the relevant package guide when scripts, stable entrypoints, neighboring package dependencies, or validation expectations change.
4. Update this root guide last when a change affects the shared template, workspace commands, or package list.
5. Prefer package-level validation first, then widen to workspace commands only when the change crosses package boundaries.
6. Write test code in three phases: Arrange / Act / Assert.
7. Extract Arrange-phase setup into utilities wherever practical.
8. Keep Arrange utility functions in a single file so they can be reused from other test files.
9. In Act / Assert phases, add Japanese comments at an appropriate granularity for each operation so the test intent and verification points are clear.
10. Fix root causes. Do not silence failing tests, type errors, protocol validation, or interop issues.
11. Follow existing patterns: manager-style orchestration in `packages/webrtc`, asynchronous notifications based on the custom `Event` class, and package-local error handling instead of broad catch-and-ignore logic. Use handling.
12. When changing public API, protocol behavior, or examples, update the nearest docs or examples that demonstrate the behavior.

## Don't

* Do not copy README-style feature catalogs, example payloads, or other fast-changing implementation details into `AGENTS.md`.
* Do not list commands that are absent from the local `package.json`.
* Do not describe provider credentials, secrets, or machine-specific setup in this guide.
* Do not let package guides drift in structure. Differences should mostly be limited to responsibilities, validation, references, and cross-package cautions.
* Do not duplicate Arrange-phase setup across multiple test files when it can be safely shared through common utilities.
* Do not leave Act / Assert phases without comments when the operation sequence or expectation is not obvious from a quick read.

## Commands

| Task                         | Command               |
| ---------------------------- | --------------------- |
| build all packages           | `npm run build`       |
| broad workspace validation   | `npm run ci`          |
| run package / unit tests     | `npm run test:small`  |
| run full suite including E2E | `npm run test`        |
| run E2E only                 | `npm run e2e`         |
| run verbose E2E              | `npm run e2e:verbose` |
| type-check workspace         | `npm run type`        |
| format code                  | `npm run format`      |
| regenerate docs              | `npm run doc`         |

For targeted work, prefer the narrowest package command first, for example:

* `cd packages/webrtc && npm test`
* `cd packages/rtp && npm run type && npm test`

## Validation

* Docs-only edits: no code validation required.
* Single-package logic changes: run that package's relevant test and/or type-check command.
* Cross-package, public API, or protocol changes: run `npm run type` and `npm run test:small`; use `npm run ci` when the change spans the full stack.
* Browser interop, examples, or signaling flow changes: run the relevant example and/or `npm run e2e` when feasible.
* Test code changes: confirm shared Arrange utilities remain reusable and appropriately scoped, and review that Act / Assert comments are present at a useful Japanese granularity.
* Infrastructure-backed E2E changes: run the targeted scenario with its required opt-in environment flag before finishing, so the real dependency path is exercised.

## Maintenance

* Keep this section order in every guide: Purpose, Scope, Do, Don't, Commands, Validation, Maintenance.
* When adding, removing, renaming, or re-scoping a package, update the root package list references and the affected package guides together.
* When package scripts or stable reference files change, update the nearest `AGENTS.md` in the same change.
* When test implementation conventions change, keep the Arrange / Act / Assert guidance and shared utility placement rules aligned across the root and package-level guides.
