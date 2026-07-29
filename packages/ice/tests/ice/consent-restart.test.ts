import { afterEach, describe, expect, it } from "vitest";

import { CONSENT_TIMEOUT } from "../../src/iceBase";
import { createTestConnection, inviteAccept } from "../utils";

/**
 * Real-timer integration: production consent expiry → ICE restart with new
 * credentials. Kept separate from consent.test.ts so fake timers do not
 * interfere with dual-agent networking.
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
      // Arrange: host-only dual connection（外部 STUN 不要）
      const a = createTestConnection(true);
      a.stunServer = undefined;
      const b = createTestConnection(false);
      b.stunServer = undefined;
      connections.push(a, b);

      await inviteAccept(a, b);
      await Promise.all([a.connect(), b.connect()]);
      expect(a.state).toBe("connected");
      expect(b.state).toBe("connected");
      expect((a as any).consentFresh).toBe(true);

      const oldRemotePassword = a.remotePassword;
      const oldLocalUsername = a.localUsername;
      const oldLocalPassword = a.localPassword;
      const oldSession = (a as any).consentSessionId as number;
      const oldGeneration = a.generation;
      const packetsBeforeExpire = a.nominated?.packetsSent ?? 0;

      // Act: consent 応答が認証できなくなるように remote password を壊す。
      // 以降の consent request は有効応答を得られず、最後の有効応答から
      // CONSENT_TIMEOUT 秒で production expiry timer が failed にする。
      a.remotePassword = "invalid-for-consent-expiry";

      const failed = new Promise<void>((resolve) => {
        const { unSubscribe } = a.stateChanged.subscribe((state) => {
          if (state === "failed") {
            unSubscribe();
            resolve();
          }
        });
        if (a.state === "failed") {
          unSubscribe();
          resolve();
        }
      });

      await Promise.race([
        failed,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `consent did not expire within ${CONSENT_TIMEOUT + 5}s (state=${a.state})`,
                ),
              ),
            (CONSENT_TIMEOUT + 5) * 1000,
          ),
        ),
      ]);

      // Assert: production expiry 経路（合成 setState ではない）
      expect(a.state).toBe("failed");
      expect((a as any).consentFresh).toBe(false);
      expect((a as any).consentSessionId).toBeGreaterThan(oldSession);

      // Act: 失効後は application data を送らない
      await a.send(Buffer.from("blocked"));
      expect(a.nominated?.packetsSent ?? 0).toBe(packetsBeforeExpire);

      // Act: 失効後に届いた「旧 credentials 相当」の遅延成功でも復帰しない
      // （session が既に進んでいるため consentFresh は false のまま）
      const sessionAfterExpire = (a as any).consentSessionId as number;
      (a as any).consentFresh = false;
      // 旧 remotePassword に戻しても、failed のままでは queryConsent は走らない
      a.remotePassword = oldRemotePassword;
      await new Promise((r) => setTimeout(r, 50));
      expect(a.state).toBe("failed");
      expect((a as any).consentFresh).toBe(false);
      expect((a as any).consentSessionId).toBe(sessionAfterExpire);

      // Act: 両端 ICE restart → 新 credentials で再交換・再接続
      await a.restart();
      await b.restart();
      expect(a.localUsername).not.toBe(oldLocalUsername);
      expect(a.localPassword).not.toBe(oldLocalPassword);
      expect(a.generation).toBeGreaterThan(oldGeneration);

      await inviteAccept(a, b);
      expect(a.remotePassword).not.toBe(oldRemotePassword);
      expect(a.remotePassword).not.toBe("invalid-for-consent-expiry");

      await Promise.all([a.connect(), b.connect()]);
      expect(a.state).toBe("connected");
      expect((a as any).consentFresh).toBe(true);
      expect((a as any).consentSessionId).toBeGreaterThan(sessionAfterExpire);

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

      // Assert: 旧 local credentials は新 session で使われない
      expect(a.localUsername).not.toBe(oldLocalUsername);
      expect(a.generation).toBeGreaterThan(oldGeneration);
      expect((a as any).consentSessionId).toBeGreaterThan(oldSession);
    },
    (CONSENT_TIMEOUT + 25) * 1000,
  );
});
