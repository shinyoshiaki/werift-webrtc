import { afterEach, describe, expect, it } from "vitest";

import { createTestConnection, inviteAccept } from "../utils";

/**
 * Real-timer integration: consent expiry → ICE restart with new credentials.
 * Kept separate from consent.test.ts so fake timers do not interfere.
 */
describe("ICE consent restart integration", () => {
  const connections: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(
      connections.splice(0).map((connection) => connection.close()),
    );
  });

  it(
    "consent 失効後に新 credentials の ICE restart で再接続・送信が復帰し旧 session は影響しない",
    async () => {
      // Arrange
      const a = createTestConnection(true);
      a.stunServer = undefined;
      const b = createTestConnection(false);
      b.stunServer = undefined;
      connections.push(a, b);

      await inviteAccept(a, b);
      await Promise.all([a.connect(), b.connect()]);
      expect(a.state).toBe("connected");
      expect(b.state).toBe("connected");

      const oldRemotePassword = a.remotePassword;
      const oldLocalUsername = a.localUsername;
      const oldSession = (a as any).consentSessionId as number;
      const oldGeneration = a.generation;

      // Act: consent 失効 → application data 遮断
      const packetsBeforeExpire = a.nominated?.packetsSent ?? 0;
      (a as any).stopConsentLifecycle();
      (a as any).setState("failed");
      expect(a.state).toBe("failed");
      expect((a as any).consentFresh).toBe(false);
      // failed 後は send しても counters / wire を進めない
      await a.send(Buffer.from("blocked"));
      expect(a.nominated?.packetsSent ?? 0).toBe(packetsBeforeExpire);

      // Act: ICE restart with new credentials
      await a.restart();
      await b.restart();
      expect(a.localUsername).not.toBe(oldLocalUsername);
      expect(a.generation).toBeGreaterThan(oldGeneration);

      await inviteAccept(a, b);
      expect(a.remotePassword).not.toBe(oldRemotePassword);

      await Promise.all([a.connect(), b.connect()]);
      expect(a.state).toBe("connected");
      expect((a as any).consentFresh).toBe(true);
      expect((a as any).consentSessionId).toBeGreaterThan(oldSession);

      // Assert: 新接続で双方向に送れる
      const recvB = new Promise<string>((resolve) => {
        b.onData.once((buf) => resolve(buf.toString()));
      });
      await a.send(Buffer.from("after-restart"));
      expect(await recvB).toBe("after-restart");

      const recvA = new Promise<string>((resolve) => {
        a.onData.once((buf) => resolve(buf.toString()));
      });
      await b.send(Buffer.from("from-b"));
      expect(await recvA).toBe("from-b");
    },
    15_000,
  );
});
