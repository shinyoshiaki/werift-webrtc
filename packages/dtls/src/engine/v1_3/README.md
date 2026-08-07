# DTLS 1.3 engine layout

Handshake sequence (flights) is documented as ASCII art in
[`packages/dtls/src/index.ts`](../../index.ts) **Figure 3**.

## Module stack (bottom → top)

| File | Role | Figure 3 correspondence |
| --- | --- | --- |
| `types.ts` | Options, constants, HRR random | shared |
| `transcript.ts` | Handshake transcript hash | all flights |
| `connection-base.ts` | Session state, epochs, `fail` / lifecycle | stack foundation |
| `flight-tx.ts` | Outbound records, retransmit, anti-amp, ACK send | all `-------->` arrows |
| `record-rx.ts` | Inbound datagrams, reassembly, allowlist, ACK/alert RX | all `<--------` arrows |
| `handshake-flights.ts` | Message handlers by flight | Flight 1–5 + post-HS KeyUpdate |
| `connection.ts` | Public API (`connect` / `send` / close / exporters) | application edge |

## Flight → handler map

```
Flight 1 / 3  ClientHello          → sendClientHello, onClientHello
Flight 2      HelloRetryRequest*   → sendHelloRetryRequest
Flight 4      ServerHello + {EE..} → sendServerFlight, onServerHello…
Flight 5      {Cert* CV* Finished} → onFinished (client path)
Post-HS       KeyUpdate + ACK      → keyUpdate, onKeyUpdate, handleAck
```

`{ }` = encrypted with handshake or application traffic keys.
