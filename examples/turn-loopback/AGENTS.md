# AGENTS.md

## Purpose

Instructions for coding agents working in `examples/turn-loopback`.

## Scope

* Applies to the Vite React client, the TypeScript signaling server, the local Chrome E2E harness, and package-local docs.
* This example demonstrates HTTPS signaling plus TURN over TLS on the same public port.
* The Docker image also bundles a separate HTTP/ACME process on `8080` plus an entrypoint that prepares certificate files before starting the werift server on `8443`.
* The werift server peer creates the offer and DataChannel; the browser client answers with relay-only ICE.

## Do

1. Keep signaling and TLS socket multiplexing in `server/main.ts`.
2. Keep the browser SPA in `src/` and preserve a simple one-screen flow for manual echo verification.
3. Keep the server peer free of TURN client settings and `iceTransportPolicy: "relay"`.
4. Keep plain HTTP challenge serving and HTTP → HTTPS redirect in the Docker-bundled sidecar process, not in `server/main.ts`.
5. Update `README.md` when scripts, environment variables, run steps, or Docker usage change.

## Don't

* Do not add extra signaling round-trips beyond the documented `POST /session` and `PUT /session`.
* Do not move TURN socket handling details into the client.
* Do not rely on broad catch-and-ignore error handling around session cleanup or signaling.

## Commands

| Task              | Command                 |
| ----------------- | ----------------------- |
| run signaling app | `npm run server`        |
| run SPA dev app   | `npm run client`        |
| build SPA         | `npm run build`         |
| build Docker image | `npm run docker:build`  |
| run Chrome E2E    | `npm run chrome-e2e`    |
| type-check        | `npm run type`          |

## Validation

* Example changes: run `npm run type` and `npm run build`.
* Browser-hosting or client flow changes: also run `npm run chrome-e2e`.
* If the server or TURN wiring changes, also run `cd ../../packages/ice-server && npm test`.

## Maintenance

* Keep this guide aligned with `package.json`, `README.md`, `chrome-e2e`, and the run steps.
* When adding stable files or environment variables, document them here and in the README together.
