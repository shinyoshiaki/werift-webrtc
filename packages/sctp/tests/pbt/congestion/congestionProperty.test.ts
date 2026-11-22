import { describe, expect, test, vi } from "vitest";

import {
  propertyOptions,
  propertySeeds,
  seededRandom,
} from "../../../../pbt/src";
import { DataChunk } from "../../../src/chunk";
import {
  collectMessages,
  createLossyPrSctpPair,
  flushImmediates,
  observeCongestionControl,
} from "../../utils";

/**
 * Congestion control property (RFC 9260 §6.1, §7.2.4): for bursts of mostly
 * small messages with random DATA / SACK loss, new data goes out only while
 * the DATA in flight, counted at its wire size, is below cwnd; a chunk is
 * fast-retransmitted at most once per T3-rtx round; everything arrives in
 * order. A coverage check makes sure the seeds exercise Fast Retransmit and
 * T3.
 *
 * CI runs `WERIFT_SCTP_CONGESTION_SEEDS` (default 40) seeds from
 * `WERIFT_SCTP_CONGESTION_SEED` (default 1). A failing title prints the
 * replay environment.
 */
describe(
  "sctp congestion control under bursts of mostly small messages and random loss (property)",
  propertyOptions(),
  () => {
    // 修正前は、1 バイトの DATA をペイロードだけで数えて cwnd の何百倍も送り、
    // 欠落した 1 チャンクを SACK 3 回ごとに何度も Fast Retransmit していた (memleak datachannel)。
    const { seeds, cases, seedSelected, replay, title } = propertySeeds(
      "WERIFT_SCTP_CONGESTION",
      { seeds: 40 },
    );
    /** How often the seeds exercised recovery; an oracle never triggered proves nothing. */
    const coverage = { fastRetransmits: 0, t3: 0, newData: 0 };

    test.each(cases)(
      title(
        "keeps cwnd at wire size, fast-retransmits a chunk once per T3 round and delivers everything in order",
      ),
      async ({ seed }) => {
        const label = replay(seed);
        // Arrange: シード付き乱数で、DATA と SACK を落とすペアと、大半が小さいメッセージの列。
        const random = seededRandom(seed).next;
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
  },
);
