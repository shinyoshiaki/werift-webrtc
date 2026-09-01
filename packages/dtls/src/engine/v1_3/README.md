# DTLS 1.3 engine layout

Handshake sequence (flights) is documented as ASCII art in
[`packages/dtls/src/index.ts`](../../index.ts) **Figure 3**.

Flight handlers are functions (`this: Dtls13Host`) split like DTLS 1.2
(`src/flight/{client,server}/flightN.ts`). Role-specific code lives under
`flight/client/` and `flight/server/`. Shared dispatch, certificates, Finished
routing, and KeyUpdate stay beside those directories. `Dtls13Connection`
extends `Dtls13ConnectionBase` once and assigns those functions.

Version-neutral helpers used by both DTLS 1.2 and 1.3:

| Module | Shared with 1.2 |
| --- | --- |
| `src/peer.ts` | peer identity, loopback pin host |
| `src/retransmission.ts` | RFC RTO (`computeDtlsRtoMs`, used by DTLS 1.3) |
| `handshake/random.ts` | `DtlsRandom.bytes32` |
| `handshake/extensions/unique.ts` | duplicate-extension check |
| `context/srtp.ts` | `findMatchingSRTPProfile` |

## Module stack

| File | Role | Figure 3 correspondence |
| --- | --- | --- |
| `types.ts` | Options, constants, HRR random | shared |
| `host.ts` | `Dtls13Host` (`this` for flight/record functions) | shared |
| `transcript.ts` | Handshake transcript hash | all flights |
| `connection-base.ts` | Session state, epochs, `fail` / lifecycle | stack foundation |
| `flight-tx.ts` | Outbound records, retransmit, anti-amp, ACK send | all `-------->` arrows |
| `record-rx.ts` | Inbound datagrams, reassembly, allowlist, ACK/alert RX | all `<--------` arrows |
| `flight/dispatch.ts` | Expected-type state machine + handshake dispatch | Flight 1–5 routing |
| `flight/client/*.ts` / `flight/server/*.ts` | Per-flight send/receive | Flight 1–5 |
| `flight/post-hs.ts` | Post-handshake KeyUpdate + NewSessionTicket | post-HS |
| `connection.ts` | Public API; extends Base once; assigns flight/record functions | application edge |

`Dtls13Connection extends Dtls13ConnectionBase` is the only class inheritance. Flight and record modules export functions with `this: Dtls13Host`.

## Flight → handler map

```
Flight 1 / 3  ClientHello          → flight/client/flight1.ts
Flight 2      HelloRetryRequest*   → flight/server/flight2.ts
Flight 4      ServerHello + {EE..} → flight/server/flight4.ts (send)
                                     flight/client/flight4.ts (recv)
Flight 5      {Cert* CV* Finished} → flight/client/flight5.ts (send)
                                     flight/server/flight5.ts (recv)
Post-HS       KeyUpdate + NewSessionTicket + ACK      → flight/post-hs.ts, handleAck
```

`{ }` = encrypted with handshake or application traffic keys.
