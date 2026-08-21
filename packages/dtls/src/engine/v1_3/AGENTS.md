# AGENTS.md

## Purpose

Instructions for coding agents working in `packages/dtls/src/engine/v1_3`.

## Scope

* DTLS 1.3 endpoint over direct datagrams (RFC 9147 / RFC 8446).
* Flight sequence is Figure 3 in `packages/dtls/src/index.ts`.
* Layout: `README.md` in this directory.

## Do

1. Keep a **single** inheritance level: `Dtls13Connection extends Dtls13ConnectionBase` only (session state + lifecycle).
2. Put flight, record TX/RX, and dispatch logic in **functions** with `this: Dtls13Host`. Assign them on `Dtls13Connection`.
3. Split handlers by Figure 3 flight under `flight/client/` and `flight/server/`, like DTLS 1.2 `src/flight/{client,server}/`.
4. After engine edits: `cd packages/dtls && npm run type && npm test`.

## Don't

* Do not add `class A extends B extends C` (or abstract mixin classes) to split flights or I/O layers.
* Do not introduce new `extends` under this directory except the existing Connection → Base pair.
* Do not share mutable 1.3 epoch/transcript/key state with the DTLS 1.2 engine.

## Commands

Use the package guide: `packages/dtls/AGENTS.md`.

## Validation

* `cd packages/dtls && npm run type && npm test`.

## Maintenance

* Keep `README.md` and `packages/dtls/src/index.ts` Figure 3 map aligned when files move.
* Keep `host.ts` (`Dtls13HostMethods`) aligned when adding flight/record functions assigned on Connection.
