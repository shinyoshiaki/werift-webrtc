import { describe, expect, test } from "vitest";

import { methods } from "../../../packages/ice-server/src";
import { computeClientTransportKey } from "../src/types";
import {
  channelData,
  createContext,
  createRelayHarness,
  makeAllocateRequest,
  requestWithUsername,
  sendIndication,
} from "./fixture";

describe("front-proxy-turn routing", () => {
  test("builds clientTransportKey from the original source and public TURN address", () => {
    const context = createContext();

    // Act: LB から渡された original source と公開 TURN address だけで内部キーを作る。
    const key = computeClientTransportKey(context);

    // Assert: relay のローカル socket ではなく仮想 5-tuple 相当の値になっていることを確認する。
    expect(key).toBe("203.0.113.10:53124|34.120.1.10:443|tcp");
  });

  test("routes username based requests and username-less data through the shared KV", () => {
    const { issuer, relay, kv, backends } = createRelayHarness();
    const context = createContext();
    const key = computeClientTransportKey(context);
    const credentials = issuer.issue("backend-2");

    // Act: 認証済み Allocate は USERNAME から backend を解決し、clientTransportKey の対応も保存する。
    const allocateBackend = relay.resolveBackendForFrame(
      makeAllocateRequest().setAttribute("USERNAME", credentials.username)
        .bytes,
      key,
      context,
    );

    // Assert: HTTP credentials 発行時に保存した username route が Allocate に使われる。
    expect(allocateBackend).toBe(backends[1]);
    expect(kv.getClientTransportBackend(key)).toBe("backend-2");

    // Act: Refresh/CreatePermission/ChannelBind は USERNAME を読んで同じ backend に向ける。
    const refreshBackend = relay.resolveBackendForFrame(
      requestWithUsername(methods.REFRESH, credentials.username).bytes,
      key,
    );
    const permissionBackend = relay.resolveBackendForFrame(
      requestWithUsername(methods.CREATE_PERMISSION, credentials.username)
        .bytes,
      key,
    );
    const channelBindBackend = relay.resolveBackendForFrame(
      requestWithUsername(methods.CHANNEL_BIND, credentials.username).bytes,
      key,
    );

    // Assert: 認証可能な transaction は username -> backend の KV で安定して route される。
    expect(refreshBackend).toBe(backends[1]);
    expect(permissionBackend).toBe(backends[1]);
    expect(channelBindBackend).toBe(backends[1]);

    // Act: Send indication と ChannelData は USERNAME を持たないため clientTransportKey で route する。
    const sendBackend = relay.resolveBackendForFrame(
      sendIndication().bytes,
      key,
    );
    const channelDataBackend = relay.resolveBackendForFrame(channelData(), key);

    // Assert: username-less data も Allocate で保存した backend に届く。
    expect(sendBackend).toBe(backends[1]);
    expect(channelDataBackend).toBe(backends[1]);
  });

  test("keeps USERNAME authoritative for authenticated Allocate even when transport state is stale", () => {
    const { issuer, relay, kv, backends } = createRelayHarness(() => 0);
    const context = createContext();
    const key = computeClientTransportKey(context);
    const credentials = issuer.issue("backend-2");
    kv.setClientTransportBackend(key, "backend-1");

    // Act: 認証済み Allocate は既存 transport route より USERNAME backend を優先する。
    const allocateBackend = relay.resolveBackendForFrame(
      makeAllocateRequest().setAttribute("USERNAME", credentials.username)
        .bytes,
      key,
      context,
    );

    // Assert: USERNAME backend が authoritative になり、clientTransportKey route もその結果へ更新される。
    expect(allocateBackend).toBe(backends[1]);
    expect(kv.getClientTransportBackend(key)).toBe("backend-2");
    expect(kv.getUsernameBackend(credentials.username)).toBe("backend-2");
  });

  test("pins unauthenticated Allocate to the same backend selected for credentials by client-IP affinity", () => {
    const { issuer, relay, kv, backends } = createRelayHarness(() => 0);
    const context = createContext();
    const key = computeClientTransportKey(context);
    const credentials = issuer.issue("backend-2");

    // Act: 初回の認証なし Allocate は client-IP affinity で backend を決め、NONCE の行き先を安定させる。
    const firstBackend = relay.resolveBackendForFrame(
      makeAllocateRequest().bytes,
      key,
      context,
    );
    const retryBackend = relay.resolveBackendForFrame(
      makeAllocateRequest().setAttribute("USERNAME", credentials.username)
        .bytes,
      key,
      context,
    );

    // Assert: credentials 発行 backend と同じ backend に unauthenticated / authenticated Allocate が届く。
    expect(firstBackend).toBe(backends[1]);
    expect(retryBackend).toBe(backends[1]);
    expect(kv.getClientTransportBackend(key)).toBe("backend-2");
    expect(kv.getUsernameBackend(credentials.username)).toBe("backend-2");
  });
});
