# AGENTS.md

## Purpose

Instructions for coding agents working in `packages/ice`.

## Scope

* Applies to `src`, `tests`, `scripts`, `tools`, and package-local docs.
* ICE connectivity checks, STUN/TURN clients, TCP ICE, and internal SPED draft-00.
* STUN Message parse/serialize lives in `packages/ice-server`; this package re-exports it.
* Public API is `src/index.ts`. SPED codec/session are package-private (`src/sped/`, `src/internal/sped.ts`).

## Do

1. Prefer package-local validation (`npm run type`, `npm test`) before workspace-wide commands.
2. Keep SPED codepoints and L1/L2 out of `src/index.ts`. Enable SPED from `RTCPeerConnection` via `attachSpedToConnection`.
3. Authenticate Binding Requests (USERNAME → HMAC) before role conflict, filters, SPED inject, or pair updates.
4. Add Japanese comments in Act / Assert phases when operation order or expectations are not obvious.
5. When adding package scripts or `tools/`, update this Commands table in the same change.

## Don't

* Do not add `IceOptions.sped` or export draft-00 types from the package barrel.
* Do not export STUN wire-order internals (`WireAttribute`, `getRawAttributeValue`) from `src/index.ts`.
* Do not register SPED attributes in ice-server `ATTRIBUTES`.
* Do not implement TURN-path SPED (ChannelData / Data Indication embedding).
* Do not attach `MESSAGE-INTEGRITY-SHA256` to SPED Bindings.

## Commands

| Task | Command |
| --- | --- |
| type-check package | `npm run type` |
| test package | `npm test` |
| format package | `npm run format` |
| pion TURN interop (opt-in) | `npm run test:pion-turn` |
| pion SPED wire codec (opt-in) | `npm run test:pion-sped` |
| pion ICE agent fallback (opt-in) | `npm run test:pion-ice-agent --workspace packages/webrtc` |

## Validation

* STUN / ICE logic: `npm run type` and `npm test`.
* Opt-in Pion SPED codec: `npm run test:pion-sped` with `WERIFT_PION_SPED` or `WERIFT_PION_SPED_AUTO_BUILD=1` (see `tools/pion-sped/README.md`). Default `npm test` skips a missing/incompatible env path. The opt-in script fails if neither source is set, and on a bad path.
* Opt-in released Pion ICE agent fallback: `npm run test:pion-ice-agent --workspace packages/webrtc` with `WERIFT_PION_ICE_AGENT` or `WERIFT_PION_ICE_AGENT_AUTO_BUILD=1` (see `tools/pion-ice-agent/README.md`). Default `npm test` skips a missing path. The opt-in script fails if neither source is set, and on a missing path.

## Maintenance

* Keep this guide aligned with `package.json` scripts and `tools/` entrypoints.
* SPED draft-00 behavior: `docs/sped-draft00.md`.
