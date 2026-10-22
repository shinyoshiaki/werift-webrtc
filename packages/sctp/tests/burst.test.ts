import { describe, expect, test } from "vitest";

import { WEBRTC_PPID } from "../src";
import {
  collectMessages,
  createConnectedSctpPair,
  createMessages,
  dropDataPacketsAt,
  measureBurstTransfer,
  runBurstTransfer,
} from "./utils";

describe("sctp burst transfer", () => {
  test("delivers a large burst with fragmented messages completely and in order", async () => {
    // Arrange
    const pair = await createConnectedSctpPair();
    // maxPayloadSize (~1200 byte) を超えるので各メッセージが複数 fragment になる
    const messages = createMessages(2_000, 3_000);

    // Act: 全メッセージを一括でキューに積み、SACK を繰り返して受信完了を待つ
    const { received } = await runBurstTransfer(
      pair.client,
      pair.server,
      messages,
    );

    // Assert: 全件が送信順のまま欠落・破損なく届き、送信キューも空になる
    expect(received.length).toBe(messages.length);
    received.forEach((data, i) => expect(data.equals(messages[i])).toBe(true));
    expect(pair.client.outboundQueue.length).toBe(0);

    await pair.stop();
  });

  test("transfer time grows close to linearly with the queued message count", async () => {
    // Arrange: JIT のウォームアップ
    await measureBurstTransfer(1_000, 1_000);

    // Act: N と 4N のバースト転送時間を計測する
    const small = await measureBurstTransfer(2_000, 1_000);
    const large = await measureBurstTransfer(8_000, 1_000);

    // Assert: 二次なら 16 倍になるところ、線形に近い比 (8 倍未満) に収まる
    expect(large.elapsedMs / Math.max(small.elapsedMs, 1)).toBeLessThan(8);
  });

  test("event loop heartbeat keeps running during a large burst", async () => {
    // Arrange
    const pair = await createConnectedSctpPair();
    const messages = createMessages(10_000, 1_000);

    // Act: 大量メッセージを転送しながら setInterval 心拍の遅延を計測する
    const { received, maxLagMs } = await runBurstTransfer(
      pair.client,
      pair.server,
      messages,
    );

    // Assert: 全件届き、心拍の最大遅延が ICE consent 応答タイムアウト (1000ms) より十分小さい
    expect(received.length).toBe(messages.length);
    expect(maxLagMs).toBeLessThan(500);

    await pair.stop();
  });

  test("keeps completion and order when DATA packets are lost (gap ACK / fast retransmit)", async () => {
    // Arrange: クライアントが送る DATA パケットの一部を破棄する transport
    const pair = await createConnectedSctpPair({
      dropClient: dropDataPacketsAt([100, 101, 400, 1_000]),
    });
    const messages = createMessages(3_000, 1_000);

    // Act: 損失を挟みながら一括送信する
    const { received } = await runBurstTransfer(
      pair.client,
      pair.server,
      messages,
    );

    // Assert: 実際に破棄が起きた上で、全件が順序通りに届く
    expect(pair.transports.client.droppedPackets).toBe(4);
    expect(received.length).toBe(messages.length);
    received.forEach((data, i) => expect(data.equals(messages[i])).toBe(true));

    await pair.stop();
  });

  test("send resolves when its own chunks are transmitted, not when the whole queue drains", async () => {
    // Arrange
    const pair = await createConnectedSctpPair();
    const messages = createMessages(2_000, 1_000);
    const { done } = collectMessages(pair.server, messages.length);

    // Act: 一括で積み、先頭メッセージの send 完了だけを待つ
    const sends = messages.map((m) =>
      pair.client.send(0, WEBRTC_PPID.BINARY, m),
    );
    await sends[0];

    // Assert: 先頭の完了時点では後続がまだキューに残っている (キュー全体の排出を待っていない)
    expect(pair.client.outboundQueue.length).toBeGreaterThan(0);

    // Act: 残りの完了を待つ
    await Promise.all(sends);
    await done;

    // Assert: 最後にはキューが空になる
    expect(pair.client.outboundQueue.length).toBe(0);

    await pair.stop();
  });

  test("pending send promises settle when the association is stopped", async () => {
    // Arrange: サーバへのパケットを全て破棄し、SACK が返らない状態にする
    const pair = await createConnectedSctpPair();
    pair.transports.client.close();
    const sends = createMessages(500, 1_000).map((m) =>
      pair.client.send(0, WEBRTC_PPID.BINARY, m),
    );
    let settled = 0;
    sends.forEach((p) => p.then(() => settled++));
    await new Promise((r) => setImmediate(r));

    // Act: 送信待ちが残ったまま停止する
    const pendingBeforeStop = pair.client.outboundQueue.length;
    await pair.stop();
    await Promise.all(sends);

    // Assert: 停止前は未送信が残っていたが、停止で全 send が解決される
    expect(pendingBeforeStop).toBeGreaterThan(0);
    expect(settled).toBe(sends.length);
  });
});
