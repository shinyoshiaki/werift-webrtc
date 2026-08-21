# AGENTS.md

## Purpose

Instructions for coding agents working in `packages/dtls`.

## Scope

* Applies to `src`, `tests`, and package-local docs.
* Pure TypeScript DTLS 1.2 / 1.3 for Node.js. Protocol flow in this package is `record → handshake flights`.
* Public API is `DtlsClient` / `DtlsServer`. The DTLS 1.3 engine lives under `src/engine/v1_3/`.

## Do

1. Prefer package-local validation (`npm run type`, `npm test`) before workspace-wide commands.
2. Read `src/engine/v1_3/AGENTS.md` before editing the DTLS 1.3 engine.
3. Add Japanese comments in Act / Assert phases when operation order or expectations are not obvious.
4. When adding package scripts, update this guide's Commands table in the same change.

## Don't

* Do not export association internals (`selectVersion`, carriers) from `src/index.ts`.
* Do not add multi-level class inheritance under `src/engine/v1_3/` (see that directory's guide).

## Commands

| Task | Command |
| --- | --- |
| type-check package | `npm run type` |
| test package | `npm test` |
| format package | `npm run format` |
| package CI | `npm run ci` |
| BoringSSL DTLS 1.3 interop | `npm run test:boringssl` |

## Validation

* Logic changes in `src`: `npm run type` and `npm test`.
* DTLS 1.3 interop: `npm run test:boringssl` when handshake/record/crypto paths change and the harness is available.

## Maintenance

* Keep this guide aligned with `package.json` scripts.
* Engine layout and inheritance rules: `src/engine/v1_3/AGENTS.md` and `src/engine/v1_3/README.md`.
