import { type ServerResponse, createServer } from "node:http";

import { NodeStunServer, NodeTurnServer } from "../../src";

const TURN_USERNAME = "chrome-turn-user";
const TURN_PASSWORD = "chrome-turn-password";

type HarnessMetrics = {
  stunBindingRequests: number;
};

const metrics: HarnessMetrics = {
  stunBindingRequests: 0,
};

const stunServer = new NodeStunServer({
  host: "127.0.0.1",
  port: 0,
  software: "werift-ice-server/chrome-e2e",
  fingerprint: "always",
  authenticateRequest: () => {
    metrics.stunBindingRequests += 1;
    return { ok: true };
  },
});

const turnServer = new NodeTurnServer({
  host: "127.0.0.1",
  port: 0,
  relayAddress: "127.0.0.1",
  relayBindAddress: "127.0.0.1",
  software: "werift-ice-server/chrome-e2e",
  fingerprint: "always",
  credentials: {
    [TURN_USERNAME]: TURN_PASSWORD,
  },
});

const port = Number(process.env.CHROME_E2E_PORT ?? "8887");
let shutdownPromise: Promise<void> | undefined;

function json(body: unknown) {
  return JSON.stringify(body);
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(json(body));
}

function resetMetrics() {
  metrics.stunBindingRequests = 0;
}

async function closeServers() {
  await Promise.all([stunServer.close(), turnServer.close()]);
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (!error) {
        resolve();
        return;
      }

      if ((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }

      reject(error);
    });
  });
}

async function shutdown(exitCode: number) {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      try {
        await closeServers();
        process.exit(exitCode);
      } catch (error) {
        console.error("failed to shutdown chrome-e2e harness", error);
        process.exit(1);
      }
    })();
  }

  await shutdownPromise;
}

const httpServer = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    });
    response.end();
    return;
  }

  if (request.url === "/health" && request.method === "GET") {
    writeJson(response, 200, { ready: true });
    return;
  }

  if (request.url === "/config" && request.method === "GET") {
    writeJson(response, 200, {
      stun: {
        url: `stun:${stunServer.address?.[0]}:${stunServer.address?.[1]}`,
      },
      turn: {
        url: `turn:${turnServer.address?.[0]}:${turnServer.address?.[1]}?transport=udp`,
        username: TURN_USERNAME,
        credential: TURN_PASSWORD,
      },
    });
    return;
  }

  if (request.url === "/metrics" && request.method === "GET") {
    writeJson(response, 200, metrics);
    return;
  }

  if (request.url === "/metrics/reset" && request.method === "POST") {
    resetMetrics();
    writeJson(response, 200, metrics);
    return;
  }

  if (request.url === "/stop" && request.method === "PUT") {
    response.once("finish", () => {
      void shutdown(0);
    });
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    });
    response.end();
    return;
  }

  writeJson(response, 404, { error: "not-found" });
});

async function main() {
  await stunServer.listen();
  await turnServer.listen();
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  console.log("chrome-e2e server started", {
    port,
    stun: stunServer.address,
    turn: turnServer.address,
  });
}

process.once("SIGINT", () => {
  void shutdown(130);
});

process.once("SIGTERM", () => {
  void shutdown(143);
});

process.once("uncaughtException", (error) => {
  console.error(error);
  void shutdown(1);
});

process.once("unhandledRejection", (reason) => {
  console.error(reason);
  void shutdown(1);
});

void main().catch((error) => {
  console.error(error);
  void shutdown(1);
});
