import { setTimeout } from "timers/promises";

import { Candidate } from "../../src";
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
  test("同じアドレスの新世代 pair が未認証のうちは旧選択 pair の datagram を識別し続ける", async () => {
    // Arrange: restart 前に a → b の media 経路 (b から見た 5-tuple) を確定させる
    const { a, b } = await createConnectedPair();
    const received = collectDatagrams(b);
    await a.send(Buffer.from("before-restart"));
    await setTimeout(100);
    const before = received.find(
      (ctx) => ctx.bytes.toString() === "before-restart",
    )!;
    const [oldHost, oldPort] = before.source;

    try {
      await b.restart();

      // Act: 相手 (a) の同一アドレス候補を新世代として登録し、未認証 pair を作る
      b.setRemoteParams({
        iceLite: false,
        usernameFragment: "next",
        password: "next-generation-password-0",
      });
      await b.addRemoteCandidate(
        Candidate.fromSdp(
          `next 1 udp 2116026367 ${oldHost} ${oldPort} typ host generation 1`,
        ),
      );
      const pendingPair = b.checkList.find(
        (pair) =>
          pair.protocol === before.protocol &&
          pair.remoteAddr[0] === oldHost &&
          pair.remoteAddr[1] === oldPort,
      );

      // Assert: 新世代の pair は登録済みだが、まだ認証されていない
      expect(pendingPair).toBeDefined();

      // Act: a は restart 前の選択 pair のまま送信を続ける
      await a.send(Buffer.from("old-path-with-pending-pair"));
      await setTimeout(100);

      // Assert: 未認証 pair に解決されても、旧選択 pair 由来として識別される
      const onOldPath = received.find(
        (ctx) => ctx.bytes.toString() === "old-path-with-pending-pair",
      );
      expect(onOldPath?.pair).toBe(pendingPair);
      expect(onOldPath?.authenticated).toBe(false);
      expect(onOldPath?.fromPreviousSelectedPair).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  }, 30_000);
});
