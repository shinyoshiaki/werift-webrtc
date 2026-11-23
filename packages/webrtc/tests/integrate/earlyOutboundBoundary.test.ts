import { setTimeout } from "timers/promises";

import { awaitMessage } from "../utils";
import { prepareHeldServerDataChannel } from "./warpArrange";

describe("early server outbound の opt-in 境界 (DataChannel)", () => {
  test("early outbound 無効では、DTLS server は writeReady から fingerprint 認証まで SCTP / DataChannel を送らず、認証後に通常送信する", async () => {
    // Arrange: 認証を保留した DTLS server (early outbound 無効) と DataChannel
    const held = await prepareHeldServerDataChannel(false);
    try {
      // Act: answer を適用して server を writeReady まで進め、保留したまま待つ
      await held.applyAnswerUntilWriteReady();
      await setTimeout(1_000);

      // Assert: writeReady だが未認証の間、application record は 1 件も送られない
      expect(held.readiness()).toEqual(
        expect.objectContaining({ writeReady: true, peerAuthenticated: false }),
      );
      expect(held.transport.state).toBe("connecting");
      expect(held.sends).toHaveLength(0);
      expect(held.clientChannelOpened()).toBe(false);

      // Act: 認証を解放し、DataChannel で双方向に送る
      held.release();
      const remote = await held.clientChannel;
      if (held.serverChannel.readyState !== "open") {
        await new Promise<void>((resolve) => {
          held.serverChannel.onopen = () => resolve();
        });
      }
      held.serverChannel.send("after-auth");
      const toClient = await awaitMessage(remote);
      remote.send("reply");
      const toServer = await awaitMessage(held.serverChannel);

      // Assert: 認証後に通常送信され、送った record はすべて認証後のもの
      expect(toClient).toBe("after-auth");
      expect(toServer).toBe("reply");
      expect(held.sends.length).toBeGreaterThan(0);
      expect(held.sends.every((s) => s.peerAuthenticated)).toBe(true);
    } finally {
      held.release();
      await Promise.allSettled([held.server.close(), held.client.close()]);
    }
  }, 30_000);

  test("比較: early outbound 有効では、同じ保留中に DTLS server が SCTP を送り始める", async () => {
    // Arrange: 認証を保留した DTLS server (early outbound 有効) と DataChannel
    const held = await prepareHeldServerDataChannel(true);
    try {
      // Act: answer を適用して server を writeReady まで進め、保留したまま送信を待つ
      await held.applyAnswerUntilWriteReady();
      const deadline = Date.now() + 5_000;
      while (held.sends.length === 0 && Date.now() < deadline) {
        await setTimeout(20);
      }

      // Assert: 未認証のまま application record (SCTP INIT) が送られる
      expect(held.readiness().peerAuthenticated).toBe(false);
      expect(held.sends.length).toBeGreaterThan(0);
      expect(held.sends[0]).toEqual(
        expect.objectContaining({ writeReady: true, peerAuthenticated: false }),
      );
      // Assert: 受信側は fingerprint 認証前に DataChannel を公開しない
      expect(held.clientChannelOpened()).toBe(false);
    } finally {
      held.release();
      await Promise.allSettled([held.server.close(), held.client.close()]);
    }
  }, 30_000);
});
