import { describe, expect, test } from "vitest";

import { methods } from "../../../packages/ice-server/src";
import { CredentialIssuer } from "../src/credentials";
import { SharedFrontProxyKv } from "../src/kv";
import { computeClientTransportKey } from "../src/types";
import {
  RecordingSink,
  authenticateTurnRequest,
  createBackend,
  createContext,
  makeAllocateRequest,
  readFirstTurnMessage,
  readTurnMessages,
  requestWithUsername,
} from "./fixture";

describe("BackendTurnServer virtual transport", () => {
  test("reattaches the same clientTransportKey to the current relay sink", async () => {
    const kv = new SharedFrontProxyKv();
    const issuer = new CredentialIssuer("front-proxy-turn-test-secret", kv);
    const backend = createBackend("backend-1", issuer);
    const credentials = issuer.issue("backend-1");
    const context = createContext();
    const clientTransportKey = computeClientTransportKey(context);
    const firstSink = new RecordingSink();
    const secondSink = new RecordingSink();

    try {
      backend.attachRelay(clientTransportKey, firstSink);

      // Act: 初回 Allocate で backend TURN が virtual transport に NONCE を返す。
      await backend.handleFrame(
        {
          clientTransportKey,
          payload: makeAllocateRequest().bytes,
        },
        context,
      );
      const unauthorized = readFirstTurnMessage(firstSink);

      // Act: 認証済み Allocate で同じ clientTransportKey の allocation を作る。
      await backend.handleFrame(
        {
          clientTransportKey,
          payload: authenticateTurnRequest(
            makeAllocateRequest(),
            unauthorized.getAttributeValue("NONCE"),
            credentials,
          ).bytes,
        },
        context,
      );
      const [, allocateResponse] = readTurnMessages(firstSink.chunks);
      expect(allocateResponse.messageMethod).toBe(methods.ALLOCATE);

      backend.attachRelay(clientTransportKey, secondSink);

      // Act: relay が変わった後の Refresh は同じ virtual transport に入り、応答は現在の relay へ返る。
      await backend.handleFrame(
        {
          clientTransportKey,
          payload: authenticateTurnRequest(
            requestWithUsername(methods.REFRESH, credentials.username),
            unauthorized.getAttributeValue("NONCE"),
            credentials,
          ).bytes,
        },
        context,
      );
      const refreshResponse = readFirstTurnMessage(secondSink);

      // Assert: allocation を作り直さず、再 attach 後の sink で Refresh response を受け取る。
      expect(refreshResponse.messageMethod).toBe(methods.REFRESH);
      expect(secondSink.chunks.length).toBe(1);
    } finally {
      await backend.close();
    }
  });
});
