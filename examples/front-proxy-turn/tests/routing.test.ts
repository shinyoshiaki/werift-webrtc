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

  test("keeps unauthenticated Allocate on the same backend until credentials are attached", () => {
    const { issuer, relay, kv, backends } = createRelayHarness(() => 0);
    const context = createContext();
    const key = computeClientTransportKey(context);
    const credentials = issuer.issue("backend-2");

    // Act: 初回の認証なし Allocate は USERNAME がないため clientTransportKey に backend を仮保存する。
    const firstBackend = relay.resolveBackendForFrame(
      makeAllocateRequest().bytes,
      key,
    );
    const retryBackend = relay.resolveBackendForFrame(
      makeAllocateRequest().setAttribute("USERNAME", credentials.username)
        .bytes,
      key,
    );

    // Assert: NONCE を発行した backend に認証付き retry も届き、TURN 認証が崩れない。
    expect(firstBackend).toBe(backends[0]);
    expect(retryBackend).toBe(backends[0]);
    expect(kv.getClientTransportBackend(key)).toBe("backend-1");
    expect(kv.getUsernameBackend(credentials.username)).toBe("backend-1");
  });
});
