DTLS 1.2 / 1.3 server/client implementation for TypeScript (Node.js).

**Default protocol is DTLS 1.2** for backward compatibility. DTLS 1.3 is an explicit opt-in via `protocolVersions`.

# Example (DTLS 1.2 default)

```typescript
import { DtlsServer, DtlsClient, createUdpTransport } from "werift-dtls";
import { readFileSync } from "fs";
import { createSocket } from "dgram";

const port = 55557;

const socket = createSocket("udp4");
socket.bind(port);

const server = new DtlsServer({
  cert: readFileSync("assets/cert.pem").toString(),
  key: readFileSync("assets/key.pem").toString(),
  transport: createUdpTransport(socket),
});

const client = new DtlsClient({
  transport: createUdpTransport(createSocket("udp4"), {
    address: "127.0.0.1",
    port,
  }),
});

server.onData.subscribe((data) => {
  console.log(data.toString());
});

client.onConnect.subscribe(() => {
  client.send(Buffer.from("ping"));
});
client.onData.subscribe((data) => {
  console.log(data.toString());
});

client.connect();
```

# DTLS 1.3 (opt-in)

```typescript
import {
  DtlsServer,
  DtlsClient,
  DtlsVersion,
  createUdpTransport,
} from "werift-dtls";

const common = {
  cert: certPem,
  key: keyPem,
  // Preference order. Default when omitted: [DtlsVersion.V1_2]
  protocolVersions: [DtlsVersion.V1_3],
  // Optional: [DtlsVersion.V1_3, DtlsVersion.V1_2] for fallback
};

const server = new DtlsServer({ transport: serverTransport, ...common });
const client = new DtlsClient({ transport: clientTransport, ...common });

client.onConnect.subscribe(() => client.send(Buffer.from("hello-1.3")));
await client.connect();
```

| `protocolVersions` | Behavior |
| --- | --- |
| omitted / `[V1_2]` | DTLS 1.2 only (default, WebRTC-safe) |
| `[V1_3]` | DTLS 1.3 only (`TLS_AES_128_GCM_SHA256`, X25519/P-256) |
| `[V1_3, V1_2]` | Prefer 1.3; fall back to 1.2 if peer is 1.2-only |

| `addressValidation` | Behavior (DTLS 1.3 server) |
| --- | --- |
| `"dtls-cookie"` (default) | HRR + TLS cookie before amplifying server flight; 3× anti-amplification |
| `"ice-authenticated"` / `"none"` | Skip cookie (path already trusted / tests) |

Mismatch **1.3-only × 1.2-only** fails with `ProtocolVersionError` / `protocol_version` alert (not a silent timeout).

`certificateRequest: true` enables TLS 1.3 mutual authentication (CertificateRequest + client Certificate / CertificateVerify).

`namedGroups` selects DTLS 1.3 key_share preference (e.g. `[NamedCurveAlgorithm.secp256r1_23]` for P-256 only). `mtu` controls handshake fragmentation.

`maxEarlyAppDataRecords` / `maxEarlyAppDataBytes` bound epoch-3 application data buffered before `onConnect` (UDP reorder and 0.5-RTT). Defaults are 256 records / 256 KiB — sized for WebRTC DataChannel (`maxMessageSize` 64 KiB plus SCTP control). Raise both for larger messages, or set `EARLY_APP_DATA_UNLIMITED` (`Infinity`) on trusted P2P paths (no hidden ceiling).

## Association lifecycle (1.2 / 1.3 / dual)

Wire-initiated renegotiation is not supported after connect; post-handshake epoch-0 handshake records are dropped.

One `DtlsClient` / `DtlsServer` instance is a **single association**. After any terminal transition the socket is not reusable:

| Terminal cause | Events | Public API (`send` / exporter / `remoteCertificate` / `connect`) |
| --- | --- | --- |
| Local `close()` | `onClose` once | Rejected (`DTLS association is closed`) |
| Peer `close_notify` | `onClose` once (no `onError`) | Rejected |
| Fatal alert / handshake failure | `onError` then `onClose` (each once) | Rejected |

Other warning alerts keep the association open. Create a **new** client/server for a new handshake.

Outbound **and inbound** DTLS 1.2 traffic use an **association-owned peer pin**, not the last UDP `rinfo` alone: after cookie verification (server) or `connect()` (client), non-pin peers are dropped on RX and cannot redirect TX. **Pre-cookie (unpinned)** servers ignore unauthenticated alerts and malformed handshake errors without association teardown (per-source drop only).

DTLS 1.3: pure/dual **server** association owns UDP and `carrier.inject` (same dispatcher), forwarding to the engine via `injectDatagram`. Epoch-0 alerts are processed only from an already-associated peer and only before protected keys; unassociated sources cannot fatal/close the listener. Post-handshake epoch-0 handshake/alert/ACK are dropped without state change. Local/peer close uses synchronous terminal (`onClosing` / `associationTornDown`) before async `close_notify`. `renegotiation()` is rejected after terminal close.

Generated Public API docs (`doc/classes/DtlsClient.md`, `DtlsServer.md`, `DtlsSocket.md`) are produced by root `npm run doc` and verified by `npm run doc:check` (part of `npm run ci`). After Public API or lifecycle changes, regenerate and commit `doc/` so the gate stays green (also part of root `npm run ci` / `doc:check`).

