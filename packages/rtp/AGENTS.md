# AGENTS.md

## Purpose

Instructions for coding agents working in `packages/rtp`.

## Scope

* Owns RTP, RTCP, SRTP, SRTCP, codecs, and packet processing.
* `src/index.ts` is the public entrypoint and must remain browser-bundleable with the documented Node polyfills.

## Do

1. Read the root `AGENTS.md` before editing.
2. Keep browser-facing imports free of Node-only APIs unless the supported Vite polyfill provides them.
3. Write tests in Arrange / Act / Assert phases with Japanese Act / Assert comments.

## Don't

* Do not remove the `buffer` dependency or `import "buffer"` from `src/index.ts`; the RTP entry relies on browser bundlers to provide `Buffer`.
* Do not claim browser support for `extra` or for direct use without Node polyfills.

## Commands

| Task | Command |
| --- | --- |
| package tests and types | `npm test` |
| browser entry smoke test | `npm run test:browser` |
| type-check | `npm run type` |
| public declaration check (`skipLibCheck: false`) | `npm run type:public` |

## Validation

* RTP source changes: run `npm test` (includes `type:public`, which type-checks generated declarations with `skipLibCheck: false`).
* Public entry or browser compatibility changes: also run `npm run test:browser`.

## Maintenance

* Update this guide when package scripts or validation expectations change.
