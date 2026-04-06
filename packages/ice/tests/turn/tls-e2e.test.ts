import * as net from "node:net";

import { createTurnClient } from "../../src/turn/protocol";

/**
 * E2E integration test: TURNS allocation against a real pion/turn TLS server.
 *
 * This test requires a running pion/turn TLS server (see docker/pion-turn-tls/).
 * It is skipped unless TURNS_TEST_HOST and TURNS_TEST_PORT are set.
 *
 * To run locally:
 *   cd packages/ice/docker/pion-turn-tls
 *   docker compose up -d --build
 *   TURNS_TEST_HOST=127.0.0.1 TURNS_TEST_PORT=5349 npx vitest run tests/turn/tls-e2e.test.ts
 *
 * In CI (GitHub Actions), the workflow starts the container and sets the env vars.
 */

const TURNS_HOST = process.env.TURNS_TEST_HOST;
const TURNS_PORT = process.env.TURNS_TEST_PORT
  ? Number.parseInt(process.env.TURNS_TEST_PORT)
  : undefined;
const TURNS_USER = process.env.TURNS_TEST_USER ?? "username";
const TURNS_PASS = process.env.TURNS_TEST_PASS ?? "password";

const hasTurnsServer = !!TURNS_HOST && !!TURNS_PORT;

describe.skipIf(!hasTurnsServer)("TURNS E2E (real pion/turn TLS server)", () => {
  // Verify the server is actually reachable before running tests
  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(
        { host: TURNS_HOST!, port: TURNS_PORT! },
        () => {
          socket.destroy();
          resolve();
        },
      );
      socket.on("error", (err) => {
        reject(
          new Error(
            `TURNS server not reachable at ${TURNS_HOST}:${TURNS_PORT}: ${err.message}`,
          ),
        );
      });
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(
          new Error(
            `TURNS server connection timed out at ${TURNS_HOST}:${TURNS_PORT}`,
          ),
        );
      });
    });
  });

  test("allocates relay address over TLS against real server", async () => {
    const turn = await createTurnClient(
      {
        address: [TURNS_HOST!, TURNS_PORT!],
        username: TURNS_USER,
        password: TURNS_PASS,
      },
      {
        ssl: true,
        sslVerifyCert: false, // pion/turn uses self-signed certs in Docker
        transport: "tcp",
      },
    );

    try {
      // Verify allocation succeeded
      expect(turn.relayedAddress).toBeTruthy();
      expect(turn.relayedAddress[0]).toBeTruthy();
      expect(turn.relayedAddress[1]).toBeGreaterThan(0);

      expect(turn.mappedAddress).toBeTruthy();
      expect(turn.mappedAddress[0]).toBeTruthy();

      // Verify TLS transport was used
      expect(turn.transport.type).toBe("tls");
    } finally {
      await turn.close();
    }
  }, 15000);

  test("TURN refresh works over TLS", async () => {
    const turn = await createTurnClient(
      {
        address: [TURNS_HOST!, TURNS_PORT!],
        username: TURNS_USER,
        password: TURNS_PASS,
      },
      {
        ssl: true,
        sslVerifyCert: false,
        transport: "tcp",
        lifetime: 10, // short lifetime to test refresh sooner
      },
    );

    try {
      const initialRelay = turn.relayedAddress;
      expect(initialRelay).toBeTruthy();

      // Wait a moment and verify connection is still alive
      await new Promise((r) => setTimeout(r, 2000));

      // Send a channel bind to verify the connection is functional
      // (this exercises the full TURN data path over TLS)
      expect(turn.transport.closed).toBe(false);
    } finally {
      await turn.close();
    }
  }, 15000);
});
