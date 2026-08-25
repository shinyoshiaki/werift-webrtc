# pion-sped wire wrapper

Opt-in codec interop against **pion/stun v3.1.7** and **pion/ice v4.4.1** `sped.go` (encode/decode/verify). Released Pion ICE agents do not send SPED; fallback against a real agent is `../pion-ice-agent`.

The test runner prefers `WERIFT_PION_SPED` when that binary is compatible (usage includes `verify` and `-empty-ack`). An incompatible override, such as an older `/usr/local/bin/pion-sped`, is ignored. The runner then uses a compatible `./pion-sped`, building it with `go` when needed. Incompatible or missing binaries skip the suite so default `npm test` stays green.

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
