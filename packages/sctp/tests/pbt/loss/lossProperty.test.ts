import { describe, expect, test, vi } from "vitest";

import {
  propertyOptions,
  propertySeeds,
  seededRandom,
} from "../../../../pbt/src";
import {
  createLossyPrSctpPair,
  findFlightSizeViolation,
  flushImmediates,
  outboundQueueOf,
  recordedForwardTsns,
} from "../../utils";

/**
 * PR-SCTP property: with DATA, SACK and FORWARD-TSN lost at random (20 %),
 * messages of several streams, sizes and lifetimes keep delivery (no
 * duplicate, order per ordered stream, every message without a lifetime),
 * lifetimes (`send()` settles by its expiry) and flightSize consistent, and
 * the sender drains completely. A coverage check makes sure the seeds
 * exercise abandonment and FORWARD-TSN.
 *
 * CI runs `WERIFT_SCTP_LOSS_SEEDS` (default 100) seeds from
 * `WERIFT_SCTP_LOSS_SEED` (default 1). A failing title prints the replay
 * environment.
 */
describe(
  "PR-SCTP under seeded random loss of DATA / SACK / FORWARD-TSN",
  propertyOptions(),
  () => {
    // Fixed seeds keep failures replayable; seeds 6, 37, 38 and 78 reproduced
    // reassembly / flightSize bugs before they were fixed.
    const { seeds, cases, seedSelected, replay, title } = propertySeeds(
      "WERIFT_SCTP_LOSS",
      {
        seeds: 100,
      },
    );
    const LOSS_RATE = 0.2;
    const STREAMS = 3;
    const SIZES = [16, 1_500, 4_000];
    /** How often the seeds exercised abandonment; a property that never abandons proves nothing about lifetimes. */
    const coverage = { abandonedMessages: 0, forwardTsns: 0 };

    test.each(cases)(
      title("keeps delivery, lifetimes and flightSize consistent"),
      async ({ seed }) => {
        // Arrange: シード付き乱数で両方向のパケットを落とすペアと、複数ストリーム・断片化・寿命有無を混ぜたメッセージ
        const pair = await createLossyPrSctpPair();
        try {
          const random = seededRandom(seed).next;
          pair.recorder.dropIf = () => random() < LOSS_RATE;
          pair.serverRecorder.dropIf = () => random() < LOSS_RATE;
          const messages = Array.from({ length: 12 }, (_, id) => {
            const data = Buffer.alloc(
              SIZES[Math.floor(random() * SIZES.length)],
              id,
            );
            data.writeUInt32BE(id, 0);
            return {
              id,
              streamId: Math.floor(random() * STREAMS),
              ordered: random() < 0.8,
              lifetime:
                random() < 0.5 ? 50 + Math.floor(random() * 2_000) : undefined,
              data,
              expiry: undefined as number | undefined,
              resolvedAt: undefined as number | undefined,
            };
          });
          const delivered: { streamId: number; data: Buffer }[] = [];
          pair.server.onReceive.subscribe((streamId, _ppId, data) => {
            delivered.push({ streamId, data });
          });
          const violations: string[] = [];
          const check = () => {
            const v = findFlightSizeViolation(pair.client);
            if (v) violations.push(v);
          };

          // Act: 損失ありで送信と時間経過を乱数で織り交ぜる
          for (const m of messages) {
            m.expiry =
              m.lifetime === undefined ? undefined : Date.now() + m.lifetime;
            void pair.client
              .send(m.streamId, 53, m.data, {
                ordered: m.ordered,
                expiry: m.expiry,
              })
              .then(() => {
                m.resolvedAt = Date.now();
              });
            await flushImmediates(3);
            check();
            await vi.advanceTimersByTimeAsync(Math.floor(random() * 800));
            await flushImmediates(3);
            check();
          }
          // Act: 損失を止め、送信側の全キューと FORWARD-TSN が片付くまで時間を進める
          pair.recorder.dropIf = undefined;
          pair.serverRecorder.dropIf = undefined;
          const client = pair.client as any;
          for (
            let i = 0;
            i < 60 &&
            (outboundQueueOf(client).length > 0 ||
              client.sentQueue.length > 0 ||
              client.forwardTsnChunk);
            i++
          ) {
            await vi.advanceTimersByTimeAsync(3_100);
            await flushImmediates();
            check();
          }

          // Assert: 送信側が停止せず全て片付き、flightSize の勘定が常に一致している
          expect(violations).toEqual([]);
          expect(messages.filter((m) => m.resolvedAt === undefined)).toEqual(
            [],
          );
          expect(outboundQueueOf(client).length).toBe(0);
          expect(client.sentQueue.length).toBe(0);
          expect(client.forwardTsnChunk).toBeUndefined();
          expect(client.flightSize).toBe(0);
          // Assert: 寿命付きメッセージの send() は、ほかのイベントを待たずに遅くとも寿命の時刻までに解決する
          const lateSends = messages
            .filter((m) => m.expiry !== undefined && m.resolvedAt! > m.expiry)
            .map((m) => ({
              id: m.id,
              expiry: m.expiry,
              resolvedAt: m.resolvedAt,
            }));
          expect(lateSends).toEqual([]);
          // Assert: 受信側に取り残された断片がなく、受信ウィンドウが初期値に戻る
          const server = pair.server as any;
          for (const stream of Object.values(server.inboundStreams) as any[]) {
            expect(stream.reassembly).toEqual([]);
          }
          expect(server.advertisedRwnd).toBe(1024 * 1024);
          // Assert: 二重配送も内容破損もなく、寿命なしのメッセージは必ず届く
          const ids = delivered.map((d) => d.data.readUInt32BE(0));
          expect(new Set(ids).size).toBe(ids.length);
          for (const d of delivered) {
            const m = messages[d.data.readUInt32BE(0)];
            expect(d.streamId).toBe(m.streamId);
            expect(d.data.equals(m.data)).toBe(true);
          }
          for (const m of messages.filter((m) => m.lifetime === undefined)) {
            expect(ids).toContain(m.id);
          }
          // Assert: 各ストリームの順序付きメッセージは送信順に届く
          for (let streamId = 0; streamId < STREAMS; streamId++) {
            const orderedIds = ids.filter((id) => {
              const m = messages[id];
              return m.streamId === streamId && m.ordered;
            });
            expect(orderedIds).toEqual([...orderedIds].sort((a, b) => a - b));
          }
          coverage.abandonedMessages += messages.filter(
            (m) => !ids.includes(m.id),
          ).length;
          coverage.forwardTsns += recordedForwardTsns(pair.recorder).length;
        } finally {
          await pair.stop();
        }
      },
    );

    test.skipIf(seedSelected)(
      "the seeds above exercise lifetime abandonment and FORWARD-TSN",
      () => {
        // Assert: 寿命破棄の経路が一度も通らない (寿命が効かない) と、上のプロパティは空振りでも成功してしまう
        expect(coverage.abandonedMessages).toBeGreaterThan(0);
        expect(coverage.forwardTsns).toBeGreaterThan(0);
      },
    );
  },
);
