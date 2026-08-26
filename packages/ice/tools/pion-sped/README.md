# pion-sped wire wrapper

Opt-in codec interop against **pion/stun v3.1.7** and **pion/ice v4.4.1** `sped.go` (encode/decode/verify). Released Pion ICE agents do not send SPED; fallback against a real agent is `../pion-ice-agent`.

Opt-in: set `WERIFT_PION_SPED` to a wrapper that supports `verify` and `-empty-ack`. Unset skips so default `npm test` stays green. `npm run test:pion-sped` (sets `WERIFT_PION_SPED_REQUIRED=1`) **fails** unless `WERIFT_PION_SPED` or `WERIFT_PION_SPED_AUTO_BUILD=1` is set (no skip / local fallback). A missing or incompatible `WERIFT_PION_SPED` also fails that script. `WERIFT_PION_SPED_AUTO_BUILD=1` builds `./pion-sped` with `go` when the env path is unset.

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

Or `WERIFT_PION_SPED_AUTO_BUILD=1 npm run test:pion-sped`. `npm run test:pion-sped` without `WERIFT_PION_SPED` or `WERIFT_PION_SPED_AUTO_BUILD=1` fails (no skip). A broken `WERIFT_PION_SPED` path also fails that script (no skip / catch-and-ignore / local fallback). Default `npm test` still skips a stale or unset path.
