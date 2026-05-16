# TURN/TLS loopback example

This example pairs a werift TypeScript signaling server with a Vite + React SPA client.

The server:

* accepts `POST /session` over HTTPS,
* creates a werift `RTCPeerConnection` offer with `createDataChannel("loopback")`,
* returns the offer plus a `turns:` URL and one-time TURN credentials,
* accepts `PUT /session` with `{ username, answer }`,
* multiplexes HTTPS signaling and TURN over TLS on the same public port,
* echoes every received DataChannel message back to the client.
* serves the built SPA itself so a single HTTPS address can host both the UI and TURN/TLS signaling.

The client:

* fetches the server offer and TURN credentials,
* creates a browser `RTCPeerConnection` with `iceTransportPolicy: "relay"`,
* waits for ICE gathering to complete before the `PUT /session`,
* receives the server-created DataChannel with `ondatachannel`,
* sends one echo message when the channel opens and shows the loopback result.
* can target any signaling/TURN server URL in dev mode, while production builds are pinned to the hosting origin.

## Run in dev

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

Then open the Vite URL, enter any HTTPS signaling base URL that serves this example's `/session` API, and click **Start echo session**.

## Build and host from the server

```sh
cd examples/turn-loopback
npm install
npm run build
npm run server
```

Open `https://127.0.0.1:8443/` and the server-hosted SPA will use the same origin for both HTTPS signaling and the returned `turns:` URI.

## Docker

Build from the repository root so the example can access the workspace packages it imports directly:

```sh
cd examples/turn-loopback
npm run docker:build
```

The image now starts two processes inside one container:

* **werift server** on `8443` for HTTPS `POST/PUT /session`, SPA hosting, and TURN/TLS multiplexing.
* **nginx** on `8080` for `/.well-known/acme-challenge/*`, plain `GET /health`, and HTTP → HTTPS redirect.

Run it with the public port mapping expected by browsers and ACME:

```sh
docker run --rm \
  -p 80:8080 \
  -p 443:8443 \
  -e TURN_LOOPBACK_PUBLIC_HOST=localhost \
  werift-turn-loopback
```

When `CERTBOT_DOMAINS` is unset, the entrypoint generates a short-lived self-signed certificate inside the container and points `TURN_LOOPBACK_CERT_FILE` / `TURN_LOOPBACK_KEY_FILE` at it automatically. Open `https://localhost/` (or `https://127.0.0.1/`) and trust or bypass the local certificate warning as needed.

To request an ACME certificate at startup instead, publish the container on public ports `80/443` and set the Certbot variables:

```sh
docker run --rm \
  -p 80:8080 \
  -p 443:8443 \
  -e TURN_LOOPBACK_PUBLIC_HOST=example.com \
  -e CERTBOT_DOMAINS=example.com \
  -e CERTBOT_EMAIL=ops@example.com \
  -e CERTBOT_STAGING=1 \
  werift-turn-loopback
```

In this mode nginx serves `/.well-known/acme-challenge/*` from the configured webroot over HTTP, redirects every other HTTP request to HTTPS, and Certbot writes the resulting certificate material to container-local paths before the werift server starts.

## Chrome/Playwright E2E

```sh
cd examples/turn-loopback
npm run chrome-e2e
```

The harness builds the SPA, starts the HTTPS/TURN server plus the Vite dev server, and verifies:

