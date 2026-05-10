# TURN/TLS loopback example

This example pairs a werift TypeScript signaling server with a Vite + React SPA client.

The server:

* accepts `POST /session` over HTTPS,
* creates a werift `RTCPeerConnection` offer with `createDataChannel("loopback")`,
* returns the offer plus a `turns:` URL and one-time TURN credentials,
* accepts `PUT /session` with `{ username, answer }`,
* multiplexes HTTPS signaling and TURN over TLS on the same public port,
* echoes every received DataChannel message back to the client.

The client:

* fetches the server offer and TURN credentials,
* creates a browser `RTCPeerConnection` with `iceTransportPolicy: "relay"`,
* waits for ICE gathering to complete before the `PUT /session`,
* receives the server-created DataChannel with `ondatachannel`,
* sends one echo message when the channel opens and shows the loopback result.

## Run

```sh
cd examples/turn-loopback
npm install
npm run server
```

In another terminal:

```sh
cd examples/turn-loopback
npm run client
```

Then open the Vite URL, keep the default signaling base URL, and click **Start echo session**.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `TURN_LOOPBACK_HOST` | `0.0.0.0` | Bind address for the shared TLS listener |
| `TURN_LOOPBACK_PORT` | `8443` | Shared public port for HTTPS + TURN/TLS |
| `TURN_LOOPBACK_PUBLIC_HOST` | `127.0.0.1` | Hostname used in the returned `turns:` URL |
| `TURN_LOOPBACK_RELAY_ADDRESS` | `127.0.0.1` | Relay address advertised by the TURN server |
| `TURN_LOOPBACK_RELAY_BIND_ADDRESS` | same as host | Bind address for relay UDP sockets |
| `TURN_LOOPBACK_REALM` | `turn-loopback.local` | TURN realm |
| `TURN_LOOPBACK_PENDING_SESSION_TTL_MS` | `60000` | TTL before an unanswered session is cleaned up |
| `TURN_LOOPBACK_ACTIVE_SESSION_TTL_MS` | `300000` | TTL for established sessions |
| `TURN_LOOPBACK_CERT_PEM` | bundled self-signed cert | PEM body for the TLS certificate |
| `TURN_LOOPBACK_KEY_PEM` | bundled self-signed key | PEM body for the TLS private key |
| `TURN_LOOPBACK_CERT_FILE` | none | Path to a TLS certificate PEM file |
| `TURN_LOOPBACK_KEY_FILE` | none | Path to a TLS private key PEM file |
| `VITE_SIGNALING_BASE_URL` | `https://127.0.0.1:8443` | Default server URL shown in the SPA |

## Notes

* The werift server peer does **not** set `iceTransportPolicy: "relay"` and does **not** configure TURN client settings.
* The browser client does force relay-only ICE and uses the server-provided `turns:` URI.
* Browsers are strict about `turns:` certificates. For local use, trust the certificate first or replace the bundled self-signed certificate with a locally trusted or publicly valid one.
* Each `POST /session` creates unique TURN credentials, so multiple tabs or devices can run independent echo sessions concurrently.
