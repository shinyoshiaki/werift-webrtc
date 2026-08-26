# pion-sped wire wrapper

Opt-in codec interop against **pion/stun v3.1.7** and **pion/ice v4.4.1** `sped.go` (encode/decode/verify). Released Pion ICE agents do not send SPED; fallback against a real agent is `../pion-ice-agent`.

Opt-in: set `WERIFT_PION_SPED` to a wrapper that supports `verify` and `-empty-ack`. Unset skips so default `npm test` stays green. `npm run test:pion-sped` (sets `WERIFT_PION_SPED_REQUIRED=1`) **fails** on a missing or incompatible path (no skip / local fallback). `WERIFT_PION_SPED_AUTO_BUILD=1` builds `./pion-sped` with `go` when the env path is unset.

## CLI

```sh
pion-sped check
pion-sped version
pion-sped encode [-data hex] [-ack crc32hex,...] [-empty-ack] [-integrity-key password]
pion-sped decode <stun-message-hex>
pion-sped verify -integrity-key password <stun-message-hex>
```

## Build

```sh
cd packages/ice/tools/pion-sped
go mod tidy
go build -o pion-sped .
```

## Run tests

```sh
export WERIFT_PION_SPED="$(pwd)/pion-sped"
cd ../../
npm run test:pion-sped
```

Or `WERIFT_PION_SPED_AUTO_BUILD=1 npm run test:pion-sped`. Without either variable the suite is skipped. `npm run test:pion-sped` with a broken `WERIFT_PION_SPED` path fails (no skip / catch-and-ignore / local fallback).
