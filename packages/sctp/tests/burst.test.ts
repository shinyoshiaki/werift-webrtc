import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";

import { WEBRTC_PPID } from "../src";
import { DataChunk } from "../src/chunk";
import {
  collectMessages,
  createConnectedSctpPair,
  createLossyPrSctpPair,
  createMessages,
  createSeededRandom,
  dropDataPacketsAt,
  flushImmediates,
  observeCongestionControl,
  propertySeeds,
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

  test("transfer processing cost grows close to linearly with the queued message count", async () => {
    // Arrange: Vitest の変換・計測 overhead を含めず、Node.js 本来の実行経路で測る。
    const benchmarkPath = resolve(process.cwd(), "tests/burst-benchmark.mjs");
    const nodeTsRegister = resolve(
      process.cwd(),
      "../../tools/node-ts/register.mjs",
    );
    const execFileAsync = promisify(execFile);

    // Act: 独立した Node.js process で N / 4N の CPU 時間比を計測する。
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", nodeTsRegister, benchmarkPath],
      { cwd: process.cwd(), timeout: 25_000 },
    );
    const { medianRatio } = JSON.parse(stdout.trim()) as {
      medianRatio: number;
    };
    const ratio = medianRatio;

    // Assert: 二次なら 16 倍になるところ、線形に近い比 (8 倍未満) に収まる。
    expect(ratio).toBeLessThan(8);
  }, 30_000);

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

describe("sctp congestion control under bursts of mostly small messages and random loss (property)", () => {
  // 修正前は、1 バイトの DATA をペイロードだけで数えて cwnd の何百倍も送り、
  // 欠落した 1 チャンクを SACK 3 回ごとに何度も Fast Retransmit していた (memleak datachannel)。
  const { seeds, seedSelected, replay } = propertySeeds(
    "WERIFT_SCTP_CONGESTION",
    { seeds: 40 },
  );
  /** How often the seeds exercised recovery; an oracle never triggered proves nothing. */
  const coverage = { fastRetransmits: 0, t3: 0, newData: 0 };

  test.each(seeds.map((seed) => [seed, replay(seed)] as const))(
    "keeps cwnd at wire size, fast-retransmits a chunk once per T3 round and delivers everything in order (seed %i, replay: %s)",
    async (seed, label) => {
      // Arrange: シード付き乱数で、DATA と SACK を落とすペアと、大半が小さいメッセージの列。
      const random = createSeededRandom(seed);
      const pair = await createLossyPrSctpPair();
      const dataLoss = random() * 0.05;
      const sackLoss = random() * 0.05;
      pair.recorder.dropIf = (chunks) =>
        chunks.some((c) => c instanceof DataChunk) && random() < dataLoss;
      pair.serverRecorder.dropIf = () => random() < sackLoss;
      const count = 100 + Math.floor(random() * 1100);
      const messages = Array.from({ length: count }, (_, id) => {
        const r = random();
        const size =
          r < 0.7
            ? 4 + Math.floor(random() * 29)
            : r < 0.95
              ? 33 + Math.floor(random() * 1200)
              : 1201 + Math.floor(random() * 3000);
        const data = Buffer.alloc(size, id % 251);
        data.writeUInt32BE(id, 0);
        return data;
      });
      const oracle = observeCongestionControl(pair.client);
      const { received, done } = collectMessages(pair.server, count);

      try {
        // Act: 全件を一度に送り、全件が届くまで時間を進める (T3 も発火させる)。
        for (const message of messages) void pair.client.send(0, 53, message);
        for (let i = 0; i < 400 && received.length < count; i++) {
          await flushImmediates(5);
          await vi.advanceTimersByTimeAsync(Math.floor(random() * 400));
        }
        await Promise.race([done, flushImmediates()]);

        coverage.fastRetransmits += oracle.counts.fastRetransmits;
        coverage.t3 += oracle.counts.t3;
        coverage.newData += oracle.counts.newData;
        // Assert: 新しい DATA はヘッダ込みの大きさで数えた送信中のデータが cwnd 未満のときだけ送られ、
        // 同じチャンクの Fast Retransmit は T3 の周回ごとに 1 回まで。
        expect(oracle.violations, label).toEqual([]);
        // Assert: 全件が内容も順序も壊れずに届く。
        expect(received.length, label).toBe(count);
        received.forEach((data, i) =>
          expect(data.equals(messages[i]), label).toBe(true),
        );
      } finally {
        await pair.stop();
      }
    },
    60_000,
  );

  test.skipIf(seedSelected)(
    "the seeds exercise Fast Retransmit and the T3-rtx timer (coverage of the oracle)",
    () => {
      // Assert: 既定の seed 全体で、Fast Retransmit と T3 の再送が実際に起きている。
      expect(
        coverage.fastRetransmits,
        JSON.stringify(coverage),
      ).toBeGreaterThan(0);
      expect(coverage.t3, JSON.stringify(coverage)).toBeGreaterThan(0);
    },
  );
});
