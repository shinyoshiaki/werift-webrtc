# pion-ice-agent

Opt-in ICE agent using **released pion/ice v4.4.1** (no agent SPED). Used to prove werift SPED fallback:

1. werift probes with SPED ClientHello on Binding
2. Pion Binding Response has no DATA
3. werift sends the same ClientHello bytes as raw DTLS
4. werift DTLS 1.3 completes over the Pion ICE datagram path

## Build

```sh
cd packages/ice/tools/pion-ice-agent
go mod tidy
go build -o pion-ice-agent .
```

## Run tests

```sh
# from packages/ice/tools/pion-ice-agent after the build above
export WERIFT_PION_ICE_AGENT="$(pwd)/pion-ice-agent"
cd ../../../webrtc
npm run test:pion-ice-agent
```

Or `WERIFT_PION_ICE_AGENT_AUTO_BUILD=1 npm run test:pion-ice-agent` (requires `go`; reuses an existing `./pion-ice-agent`).

Running `npm run test:pion-ice-agent` with neither variable set fails with `Pion ICE agent opt-in requires WERIFT_PION_ICE_AGENT or WERIFT_PION_ICE_AGENT_AUTO_BUILD=1`, even when `./pion-ice-agent` is already built: the opt-in script never picks up the local binary implicitly, so pass its path explicitly (or opt into auto build).

## Protocol (JSON lines on stdin/stdout)

- stdout `local-auth` `{ufrag,pwd}` then `candidate` then `gathering-complete`
- stdin `remote-auth` `{ufrag,pwd}`, `candidate`, `end-of-candidates`
- stdout `connected`
- `datagram` `{data: hex}` both ways after ICE is up
- stdin `close` to exit

Opt-in: set `WERIFT_PION_ICE_AGENT` to the binary. Unset skips so default `npm test` stays green. `npm run test:pion-ice-agent` (from `packages/webrtc`, sets `WERIFT_PION_ICE_AGENT_REQUIRED=1`) **fails** unless `WERIFT_PION_ICE_AGENT` or `WERIFT_PION_ICE_AGENT_AUTO_BUILD=1` is set (no skip). A missing `WERIFT_PION_ICE_AGENT` path also fails that script. `WERIFT_PION_ICE_AGENT_AUTO_BUILD=1` builds `./pion-ice-agent` with `go` when the env path is unset.
