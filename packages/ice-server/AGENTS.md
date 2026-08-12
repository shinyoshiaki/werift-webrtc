# AGENTS.md

## Purpose

Instructions for coding agents working in `packages/ice-server`.

## Scope

* Applies to `src`, `tests`, `chrome-e2e`, and package-local docs.
* This package provides RFC 8489 STUN and RFC 8656 TURN protocol handling plus the Node reference servers used by tests.
* `chrome-e2e` is the package-local browser interop harness for validating Chrome against this package directly.

## Do

1. Keep protocol state machines in `src/protocol.ts` and `src/turn/protocol.ts` Sans-IO; keep Node transport concerns in `src/node/*`.
2. When TURN or STUN behavior changes, add or update unit coverage in `tests/*.test.ts`.
3. Keep Chrome E2E Arrange helpers centralized in `chrome-e2e/tests/fixture.ts`.
4. Add Japanese comments in Chrome E2E Act / Assert phases when the operation order or expectation is not obvious at a glance.
5. Update the package README or harness docs when package scripts or browser validation entrypoints change.
6. Keep `chrome-e2e` browser bootstrap helpers aligned with `vitest.config.mts` so tests can use either a bundled Playwright Chromium or an explicit system Chrome path.

## Don't

* Do not move package-specific browser interop tests into the repository-root `e2e` app.
* Do not add catch-and-ignore handling around TURN authentication, allocation, permission, or relay errors.
* Do not duplicate peer-connection setup across multiple Chrome E2E files when the shared helper can own it.

## Commands

| Task                    | Command                                      |
| ----------------------- | -------------------------------------------- |
| build package           | `npm run build`                              |
| test package            | `npm test`                                   |
| type-check package      | `npm run type`                               |
| run package Chrome E2E  | `npm run chrome-e2e`                         |
| run harness directly    | `cd chrome-e2e && npm run ci:silent`         |
| type-check harness      | `cd chrome-e2e && npm run type`              |

## Validation

* Protocol or Node server changes: run `npm test && npm run type`.
* Chrome harness changes: run `cd chrome-e2e && npm run type && npm run ci:silent`.
* Browser interop fixes that touch STUN/TURN behavior: run the package tests and the Chrome harness together.

## Maintenance

* Keep this guide aligned with `package.json` scripts and the `chrome-e2e` entrypoints.
* When the harness adds stable files or commands, reflect them here in the same change.