BoringSSL DTLS 1.3 interop (P0): see `tests/e2e/boringssl/README.md`. Canonical pin and C source live in `tools/boringssl-dtls13/`. CI job `dtls13-boringssl` runs `tests/e2e/boringssl/fetch-and-build-boringssl.sh` (wrapper) against that pin and fails on pin/harness mismatch (`WERIFT_REQUIRE_BORINGSSL=1`). When host git cannot clone BoringSSL, `npm run test:boringssl:docker` builds `werift-dtls-boringssl-e2e` and runs the same tests inside the image.

# Alerts

`DtlsSocket` (`DtlsClient` / `DtlsServer`) sends and receives DTLS 1.2 alerts (RFC 5246 §7.2).

```typescript
import { AlertDesc, AlertLevel, DtlsAlertError } from "werift-dtls";

// Close the connection: send close_notify, then close the transport once it
// has been sent (at most `timeoutMs`, default `DtlsSocket.AlertSendTimeoutMs` = 200 ms).
await client.close({ notify: true });

// `close()` without options sends no alert of its own and closes the transport
// right away; only an alert already being sent (sendAlert(), the close_notify
// answering the peer's) is let through first, so it is not dropped.
client.close();

// Send any alert. It is encrypted after ChangeCipherSpec (epoch > 0) and plaintext
// before it. It never rejects, and nothing is sent after close_notify / a fatal alert.
// A fatal alert also ends this side: onError fires with a local DtlsAlertError and the
// transport is closed once the alert has been sent (the promise resolves after that).
await server.sendAlert(AlertLevel.fatal, AlertDesc.InternalError);

server.onAlert.subscribe(({ level, description }) => {}); // every received alert
// the peer sent close_notify: it is answered with close_notify, and the transport is
// closed once the reply has been sent (or after the alert send timeout); no close() needed
server.onClose.subscribe(() => {});
server.onError.subscribe((error) => {
  if (error instanceof DtlsAlertError) {
    // fatal alert: error.source is "remote" (received) or "local" (sent by this side),
    // error.description / error.alertDescName tell which one. The transport is closed.
  }
});
```

- A received alert is decrypted according to its record epoch; a record that fails to decrypt is discarded.
- Once the handshake completed, a handshake record of an epoch older than the peer's authenticated one (e.g. a plaintext epoch-0 Certificate or ClientHello injected on the path) is discarded: it changes neither the peer certificate nor the session (no `renegotiation()`).
- Every alert in a received record is handled in order (a record may carry several); processing stops at the first close_notify or fatal alert, and the rest of the record and of the datagram is ignored.
- A truncated record at the end of a datagram is discarded; the records before it are still processed.
- Other warning alerts (`user_canceled`, `no_renegotiation`, ...) only fire `onAlert`. An alert whose level is neither warning nor fatal is malformed and handled like a fatal alert.
- The socket owns its transport and closes it when the connection ends: after a received close_notify (once the reply has been sent or timed out), after a fatal alert (sent or received, once a sent one went out), and on `close()`. The application does not need to call `close()` after `onClose` / `onError` (calling it is harmless). A transport shared with something else must make its `close()` release only the DTLS side (werift's WebRTC transport detaches DTLS from ICE; ICE stops with `RTCDtlsTransport.stop()`).
- The connection is ended (close_notify answered, transport closed) before the listeners run. An exception thrown by a listener (`onAlert`, `onClose`, `onError`, `onData`, `onConnect`) is logged and does not interrupt it.
- After close_notify or a fatal alert (sent or received), `send()` sends nothing, no handshake record is sent (no retransmission, no flight resent because the peer repeated its own) and the handshake does not complete.
- After a received close_notify, a fatal alert (sent or received) or `close()`, received records are no longer processed. After this side sent close_notify with `sendAlert()` alone, records are still received, so the peer's close_notify reply fires `onClose`.

## Certificate verification during the handshake

`verifyRemoteCertificate(certificate: Buffer) => boolean` (DER) is called when the peer certificate arrives.
Returning `false` or throwing sends a fatal `bad_certificate` alert and aborts the handshake before
this side sends its Finished (client: flight 5, server: flight 6), so the peer never considers the
connection established. `onError` receives a `DtlsAlertError` with `source: "local"` (the verifier's
exception is `error.reason`). A server needs `certificateRequest: true` to receive a client certificate.

```typescript
const client = new DtlsClient({
  transport,
  verifyRemoteCertificate: (certificate) => matchesFingerprint(certificate),
});
```

# reference

- RFC5246 / RFC6347 (DTLS 1.2)
- RFC8446 / RFC9147 (TLS 1.3 / DTLS 1.3)
- pion/dtls https://github.com/pion/dtls
- nodertc/dtls https://github.com/nodertc/dtls
- node-dtls https://github.com/Rantanen/node-dtls
- node-dtls-client https://github.com/AlCalzone/node-dtls-client
- OpenSSL (DTLS 1.2 E2E) / BoringSSL (DTLS 1.3 interop)

# create key & cert

```sh
openssl genrsa 2048 > rsa.key
openssl pkcs8 -in rsa.key -topk8 -out key.pem -nocrypt
openssl req -new -key key.pem > cert.csr
openssl x509 -req -days 3650 -signkey key.pem -in cert.csr -out  cert.pem
```
