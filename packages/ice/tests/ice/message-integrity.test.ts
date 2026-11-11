import { afterEach, describe, expect, test } from "vitest";

import type { Connection } from "../../src/ice";
import {
  connectTcpOnly,
  createConnectedPair,
  createConnectedRelayOnlyPair,
  integrityOptions,
  sendSignedCheck,
} from "../utils";

/**
 * RFC 8489 MESSAGE-INTEGRITY-SHA256 with ICE short-term credentials:
 * responses match the request's algorithm (§9.1.3), requests use the
 * algorithm IceOptions.messageIntegrity selects (SHA-1 by default), and
 * SHA-256-only responses are accepted on every protocol.
 */
describe("ICE MESSAGE-INTEGRITY-SHA256", () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });
  const track = (...connections: Connection[]) =>
    cleanups.push(() => Promise.all(connections.map((c) => c.close())));

  test("MI-SHA256 付き Binding Request への成功応答は MI-SHA256 で署名される", async () => {
    // Arrange
    const { a, b } = await createConnectedPair();
    track(a, b);

    // Act: SHA-256 だけ、両方、SHA-1 だけで署名したチェックを送る
    const sha256 = await sendSignedCheck(a, b, {
      integrityAlgorithm: "sha256",
    });
    const both = await sendSignedCheck(a, b, { integrityAlgorithm: "both" });
    const sha1 = await sendSignedCheck(a, b, { integrityAlgorithm: "sha1" });

    // Assert: MI-SHA256 を含むリクエストには MI-SHA256 だけ、MI だけのリクエスト
    // には MI だけで応答する
    expect(sha256.attributesKeys).toContain("MESSAGE-INTEGRITY-SHA256");
    expect(sha256.attributesKeys).not.toContain("MESSAGE-INTEGRITY");
    expect(both.integrityAlgorithm).toBe("sha256");
    expect(both.attributesKeys).not.toContain("MESSAGE-INTEGRITY");
    expect(sha1.attributesKeys).toContain("MESSAGE-INTEGRITY");
    expect(sha1.attributesKeys).not.toContain("MESSAGE-INTEGRITY-SHA256");
  });

  test("MI-SHA256 付き Binding Request へのエラー応答（487）も MI-SHA256 で署名される", async () => {
    // Arrange
    const { a, b } = await createConnectedPair();
    track(a, b);

    // Act: 制御側 b に役割衝突を起こすチェックを SHA-256 と SHA-1 で送る
    const sha256 = await sendSignedCheck(a, b, {
      integrityAlgorithm: "sha256",
      roleConflict: true,
    });
    const sha1 = await sendSignedCheck(a, b, {
      integrityAlgorithm: "sha1",
      roleConflict: true,
    });

    // Assert: どちらも 487 で、リクエストと同じアルゴリズムで署名されている
    expect(sha256.getAttributeValue("ERROR-CODE")?.[0]).toBe(487);
    expect(sha256.integrityAlgorithm).toBe("sha256");
    expect(sha1.getAttributeValue("ERROR-CODE")?.[0]).toBe(487);
    expect(sha1.integrityAlgorithm).toBe("sha1");
  });

  test("既定では接続確認リクエストは MESSAGE-INTEGRITY（SHA-1）だけで送られる", async () => {
    // Arrange
    const recordA = integrityOptions();
    const recordB = integrityOptions();

    // Act: 既定設定どうしで接続する
    const { a, b } = await createConnectedPair(
      recordA.options,
      recordB.options,
    );
    track(a, b);

    // Assert: 双方が受け取ったチェックはすべて SHA-1 だけで署名されている
    expect(a.nominated).toBeDefined();
    expect(recordA.received.length + recordB.received.length).toBeGreaterThan(
      0,
    );
    expect(new Set([...recordA.received, ...recordB.received])).toEqual(
      new Set(["sha1"]),
    );
  });

  test.each(["sha256", "both"] as const)(
    "messageIntegrity=%s の 2 つの Connection が UDP で接続できる",
    async (mode) => {
      // Arrange
      const recordA = integrityOptions(mode);
      const recordB = integrityOptions(mode);

      // Act: 双方が MI-SHA256 付きのチェックを送って接続する
      const { a, b } = await createConnectedPair(
        recordA.options,
        recordB.options,
      );
      track(a, b);

      // Assert: 接続が確立し、受け取ったチェックは MI-SHA256 付き
      // （= SHA-256 だけの応答を StunProtocol が受理している）
      expect(a.nominated).toBeDefined();
      expect(b.nominated).toBeDefined();
      expect(new Set([...recordA.received, ...recordB.received])).toEqual(
        new Set(["sha256"]),
      );
    },
  );

  test("片側だけ sha256 でも、応答は各リクエストのアルゴリズムに合わせて接続できる", async () => {
    // Arrange
    const recordA = integrityOptions("sha256");
    const recordB = integrityOptions();

    // Act: a は SHA-256、b は既定（SHA-1）で接続する
    const { a, b } = await createConnectedPair(
      recordA.options,
      recordB.options,
    );
    track(a, b);

    // Assert: 接続でき、b は SHA-256、a は SHA-1 のチェックを受け取っている
    expect(a.nominated).toBeDefined();
    expect(b.nominated).toBeDefined();
    expect(new Set(recordB.received)).toEqual(new Set(["sha256"]));
    expect(new Set(recordA.received)).toEqual(new Set(["sha1"]));
  });

  test("messageIntegrity=sha256 の TCP のみの Connection が接続できる", async () => {
    // Arrange
    const record = integrityOptions("sha256");

    // Act: TCP 候補だけで接続する
    const { a, b } = await connectTcpOnly(record.options);
    track(a, b);

    // Assert: StunOverTcpProtocol（TCP フレーミング）経由で SHA-256 だけの応答を受理して接続する
    expect(a.nominated?.localCandidate.transport.toLowerCase()).toBe("tcp");
    expect(b.nominated).toBeDefined();
    expect(new Set(record.received)).toEqual(new Set(["sha256"]));
  });

  test("messageIntegrity=sha256 の relay のみの Connection が TURN 経由で接続できる", async () => {
    // Arrange
    const recordA = integrityOptions("sha256");
    const recordB = integrityOptions("sha256");

    // Act: TURN relay 候補だけで接続する
    const { a, b, close } = await createConnectedRelayOnlyPair(
      recordA.options,
      recordB.options,
    );
    cleanups.push(close);

    // Assert: StunOverTurnProtocol 経由で SHA-256 だけの応答を受理して接続する
    expect(a.nominated?.localCandidate.type).toBe("relay");
    expect(b.nominated?.localCandidate.type).toBe("relay");
    expect(new Set([...recordA.received, ...recordB.received])).toEqual(
      new Set(["sha256"]),
    );
  });
});
