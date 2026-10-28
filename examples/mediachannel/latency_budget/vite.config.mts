// `npx vite ../mediachannel/latency_budget` (from examples/e2e) picks this up.
// (.mts: an ES module config, as examples/ has no "type": "module")
// Serves the page on 0.0.0.0 over HTTPS so it can be opened from another
// machine (e.g. a tailnet): off localhost, Chrome only allows getUserMedia,
// AudioWorklet, WebCodecs and Encoded Transform in a secure context. The
// werift signaling is proxied on the same origin (`/signaling`).
//
// Environment:
//   LATENCY_BUDGET_TLS_CERT / LATENCY_BUDGET_TLS_KEY  PEM files (e.g. from
//     `tailscale cert <machine>.<tailnet>.ts.net`). Default: a self-signed
//     certificate generated with openssl into ./.cert (the browser warns once).
//   LATENCY_BUDGET_HTTP=1  plain HTTP (only usable on localhost)
//   LATENCY_BUDGET_HOST (default 0.0.0.0), LATENCY_BUDGET_PORT (default 5173)
//   LATENCY_BUDGET_SIGNALING (default ws://127.0.0.1:8888)
//   LATENCY_BUDGET_ALLOWED_HOSTS  extra Host names, comma separated
//     (*.ts.net and IP addresses are allowed already)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vite";

const env = process.env;

function tls() {
  if (env.LATENCY_BUDGET_HTTP === "1") return undefined;
  if (env.LATENCY_BUDGET_TLS_CERT && env.LATENCY_BUDGET_TLS_KEY) {
    return {
      cert: readFileSync(env.LATENCY_BUDGET_TLS_CERT),
      key: readFileSync(env.LATENCY_BUDGET_TLS_KEY),
    };
  }
  const dir = join(import.meta.dirname, ".cert");
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  if (!existsSync(cert) || !existsSync(key)) {
    mkdirSync(dir, { recursive: true });
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "365",
      "-subj",
      "/CN=werift latency budget example",
      "-addext",
      `subjectAltName=DNS:localhost,DNS:${hostname()},IP:127.0.0.1`,
      "-keyout",
      key,
      "-out",
      cert,
    ]);
  }
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

export default defineConfig({
  server: {
    host: env.LATENCY_BUDGET_HOST ?? "0.0.0.0",
    port: Number(env.LATENCY_BUDGET_PORT ?? 5173),
    https: tls(),
    allowedHosts: [
      ".ts.net",
      ...(env.LATENCY_BUDGET_ALLOWED_HOSTS?.split(",") ?? []),
    ],
    proxy: {
      // Exact path: a plain "/signaling" prefix would also catch signaling.ts
      "^/signaling$": {
        target: env.LATENCY_BUDGET_SIGNALING ?? "ws://127.0.0.1:8888",
        ws: true,
      },
    },
  },
});
