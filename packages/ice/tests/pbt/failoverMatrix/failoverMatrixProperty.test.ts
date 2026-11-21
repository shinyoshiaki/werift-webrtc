import { afterEach, describe, expect, test, vi } from "vitest";

import { propertyOptions, propertySeeds } from "../../../../pbt/src";
import { CandidatePairState } from "../../../src";
import { createFailoverMatrixCell } from "../../utils";
import { drawFailoverMatrixCase } from "./generator";

/**
 * Failover matrix property (ticket 6b2d7627): an eligible pair on a path
 * other than the selected one (another local socket, or another remote
 * address on the selected socket), above or below the selection, whatever
 * the role, is monitored and taken when the selected path breaks:
 * - controlling: within 11 s of the cut the selection is the alternative
 *   (an alternative above the selection that is reachable is selected before
 *   the cut already) and the agent never fails;
 * - controlled: within 10 s of the cut the alternative is valid and still
 *   checked, the agent does not fail before 40 s, and the peer's nomination
 *   alone (USE-CANDIDATE, or NOMINATION + 1; no application data) moves the
 *   selection to it within 2 s, connected again.
 * Each run of 16 seeds covers every role × mode × position; the downtime of
 * the alternative, the time before the cut and the timer jitter are drawn
 * (`generator.ts`).
 *
 * CI runs `WERIFT_ICE_FAILOVER_MATRIX_SEEDS` (default 128) seeds from
 * `WERIFT_ICE_FAILOVER_MATRIX_SEED` (default 1). A failing title prints the
 * replay environment.
 */
describe(
  "failover matrix property: role × mode × alternative path × how long it was down",
  propertyOptions(),
  () => {
    // 16 の組み合わせ (ロール × モード × 代替の位置) を seed 順に一巡ずつ回し、
    // 代替が落ちていた時間・切断までの時間・タイマーの揺らぎを乱数で引く。
    const { cases, replay, title } = propertySeeds(
      "WERIFT_ICE_FAILOVER_MATRIX",
      {
        seeds: 128,
        steps: 1,
      },
    );
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    test.each(cases)(
      title(
        "the alternative path is monitored and taken when the selected path breaks",
      ),
      async ({ seed }) => {
        const {
          iceControlling,
          renomination,
          phase,
          altDownMs,
          settleMs,
          random,
        } = drawFailoverMatrixCase(seed);
        vi.useFakeTimers();
        // consent と退避先の間隔の揺らぎ (0.8〜1.2 倍) も seed で決める。
        vi.spyOn(Math, "random").mockImplementation(random.next);
        const label = `${replay(seed)} ${iceControlling ? "controlling" : "controlled"} ${renomination ? "renomination" : "semi-aggressive"} ${phase} altDownMs=${altDownMs} settleMs=${settleMs}`;
        const cell = await createFailoverMatrixCell({
          iceControlling,
          renomination,
          phase,
          altDownMs,
        });
        const { h, alt } = cell;
        const upper = phase.endsWith("upper");

        try {
          // Act: 代替経路が戻るまで (落ちていれば) 進め、さらに 20〜40 s 進める (16 s ごとの再試行を 1 回以上含む)。
          await vi.advanceTimersByTimeAsync(altDownMs + settleMs);

          // Assert: controlling は通る上位の代替へ切断前に移っている。他は元の選択のまま接続している。
          expect(h.connection.nominated, label).toBe(
            iceControlling && upper ? alt : h.selection,
          );
          expect(h.connection.state, label).toBe("connected");

          // Act: 選択した経路 (local 0 → remote 0) だけを切る。
          cell.cutSelected();
          const cutAt = Date.now();

          if (iceControlling) {
            // Act: 代替へ移るまで進める。
            await h.advanceUntil(() => h.connection.nominated === alt, 20_000);

            // Assert: 切断から 11 s 以内に代替へ移り、failed を経ない。
            expect(h.connection.nominated, label).toBe(alt);
            expect(Date.now() - cutAt, label).toBeLessThanOrEqual(11_000);
            expect(
              h.states.map(({ state }) => state),
              label,
            ).not.toContain("failed");
            return;
          }

          // Act: 切断から 10 s 進める。
          await vi.advanceTimersByTimeAsync(10_000);

          // Assert: 代替は有効 (SUCCEEDED) で、check が続いている。
          expect(alt.state, label).toBe(CandidatePairState.SUCCEEDED);
          expect(
            h
              .requestsTo(alt)
              .some(
                (request) => request.at >= cutAt + 7_000 && request.answered,
              ),
            label,
          ).toBe(true);

          // Act: 切断から 35 s まで進める (consent は失効し、猶予期間に入る)。
          await vi.advanceTimersByTimeAsync(25_000);

          // Assert: 40 s 前に failed にならない。
          expect(["connected", "disconnected"], label).toContain(
            h.connection.state,
          );
          expect(
            h.states.map(({ state }) => state),
            label,
          ).not.toContain("failed");

          // Act: 相手が代替を指名する (データは送らない)。
          h.receiveNomination(alt, renomination ? 2 : undefined);
          await vi.advanceTimersByTimeAsync(2_000);

          // Assert: 2 s 以内に代替へ移り、connected に戻る。
          expect(h.connection.nominated, label).toBe(alt);
          expect(h.connection.state, label).toBe("connected");
        } finally {
          await cell.close();
        }
      },
    );
  },
);
