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

## Protocol (JSON lines on stdin/stdout)

- stdout `local-auth` `{ufrag,pwd}` then `candidate` then `gathering-complete`
- stdin `remote-auth` `{ufrag,pwd}`, `candidate`, `end-of-candidates`
- stdout `connected`
- `datagram` `{data: hex}` both ways after ICE is up
- stdin `close` to exit

Opt-in: set `WERIFT_PION_ICE_AGENT` to the binary. A missing path **fails the suite** (no skip). Unset skips so default `npm test` stays green. `WERIFT_PION_ICE_AGENT_AUTO_BUILD=1` builds `./pion-ice-agent` with `go` when the env path is unset.
