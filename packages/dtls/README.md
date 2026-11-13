DTLS v1.2 server/client Implementation for TypeScript

# Example

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

server.onData = (data) => {
  console.log(data.toString());
};

client.onConnect = () => {
  client.send(Buffer.from("ping"));
};
client.onData = (data) => {
  console.log(data.toString());
};

client.connect();
```

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
server.onClose.subscribe(() => {}); // the peer sent close_notify (answered with close_notify)
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

- RFC5246
- RFC6347
- pion/dtls https://github.com/pion/dtls
- nodertc/dtls https://github.com/nodertc/dtls
- node-dtls https://github.com/Rantanen/node-dtls
- node-dtls-client https://github.com/AlCalzone/node-dtls-client
- OpenSSL

# create key & cert

```sh
openssl genrsa 2048 > rsa.key
openssl pkcs8 -in rsa.key -topk8 -out key.pem -nocrypt
openssl req -new -key key.pem > cert.csr
openssl x509 -req -days 3650 -signkey key.pem -in cert.csr -out  cert.pem
```