* the single-address hosted SPA can complete echo,
* multiple pages can connect concurrently with independent sessions,
* the dev SPA can point at an arbitrary server URL,
* Chromium runs with `--ignore-certificate-errors` and `--allow-insecure-localhost`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `TURN_LOOPBACK_HOST` | `0.0.0.0` | Bind address for the shared TLS listener |
| `TURN_LOOPBACK_HTTP_PORT` | `8080` in Docker | Bind address for the plain HTTP challenge / redirect app |
| `TURN_LOOPBACK_PORT` | `8443` | Shared public port for HTTPS + TURN/TLS |
| `TURN_LOOPBACK_PUBLIC_AUTHORITY` | unset | Explicit `host:port` authority used in the returned `turns:` URL |
| `TURN_LOOPBACK_PUBLIC_HOST` | request `Host` header, else `127.0.0.1` | Hostname used when building the returned `turns:` URL |
| `TURN_LOOPBACK_PUBLIC_PORT` | same as `TURN_LOOPBACK_PORT` (`443` in Docker image) | External port used when the request `Host` header omits a port |
| `TURN_LOOPBACK_RELAY_ADDRESS` | `127.0.0.1` | Relay address advertised by the TURN server |
| `TURN_LOOPBACK_RELAY_BIND_ADDRESS` | same as host | Bind address for relay UDP sockets |
| `TURN_LOOPBACK_REALM` | `turn-loopback.local` | TURN realm |
| `TURN_LOOPBACK_PENDING_SESSION_TTL_MS` | `60000` | TTL before an unanswered session is cleaned up |
| `TURN_LOOPBACK_ACTIVE_SESSION_TTL_MS` | `300000` | TTL for established sessions |
| `TURN_LOOPBACK_CERT_PEM` | bundled self-signed cert | PEM body for the TLS certificate |
| `TURN_LOOPBACK_KEY_PEM` | bundled self-signed key | PEM body for the TLS private key |
| `TURN_LOOPBACK_CERT_FILE` | none | Path to a TLS certificate PEM file |
| `TURN_LOOPBACK_KEY_FILE` | none | Path to a TLS private key PEM file |
| `CERTBOT_DOMAINS` | unset | Comma- or space-separated domain list to request with `certbot certonly --webroot` |
| `CERTBOT_EMAIL` | unset | Registration email for Certbot; omitted uses `--register-unsafely-without-email` |
| `CERTBOT_STAGING` | `0` | Set to `1` / `true` / `yes` to use the ACME staging environment |
| `CERTBOT_WEBROOT` | `/var/www/turn-loopback` in Docker | Webroot served by the HTTP app for `/.well-known/acme-challenge/*` |
| `CERTBOT_STATE_DIR` | `/var/lib/turn-loopback/certbot` in Docker | Container-local Certbot config / work / logs directory |
| `CERTBOT_RENEW_INTERVAL` | `0` in Docker | Seconds between `certbot renew` attempts; `0` disables the background renew loop |
| `VITE_SIGNALING_BASE_URL` | `https://127.0.0.1:8443` | Default dev-mode server URL shown in the SPA |

## Notes

* The werift server peer does **not** set `iceTransportPolicy: "relay"` and does **not** configure TURN client settings.
* The browser client does force relay-only ICE and uses the server-provided `turns:` URI.
* Production builds always call the same origin that hosted the SPA; the editable signaling URL field is only for dev mode.
* Browsers are strict about `turns:` certificates. For local container use, trust the generated self-signed certificate first or provide publicly trusted / locally trusted certificate material.
* Each `POST /session` creates unique TURN credentials, so multiple tabs or devices can run independent echo sessions concurrently.
* The Docker image keeps HTTP challenge state and issued certificates **inside the container only**. Without a persistent volume, a restart repeats setup and may request a fresh certificate.
* Repeated non-persistent startup against the ACME production endpoint can hit rate limits. Use `CERTBOT_STAGING=1` until DNS, port publishing, and redirect behavior are confirmed.
* `CERTBOT_RENEW_INTERVAL` only refreshes files on disk. The running werift process does not hot-reload TLS material, so long-lived containers still need a restart to begin serving a renewed certificate.
* If your external HTTPS/TURN authority differs from the container bind port mapping, set `TURN_LOOPBACK_PUBLIC_AUTHORITY` or `TURN_LOOPBACK_PUBLIC_HOST` + `TURN_LOOPBACK_PUBLIC_PORT` so the returned `turns:` URI stays aligned with the public `443` endpoint.
