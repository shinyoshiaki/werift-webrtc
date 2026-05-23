import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { BackendTurnServer } from "./backendTurn";
import { CredentialIssuer } from "./credentials";
import { SharedFrontProxyKv } from "./kv";
import { FrontProxyLoadBalancer } from "./lb";
import { FrontProxyRelay } from "./relay";
import type { PublicTurnAddress } from "./types";

export type FrontProxyTurnExampleOptions = {
  host?: string;
  port?: number;
  publicHost?: string;
  publicPort?: number;
  relayCount?: number;
  backendCount?: number;
  realm?: string;
  credentialSecret?: string;
  relayAddress?: string;
  relayBindAddress?: string;
};

export class FrontProxyTurnExample {
  readonly kv = new SharedFrontProxyKv();
  readonly credentialIssuer: CredentialIssuer;
  readonly backends: BackendTurnServer[];
  readonly relays: FrontProxyRelay[];
  readonly lb: FrontProxyLoadBalancer;
  readonly publicTurnAddress: PublicTurnAddress;

  constructor(
    private readonly options: Required<FrontProxyTurnExampleOptions>,
  ) {
    this.credentialIssuer = new CredentialIssuer(
      options.credentialSecret,
      this.kv,
    );

    this.backends = Array.from({ length: options.backendCount }, (_, index) => {
      return new BackendTurnServer({
        id: `backend-${index + 1}`,
        realm: options.realm,
        relayAddress: options.relayAddress,
        relayBindAddress: options.relayBindAddress,
        fingerprint: "always",
        getPassword: (username) =>
          this.credentialIssuer.passwordForUsername(username),
      });
    });

    this.publicTurnAddress = {
      ip: options.publicHost,
      port: options.publicPort || options.port,
      transport: "tcp",
    };

    this.relays = Array.from({ length: options.relayCount }, (_, index) => {
      return new FrontProxyRelay({
        id: `relay-${index + 1}`,
        kv: this.kv,
        credentialIssuer: this.credentialIssuer,
        backends: this.backends,
        publicTurnAddress: this.publicTurnAddress,
      });
    });

    this.lb = new FrontProxyLoadBalancer({
      host: options.host,
      port: options.port,
      publicTurnAddress: this.publicTurnAddress,
      tls: readTlsOptions(),
      relays: this.relays,
    });
  }

  get port() {
    const address = this.lb.address;
    if (!address || typeof address === "string") {
      return this.options.port;
    }
    return address.port;
  }

  get turnUrl() {
    return `turns:${this.options.publicHost}:${this.options.publicPort || this.port}?transport=tcp`;
  }

  async listen() {
    await this.lb.listen();
    if (this.options.publicPort === 0) {
      this.options.publicPort = this.port;
      this.publicTurnAddress.port = this.port;
    }
  }

  async close() {
    await this.lb.close();
    await Promise.all(this.backends.map((backend) => backend.close()));
  }
}

export function createFrontProxyTurnExample(
  options: FrontProxyTurnExampleOptions = {},
) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8443;
  return new FrontProxyTurnExample({
    host,
    port,
    publicHost: options.publicHost ?? host,
    publicPort: options.publicPort ?? port,
    relayCount: options.relayCount ?? 2,
    backendCount: options.backendCount ?? 1,
    realm: options.realm ?? "front-proxy-turn.local",
    credentialSecret:
      options.credentialSecret ?? randomBytes(32).toString("base64url"),
    relayAddress: options.relayAddress ?? host,
    relayBindAddress: options.relayBindAddress ?? host,
  });
}

if (require.main === module) {
  const app = createFrontProxyTurnExample({
    host: process.env.FRONT_PROXY_TURN_HOST ?? "0.0.0.0",
    port: numberFromEnv("FRONT_PROXY_TURN_PORT", 8443),
    publicHost: process.env.FRONT_PROXY_TURN_PUBLIC_HOST ?? "127.0.0.1",
    publicPort: numberFromEnv("FRONT_PROXY_TURN_PUBLIC_PORT", 8443),
    relayCount: numberFromEnv("FRONT_PROXY_TURN_RELAY_COUNT", 2),
    backendCount: numberFromEnv("FRONT_PROXY_TURN_BACKEND_COUNT", 1),
    realm: process.env.FRONT_PROXY_TURN_REALM ?? "front-proxy-turn.local",
    credentialSecret: process.env.FRONT_PROXY_TURN_CREDENTIAL_SECRET,
    relayAddress: process.env.FRONT_PROXY_TURN_RELAY_ADDRESS ?? "127.0.0.1",
    relayBindAddress:
      process.env.FRONT_PROXY_TURN_RELAY_BIND_ADDRESS ?? "127.0.0.1",
  });

  const shutdown = async (exitCode: number) => {
    await app.close();
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));
  void app.listen().then(() => {
    const address = app.lb.address as AddressInfo;
    console.log("front-proxy-turn example started", {
      listen: `${address.address}:${address.port}`,
      turnUrl: app.turnUrl,
      relays: app.relays.map((relay) => relay.id),
      backends: app.backends.map((backend) => backend.id),
    });
  });
}

function readTlsOptions() {
  const assetDir = resolve(__dirname, "../../../packages/dtls/assets");
  return {
    cert: readFileSync(
      process.env.FRONT_PROXY_TURN_CERT_FILE ?? resolve(assetDir, "cert.pem"),
    ),
    key: readFileSync(
      process.env.FRONT_PROXY_TURN_KEY_FILE ?? resolve(assetDir, "key.pem"),
    ),
  };
}

function numberFromEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}
