import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { NodeTurnServer } from "../../packages/ice-server/src/node/turnServer";

export type TurnRelayTransport = "udp" | "tcp" | "tls";

export type TurnRelayConfig = {
  turn: {
    udpUrl: string;
    tcpUrl: string;
    tlsUrl: string;
    username: string;
    credential: string;
  };
};

let turnServer: NodeTurnServer | undefined;
let turnRelayConfig: TurnRelayConfig | undefined;

export async function startTurnServer() {
  if (turnServer) {
    return turnRelayConfig!;
  }

  const username = `turn-user-${randomUUID()}`;
  const credential = `turn-password-${randomUUID()}`;
  turnServer = new NodeTurnServer({
    host: "127.0.0.1",
    port: 0,
    relayAddress: "127.0.0.1",
    relayBindAddress: "127.0.0.1",
    realm: "werift.local",
    software: "werift-e2e-turn",
    fingerprint: "always",
    credentials: {
      [username]: credential,
    },
    tls: {
      cert: readTurnTlsAsset("cert.pem"),
      key: readTurnTlsAsset("key.pem"),
    },
  });
  await turnServer.listen();

  turnRelayConfig = {
    turn: {
      udpUrl: `turn:${turnServer.address?.[0]}:${turnServer.address?.[1]}?transport=udp`,
      tcpUrl: `turn:${turnServer.address?.[0]}:${turnServer.address?.[1]}?transport=tcp`,
      tlsUrl: `turns:${turnServer.tlsAddress?.[0]}:${turnServer.tlsAddress?.[1]}?transport=tcp`,
      username,
      credential,
    },
  };

  return turnRelayConfig;
}

export async function stopTurnServer() {
  if (!turnServer) {
    return;
  }

  const activeTurnServer = turnServer;
  turnServer = undefined;
  turnRelayConfig = undefined;
  await activeTurnServer.close();
}

export function getTurnRelayConfig() {
  if (!turnRelayConfig) {
    throw new Error("TURN relay config is not initialized");
  }
  return turnRelayConfig;
}

export function getTurnIceServer(transport: TurnRelayTransport) {
  const config = getTurnRelayConfig().turn;
  return {
    urls:
      transport === "udp"
        ? config.udpUrl
        : transport === "tcp"
          ? config.tcpUrl
          : config.tlsUrl,
    username: config.username,
    credential: config.credential,
  };
}

export function getTurnTlsOptions() {
  return {
    rejectUnauthorized: false,
  };
}

function readTurnTlsAsset(name: string) {
  return readFileSync(resolve(process.cwd(), "../packages/dtls/assets", name));
}
