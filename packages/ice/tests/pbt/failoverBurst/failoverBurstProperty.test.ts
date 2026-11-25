import { afterEach, describe, expect, test, vi } from "vitest";

import { propertyOptions, propertySeeds } from "../../../../pbt/src";
import { createFailoverHarness } from "../../utils";
import { drawFailoverBurstCase } from "./generator";

/**
 * Failover burst property (ticket 6b2d7627 §15 A / C): a cut of the selected
 * path of random length, under random thresholds (`IceOptions.failover`),
 * moves the selection only as the rules allow (`generator.ts` draws the
 * lengths around their boundaries):
 * - a two-way cut neither rule can act on (safe) never moves it; one the
 *   receiving rule decides on (live) moves it within its bound; the gray
 *   range between is not asserted;
 * - a one-way break (the peer's data still arrives) moves it only once the
 *   unwritable rule holds, within its bound;
 * - the agent never fails.
 *
 * CI runs `WERIFT_ICE_FAILOVER_BURST_SEEDS` (default 96) seeds from
 * `WERIFT_ICE_FAILOVER_BURST_SEED` (default 1). A failing title prints the
 * replay environment.
 */
describe(
  "§15 A / C property: a cut of random length under random thresholds",
  propertyOptions(),
  () => {
    // seed ごとに閾値・モード・断の向きと長さを引き、退避の安全側 (短い断では移らない) と
    // 活性側 (長い断では上限内に移る) の境界を調べる。その間の灰色の範囲は判定しない。
    const { seeds, cases, replay, title, seedSelected } = propertySeeds(
      "WERIFT_ICE_FAILOVER_BURST",
      {
        seeds: 96,
        steps: 1,
      },
    );
    /** The harness's consent response deadline (ms; its pairs have no RTT yet). */
    const DEADLINE = 1000;
    /** `advanceUntil` polls every 100 ms; `cutRightAfterAnswer` cuts within 100 ms of the answer. */
    const SLACK = 300;
    /**
     * What a two-way cut of `burstMs` must lead to. The checks during the cut:
     * the first once nothing arrived for `receivingTimeout`, then every 900 ms;
     * the silence lasts at most one weak interval past the cut. `safe`: neither
     * rule can hold (no check went unanswered, or the silence stays below
     * receiving + delay and the unwritable rule lacks its time or its checks),
     * so the selection must not move. `live`: the cut outlasts the receiving
     * rule's decision, so the selection moves within `liveBound` (the hold counts from the unanswered check).
     */
    const classifyBurst = (
      {
        receivingTimeout: rt,
        receivingSwitchingDelay: delay,
        unwritableMinChecks: minChecks,
        unwritableTimeout,
      }: ReturnType<typeof drawFailoverBurstCase>["thresholds"],
      burstMs: number,
    ) => {
      const unansweredMax =
        burstMs + 100 < rt ? 0 : Math.floor((burstMs + 100 - rt) / 900) + 1;
      const silenceMax = burstMs + 100 + 900 + 100;
      const safe =
        unansweredMax === 0 ||
        (silenceMax < rt + delay &&
          (silenceMax < unwritableTimeout || unansweredMax < minChecks));
      // 受信なしの保留は「無通信 rt」と「未応答の確定」が揃った時点から数える。
      // 最初の check は無通信が rt を超えてから最大 1 周期 (900 ms) 後に出て、
      // DEADLINE 後に未応答と確定し、そこから delay 後に移る。
      const liveBound = rt + 900 + DEADLINE + delay + SLACK;
      return { safe, live: burstMs >= liveBound, liveBound };
    };

    test.skipIf(seedSelected)(
      "the default seeds cover each asserted branch (a safe cut, a live cut, a one-way break) and leave few cuts unasserted",
      () => {
        // Act: 既定の seed の事例を分類する。
        const counts = { safe: 0, live: 0, gray: 0, outbound: 0 };
        for (const seed of seeds) {
          const c = drawFailoverBurstCase(seed);
          if (c.direction === "outbound") {
            counts.outbound++;
            continue;
          }
          const { safe, live } = classifyBurst(c.thresholds, c.burstMs);
          counts[safe ? "safe" : live ? "live" : "gray"]++;
        }

        // Assert: 判定する分岐はどれも seed の 1 割以上で調べ、判定しない灰色の範囲は 2 割未満。
        for (const branch of ["safe", "live", "outbound"] as const) {
          expect(counts[branch], JSON.stringify(counts)).toBeGreaterThanOrEqual(
            seeds.length / 10,
          );
        }
        expect(counts.gray, JSON.stringify(counts)).toBeLessThan(
          seeds.length / 5,
        );
      },
    );
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    test.each(cases)(
      title(
        "a cut moves the selection only as the receiving / unwritable rules allow",
      ),
      async ({ seed }) => {
        const { thresholds, renomination, direction, burstMs, random } =
          drawFailoverBurstCase(seed);
        const {
          receivingTimeout: rt,
          receivingSwitchingDelay: delay,
          unwritableMinChecks: minChecks,
          unwritableTimeout,
        } = thresholds;
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockImplementation(random.next);
        const label = `${replay(seed)} ${JSON.stringify({ ...thresholds, renomination, direction, burstMs })}`;
        const h = await createFailoverHarness({
          renomination,
          failover: thresholds,
        });
        const host = h.selection;
        const relay = h.pairOf(1);
        await vi.advanceTimersByTimeAsync(10_000);
        const stopReceiving =
          direction === "outbound" ? h.keepReceiving(host) : () => {};
        let movedAt: number | undefined;
        const recordMove = () => {
          if (movedAt === undefined && h.connection.nominated === relay) {
            movedAt = Date.now();
          }
          return false;
        };

        try {
          // Act: 応答の直後に host を切る。
          const cutAt = await h.cutRightAfterAnswer(0);

          if (direction === "outbound") {
            // Act: 相手のデータは届いたまま、移るまで進める。
            await h.advanceUntil(
              () => h.connection.nominated === relay,
              30_000,
            );
            const took = Date.now() - cutAt;
            const sent = h
              .requestsTo(host)
              .filter(
                (request) => request.at > cutAt && request.at < cutAt + took,
              );

            // Assert: 受信は続くので受信途絶では移らず、書き込み不可 (minChecks 回の check と unwritableTimeout) を満たしてから移る。
            expect(h.connection.nominated, label).toBe(relay);
            expect(sent.length, label).toBeGreaterThanOrEqual(minChecks);
            expect(took, label).toBeGreaterThanOrEqual(unwritableTimeout - 100);
            // Assert: consent の間隔 (最大 6 s) の後、900 ms ごとの check で数が揃うか、timeout を過ぎた次の check までに移る。
            expect(took, label).toBeLessThanOrEqual(
              Math.max(6000 + 900 * (minChecks - 1), unwritableTimeout + 900) +
                DEADLINE +
                SLACK,
            );
            return;
          }

          // Act: burstMs だけ切って戻し、さらに 20 s 進める (移った時刻を記録する)。
          await h.advanceUntil(recordMove, burstMs);
          h.restore(0);
          await h.advanceUntil(recordMove, 20_000);

          const { safe, live, liveBound } = classifyBurst(thresholds, burstMs);

          // Assert: どちらの規則も満たせない短い断では移らない。
          if (safe) expect(movedAt, label).toBeUndefined();
          // Assert: 受信途絶の判定に足りる長さの断では、その上限内に移る。
          if (live) {
            expect(movedAt, label).toBeDefined();
            expect(movedAt! - cutAt, label).toBeLessThanOrEqual(liveBound);
          }
          // Assert: どの場合も failed にならない。
          expect(
            h.states.map(({ state }) => state),
            label,
          ).not.toContain("failed");
        } finally {
          stopReceiving();
          await h.connection.close();
        }
      },
    );
  },
);
