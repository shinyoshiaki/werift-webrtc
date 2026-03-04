import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";

import { bufferReader } from "../../src/imports/common";
import { classes, methods } from "../../src/stun/const";
import { Message, paddingLength, parseMessage } from "../../src/stun/message";
import { createTurnClient } from "../../src/turn/protocol";

/**
 * Integration test: TURN allocation over TLS (TURNS).
 *
 * This test creates a minimal mock TURN server over TLS that handles
 * the standard TURN authentication flow:
 *   1. Client sends ALLOCATE → server responds 401 + NONCE + REALM
 *   2. Client retries with MESSAGE-INTEGRITY → server responds with
 *      XOR-RELAYED-ADDRESS + XOR-MAPPED-ADDRESS + LIFETIME
 *
 * This validates the complete TURNS flow end-to-end:
 *   TLS handshake → STUN framing over TLS → TURN auth → ALLOCATE success
 *
 * References:
 * - pion/turn examples/turn-client/tls/ (Go TLS TURN client)
 * - pion/turn examples/turn-server/tls/ (Go TLS TURN server)
 * - RFC 5766 (TURN), RFC 7065 (TURN URI)
 */

function generateTestCert(): { key: string; cert: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "werift-turn-tls-"));
  const keyPath = path.join(tmpDir, "key.pem");
  const certPath = path.join(tmpDir, "cert.pem");

  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
  ]);

  const key = fs.readFileSync(keyPath, "utf-8");
  const cert = fs.readFileSync(certPath, "utf-8");

  fs.rmSync(tmpDir, { recursive: true });
  return { key, cert };
}

/**
 * Read STUN-framed messages from a TLS stream buffer.
 * Same framing logic as TurnProtocol.dataReceived for TCP/TLS.
 */
function extractStunMessages(
  buffer: Buffer,
): { messages: Message[]; remaining: Buffer } {
  const messages: Message[] = [];
  let pos = 0;

  while (pos + 4 <= buffer.length) {
    const [, attrLength] = bufferReader(buffer.subarray(pos, pos + 4), [2, 2]);
    const padded = attrLength + paddingLength(attrLength);
    const fullLength = 20 + padded;

    if (pos + fullLength > buffer.length) break;

    // Parse without padding bytes
    const msgData = buffer.subarray(pos, pos + 20 + attrLength);
    const msg = parseMessage(msgData);
    if (msg) {
      messages.push(msg);
    }
    pos += fullLength;
  }

  return { messages, remaining: buffer.subarray(pos) };
}

/** Send a STUN message with TCP/TLS framing (4-byte padding) */
function sendStunMessage(socket: tls.TLSSocket, message: Message) {
  const data = message.bytes;
  const padding = paddingLength(data.length);
  const padded =
    padding > 0 ? Buffer.concat([data, Buffer.alloc(padding)]) : data;
  socket.write(padded);
}

interface MockTurnServerConfig {
  username: string;
  password: string;
  realm: string;
  relayAddress: [string, number];
}

function createMockTurnTlsServer(
  key: string,
  cert: string,
  config: MockTurnServerConfig,
): Promise<{ server: tls.Server; port: number }> {
  return new Promise((resolve) => {
    const server = tls.createServer({ key, cert }, (socket) => {
      let buffer: Buffer = Buffer.alloc(0);
      let requestCount = 0;

      socket.on("data", (data) => {
        buffer = Buffer.concat([buffer, data]);
        const result = extractStunMessages(buffer);
        const messages = result.messages;
        buffer = Buffer.from(result.remaining);

        for (const msg of messages) {
          requestCount++;

          if (requestCount === 1) {
            // First ALLOCATE: respond with 401 + nonce + realm
            const response = new Message(methods.ALLOCATE, classes.ERROR);
            response.transactionId = msg.transactionId;
            response.setAttribute("ERROR-CODE", [401, "Unauthorized"]);
            response.setAttribute("NONCE", Buffer.from("test-nonce-value"));
            response.setAttribute("REALM", config.realm);
            sendStunMessage(socket, response);
          } else {
            // Second ALLOCATE (with auth): respond with success
            const response = new Message(methods.ALLOCATE, classes.RESPONSE);
            response.transactionId = msg.transactionId;
            response.setAttribute(
              "XOR-RELAYED-ADDRESS",
              config.relayAddress,
            );
            response.setAttribute("XOR-MAPPED-ADDRESS", [
              socket.remoteAddress!,
              socket.remotePort!,
            ]);
            response.setAttribute("LIFETIME", 600);
            sendStunMessage(socket, response);
          }
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

describe("TURN over TLS (TURNS)", () => {
  let testCert: { key: string; cert: string };

  beforeAll(() => {
    testCert = generateTestCert();
  });

  test("allocates relay address over TLS", async () => {
    const relayAddress: [string, number] = ["10.0.0.1", 49152];
    const { server, port } = await createMockTurnTlsServer(
      testCert.key,
      testCert.cert,
      {
        username: "testuser",
        password: "testpass",
        realm: "test.realm",
        relayAddress,
      },
    );

    try {
      const turn = await createTurnClient(
        {
          address: ["127.0.0.1", port],
          username: "testuser",
          password: "testpass",
        },
        { ssl: true, transport: "tcp" },
      );

      // Verify allocation succeeded
      expect(turn.relayedAddress).toEqual(relayAddress);
      expect(turn.mappedAddress).toBeTruthy();
      expect(turn.mappedAddress[0]).toBe("127.0.0.1");

      await turn.close();
    } finally {
      server.close();
    }
  }, 10000);

  test("TLS transport is used (not plain TCP)", async () => {
    const { server, port } = await createMockTurnTlsServer(
      testCert.key,
      testCert.cert,
      {
        username: "testuser",
        password: "testpass",
        realm: "test.realm",
        relayAddress: ["10.0.0.1", 49152],
      },
    );

    try {
      const turn = await createTurnClient(
        {
          address: ["127.0.0.1", port],
          username: "testuser",
          password: "testpass",
        },
        { ssl: true, transport: "tcp" },
      );

      // Verify TLS transport was selected
      expect(turn.transport.type).toBe("tls");

      await turn.close();
    } finally {
      server.close();
    }
  }, 10000);
});
