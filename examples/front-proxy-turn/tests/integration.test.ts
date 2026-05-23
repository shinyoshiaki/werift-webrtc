import { request as httpsRequest } from "node:https";

import { describe, expect, test } from "vitest";

import {
  methods,
  padTurnFrame,
  parseMessage,
} from "../../../packages/ice-server/src";
import { createFrontProxyTurnExample } from "../src/server";
import {
  TURN_REALM,
  authenticateTurnRequest,
  connectTurnTls,
  createTurnTcpReader,
  makeAllocateRequest,
  writeTurnFrame,
} from "./fixture";

type CredentialResponse = {
  backendId: string;
  username: string;
  password: string;
  turnUrl: string;
  iceServers: {
    urls: string;
    username: string;
    credential: string;
  }[];
};

describe("front-proxy-turn integration", () => {
  test("serves HTTPS credentials and keeps multi-backend Allocate routing on one TLS address", async () => {
    const app = createFrontProxyTurnExample({
      port: 0,
      publicPort: 0,
      relayCount: 2,
      backendCount: 2,
      credentialSecret: "front-proxy-turn-integration-secret",
      realm: TURN_REALM,
    });
    await app.listen();

    try {
      // Act: HTTPS と同じ公開 TLS address から TURN credentials を発行する。
      const credentials = await postCredentials(app.port);

      // Assert: Relay が backend を選択し、username -> backend を shared KV に保存している。
      expect(credentials.turnUrl).toBe(
        `turns:127.0.0.1:${app.port}?transport=tcp`,
      );
      expect(app.kv.getUsernameBackend(credentials.username)).toBe(
        credentials.backendId,
      );

      const socket = await connectTurnTls(app.port);
      const readFrame = createTurnTcpReader(socket);
      try {
        // Act: 同じ TLS address に TURN/TLS で接続し、初回 Allocate で NONCE を受け取る。
        const firstAllocateFrame = padTurnFrame(makeAllocateRequest().bytes);
        socket.write(firstAllocateFrame.subarray(0, 5));
        socket.write(firstAllocateFrame.subarray(5));
        const unauthorized = parseMessage(await readFrame())!;
        const afterUnauthorized = app.kv.snapshot().clientTransportToBackend;

        // Assert: unauthenticated Allocate でも credentials 発行 backend に nonce challenge が pin される。
        expect(Object.values(afterUnauthorized)).toEqual([
          credentials.backendId,
        ]);

        // Act: 認証済み Allocate を retry し、Backend TURN の virtual transport に allocation を作る。
        writeTurnFrame(
          socket,
          authenticateTurnRequest(
            makeAllocateRequest(),
            unauthorized.getAttributeValue("NONCE"),
            {
              backendId: credentials.backendId,
              username: credentials.username,
              password: credentials.password,
            },
          ).bytes,
        );
        const allocateResponse = parseMessage(await readFrame())!;

        // Assert: TURN/TLS Allocate が成功し、clientTransportKey -> backend の route も作られている。
        expect(allocateResponse.messageMethod).toBe(methods.ALLOCATE);
        expect(
          allocateResponse.getAttributeValue("XOR-RELAYED-ADDRESS"),
        ).toBeTruthy();
        expect(
          Object.values(app.kv.snapshot().clientTransportToBackend),
        ).toContain(credentials.backendId);
      } finally {
        socket.destroy();
      }
    } finally {
      await app.close();
    }
  });
});

function postCredentials(port: number) {
  return new Promise<CredentialResponse>((resolve, reject) => {
    const request = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/credentials",
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(
              new Error(`POST /credentials failed: ${response.statusCode}`),
            );
            return;
          }
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}
