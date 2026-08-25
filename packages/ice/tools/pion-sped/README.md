# pion-sped wire wrapper

Opt-in codec interop against **pion/stun v3.1.7** and **pion/ice v4.4.1** `sped.go` (encode/decode/verify). Released Pion ICE agents do not send SPED; fallback against a real agent is `../pion-ice-agent`.

The test runner uses `WERIFT_PION_SPED` when set, otherwise `./pion-sped` next to this README. The environment variable always wins even if a local binary exists. A compatible CLI is also provided at `/usr/local/bin/pion-sped` in some environments.

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
npm test -- pion-sped
```

Without a binary, the suite is skipped so default `npm test` stays green when the tool is absent. When a binary is present, codec mismatches fail the test (no skip / catch-and-ignore).
