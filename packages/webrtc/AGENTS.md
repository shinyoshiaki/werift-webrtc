# AGENTS.md

## Purpose

Instructions for coding agents working in `packages/webrtc`.

## Scope

* Applies to `src`, `tests`, `tools/wpt-runner`, and package-local docs.
* This package is the main public WebRTC API (`RTCPeerConnection`, media, data channel).
* Lower-level protocol packages (`ice`, `dtls`, `rtp`, `sctp`, `common`) are dependencies; prefer fixing protocol bugs in those packages when the root cause lives there.
* Upstream WPT harness code lives under `tools/wpt-runner/` and must not leak stricter shims into default `src` behavior.

## Do

1. Prefer package-local validation (`npm test`, `npm run type`) before workspace-wide commands.
2. Keep Arrange helpers reusable; memleak Arrange utilities live in `tests/memleak/heapUtils.ts` and scenario setup in `tests/memleak/scenarios.ts`.
3. Add Japanese comments in Act / Assert phases when operation order or expectations are not obvious.
4. When adding package scripts, update this guide's Commands table in the same change.
5. Keep memleak tests out of the default vitest suite (`vitest.config.mts` excludes `tests/memleak/**`).

## Don't

* Do not export SPED internals or add `IceOptions.sped`; enablement is `PeerConfig.sped` only.
* Do not run memleak as part of `npm test` / CI; use `npm run memleak` only.
* Do not enable vitest `retry` for memleak (hides leak failures).
* Do not silence leak detections; open a follow-up for root-cause fixes if a real leak is found.

## Commands

| Task | Command |
| --- | --- |
| test package | `npm test` |
| type-check package | `npm run type` |
| format package | `npm run format` |
| pion ICE agent fallback (opt-in) | `npm run test:pion-ice-agent` |
| memory leak test (Node 24+, local only) | `npm run memleak` |
| allowlisted upstream WPT | `npm run wpt` |
| WPT coverage | `npm run wpt:coverage` |

Memleak details, env vars, and report interpretation: `tests/memleak/README.md`.

## Validation

* Logic changes in `src`: `npm run type` and relevant `npm test` paths.
* Opt-in released Pion ICE agent fallback: `npm run test:pion-ice-agent` with `WERIFT_PION_ICE_AGENT` or `WERIFT_PION_ICE_AGENT_AUTO_BUILD=1`. Default `npm test` skips a missing path. The opt-in script fails if neither source is set.
* Memleak harness changes: short smoke with reduced env (see `tests/memleak/README.md`), then optional full `npm run memleak`.
* WPT runner / allowlist: `npm run wpt`.

## Maintenance

* Keep this guide aligned with `package.json` scripts.
* When memleak scripts or artifact paths change, update `tests/memleak/README.md` and this Commands table together.
