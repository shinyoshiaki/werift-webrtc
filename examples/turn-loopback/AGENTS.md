# AGENTS.md

## Purpose

Instructions for coding agents working in `examples/turn-loopback`.

## Scope

* Applies to the Vite React client, the TypeScript signaling server, and package-local docs.
* This example demonstrates HTTPS signaling plus TURN over TLS on the same public port.
* The werift server peer creates the offer and DataChannel; the browser client answers with relay-only ICE.

## Do

1. Keep signaling and TLS socket multiplexing in `server/main.ts`.
2. Keep the browser SPA in `src/` and preserve a simple one-screen flow for manual echo verification.
3. Keep the server peer free of TURN client settings and `iceTransportPolicy: "relay"`.
4. Update `README.md` when scripts, environment variables, or run steps change.

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
| type-check        | `npm run type`          |

## Validation

* Example changes: run `npm run type` and `npm run build`.
* If the server or TURN wiring changes, also run `cd ../../packages/ice-server && npm test`.

## Maintenance

* Keep this guide aligned with `package.json`, `README.md`, and the run steps.
* When adding stable files or environment variables, document them here and in the README together.
