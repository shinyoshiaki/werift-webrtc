# AGENTS.md

## Purpose

Instructions for coding agents working in `examples/front-proxy-turn`.

## Scope

* Applies to the TypeScript front-proxy TURN/TLS sample, tests, and package-local docs.
* This example demonstrates one public TLS address shared by HTTPS and TURN/TLS through LB, Relay, shared KV, and Backend TURN components.
* The sample is WebRTC-only and is meant for configuration understanding and local validation.

## Do

1. Keep LB logic limited to TLS termination, relay selection, and forwarding the original client source address.
2. Keep HTTP/TURN detection, TURN/TCP frame splitting, and backend routing in Relay.
3. Keep TURN allocation and peer relay state in Backend TURN virtual transports keyed by `clientTransportKey`.
4. Update `README.md` when scripts, environment variables, routing behavior, or run steps change.
5. Keep tests in Arrange / Act / Assert phases and add Japanese comments in Act / Assert sections when useful.

## Don't

* Do not move this example's proxy behavior into `packages/ice-server`.
* Do not route by ICE `ufrag`.
* Do not add process-local client pinning outside the two shared KV mappings.
* Do not claim generic TURN client compatibility or seamless TCP/TLS stream failover.

## Commands

| Task | Command |
| --- | --- |
| install browser runtime | `npm run install:browsers` |
| run sample | `npm run server` |
| test sample | `npm test` |
| type-check | `npm run type` |

## Validation

* Logic or test changes: run `npm run type && npm test`.
* `npm test` ensures a usable Chromium runtime is available before running the headless relay-only browser check.
* Docs-only edits: no code validation required.

## Maintenance

* Keep this guide aligned with `package.json`, `README.md`, and stable files under `src/` and `tests/`.
