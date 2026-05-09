# AGENTS.md

## Purpose

Instructions for coding agents working in the `werift-webrtc` monorepo. Keep this file short and repo-specific. If a rule only applies to one package or subdirectory, prefer a nested `AGENTS.md` there instead of expanding this root file.

## Project overview

- `werift` is a pure TypeScript WebRTC implementation for Node.js.
- Core packages: `common`, `ice`, `dtls`, `rtp`, `sctp`, `webrtc`.
- Protocol flow: ICE -> DTLS -> SCTP/RTP.
- `packages/webrtc` is the main public API; lower-level packages are reusable protocol layers.

## Working rules

1. Explore first, then edit. Read the affected package, its tests, and adjacent layers before changing protocol or transport code.
2. Keep changes surgical. Do not refactor unrelated modules while fixing a local issue.
3. Follow existing patterns:
   - manager-style orchestration in `packages/webrtc`
   - `EventTarget`-based async notifications
   - package-local error handling instead of broad catch-and-ignore logic
4. Fix root causes. Do not silence failing tests, type errors, protocol validation, or interop issues.
5. When changing public API, protocol behavior, or examples, update the nearest docs or examples that demonstrate the behavior.

## Repository map

| Path | Role |
| --- | --- |
| `packages/common` | shared utilities used across the stack |
| `packages/ice` | ICE, STUN, TURN, candidate handling |
| `packages/dtls` | DTLS and secure transport |
| `packages/rtp` | RTP/RTCP packet and media transport logic |
| `packages/sctp` | SCTP and DataChannel transport |
| `packages/webrtc` | main WebRTC API (`RTCPeerConnection`, media, data channel) |
| `examples/` | runnable reference implementations |
| `e2e/` | browser and interop end-to-end tests |
| `doc/` | generated API docs output |

## Essential commands

| Task | Command |
| --- | --- |
| install dependencies | `npm install` |
| build all packages | `npm run build` |
| type-check workspace | `npm run type` |
| run package/unit tests | `npm run test:small` |
| run full suite including E2E | `npm run test` |
| run E2E only | `npm run e2e` |
| format code | `npm run format` |
| regenerate docs | `npm run doc` |

For targeted work, prefer the narrowest package command first, for example:

- `cd packages/webrtc && npm test`
- `cd packages/rtp && npm run type && npm test`

## Verification expectations

- Docs-only edits: no code validation required.
- Single-package logic changes: run that package's relevant test and/or type-check command.
- Cross-package, public API, or protocol changes: run `npm run type` and `npm run test:small`.
- Browser interop, examples, or signaling flow changes: run the relevant example and/or `npm run e2e` when feasible.

## Compatibility and constraints

- Do not hand-edit generated output in `doc/`; regenerate it with `npm run doc`.
- Do not commit secrets from `credential.env` or related local credential files.
- Avoid dependency churn unless the task is explicitly about dependencies.

## When instructions need to grow

Add a nested `AGENTS.md` in a package or subdirectory when that area needs different test commands, constraints, or architecture notes. Keep the root file focused on rules that apply across the whole repository.
