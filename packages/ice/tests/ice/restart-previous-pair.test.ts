import { setTimeout } from "timers/promises";

import { collectDatagrams, createConnectedPair, inviteAccept } from "../utils";

describe("ICE restart previous selected pair", () => {
  test("相手が新 pair へ移るまで旧選択 pair の datagram を media 用に識別する", async () => {
    // Arrange: restart 前から a → b の media が流れている
    const { a, b } = await createConnectedPair();
    const received = collectDatagrams(b);
    const oldPair = a.nominated!;
    await a.send(Buffer.from("before-restart"));
    await setTimeout(100);

    try {
      // Act: answerer 側 (b) だけ先に restart し、a は旧選択 pair で送り続ける
      await b.restart();
      await a.send(Buffer.from("old-path"));
      await setTimeout(100);

      // Assert: 現世代の pair には属さないが、旧選択 pair 由来として識別される
      const onOldPath = received.find(
        (ctx) => ctx.bytes.toString() === "old-path",
      );
      expect(onOldPath?.pair).toBeUndefined();
      expect(onOldPath?.authenticated).toBe(false);
      expect(onOldPath?.generation).toBe(b.generation);
      expect(onOldPath?.fromPreviousSelectedPair).toBe(true);

      // Act: a も restart して新 credentials で再接続し、新 pair で送信する
      await a.restart();
      await inviteAccept(a, b);
      await Promise.all([a.connect(), b.connect()]);
      await a.send(Buffer.from("new-path"));
      await setTimeout(100);

      // Assert: 新世代 pair 経由の datagram は通常の認証済み経路として届く
      const onNewPath = received.find(
        (ctx) => ctx.bytes.toString() === "new-path",
      );
      expect(onNewPath?.pair).toBeDefined();
      expect(onNewPath?.authenticated).toBe(true);
      expect(onNewPath?.generation).toBe(b.generation);
      expect(onNewPath?.fromPreviousSelectedPair).toBe(false);

      // Act: 相手が新 pair へ移った後に旧経路から届いた datagram
      await oldPair.protocol.sendData(
        Buffer.from("stale-path"),
        oldPair.remoteAddr,
      );
      await setTimeout(100);

      // Assert: 旧選択 pair は解放済みで、もう media 用に識別されない
      const onStalePath = received.find(
        (ctx) => ctx.bytes.toString() === "stale-path",
      );
      expect(onStalePath).toBeDefined();
      expect(onStalePath?.fromPreviousSelectedPair).toBe(false);
    } finally {
      await a.close();
      await b.close();
    }
  }, 30_000);
});
