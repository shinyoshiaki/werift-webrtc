import { afterAll } from "vitest";

import { catalogByGroup } from "../helpers/catalog.js";
import {
  latencyBudgetLoss,
  runLatencyBudgetScenario,
  waitLatencyBudgetPage,
} from "../helpers/latencyBudget.js";
import { closeSharedBrowser } from "../helpers/openPage.js";
import { withExample } from "../helpers/runExample.js";
import { waitNonEmptyOutput } from "../helpers/waitPeer.js";

afterAll(async () => {
  await closeSharedBrowser();
});

for (const entry of catalogByGroup("browser").filter(
  (item) => item.kind === "latency-budget",
)) {
  test(entry.id, async (ctx) => {
    await withExample(
      entry,
      async (session) => {
        const page = session.page;
        if (!page) throw new Error("page required");
        await waitLatencyBudgetPage(page);

        // Act: シナリオ A。同じ周期バーストロスで budget 0 と 5000ms を録音する
        const a0 = await runLatencyBudgetScenario(page, "runA", {
          budgetMs: 0,
          durationMs: 5000,
          loss: latencyBudgetLoss.upstream,
        });
        const a5000 = await runLatencyBudgetScenario(page, "runA", {
          budgetMs: 5000,
          durationMs: 5000,
          loss: latencyBudgetLoss.upstream,
        });

        // Assert: budget 0 は一切回収せず、5000ms は欠落を全て音声 NACK で回収する
        expect(a0.lost).toBeGreaterThan(0);
        expect(a0.recovered).toBe(0);
        expect(a0.unrecovered).toBe(a0.lost);
        expect(a5000.lost).toBeGreaterThan(0);
        expect(a5000.recovered).toBeGreaterThanOrEqual(a0.recovered);
        expect(a5000.unrecovered).toBe(0);
        // Assert: 受信音声を webm に保存している
        await waitNonEmptyOutput(session.workDir, entry.outputGlob!, 10_000);

        // Act: シナリオ B。録音を従来の sleep 付き (realtime) とバースト (sleep なし) で送る
        const bRealtime = await runLatencyBudgetScenario(page, "runB", {
          pace: "realtime",
          output: "native",
        });
        const b = await runLatencyBudgetScenario(page, "runB", {
          pace: "burst",
          output: "player",
        });

        // Assert: バーストは実時間より速く届く
        expect(b.server.sendMs).toBeLessThan(b.server.mediaMs / 4);
        expect(b.player.arrivalSpanMs).toBeLessThan(
          b.player.arrivalMediaMs / 4,
        );
        // Assert: player は RTP timestamp どおりの速度で全フレームを再生する
        expect(b.player.playbackRate).toBeGreaterThan(0.95);
        expect(b.player.playbackRate).toBeLessThan(1.05);
        expect(b.player.playedFrames).toBeGreaterThanOrEqual(
          b.server.packets * 0.95,
        );
        // Assert: NetEQ (到着時刻で再生) はバーストを捨て、realtime 送信より多く破棄する
        expect(b.native.packetsDiscarded).toBeGreaterThan(
          bRealtime.native.packetsDiscarded,
        );

        // Act: シナリオ C。500ms / 5000ms の 2 subscriber に同じ下りバーストロスをかける
        const c = await runLatencyBudgetScenario(page, "runC", {
          budgets: [500, 5000],
          minDelayMs: 100,
          durationMs: 10_000,
          loss: latencyBudgetLoss.downstream,
        });
        const short = c.subscribers["500"];
        const long = c.subscribers["5000"];

        // Assert: どちらも欠落を検出し、アプリ層 NACK を werift に送っている
        expect(short.player.missingFrames).toBeGreaterThan(0);
        expect(long.player.missingFrames).toBeGreaterThan(0);
        expect(long.server.retransmitted).toBeGreaterThan(0);
        // Assert: budget の大きい subscriber ほど多く回収し、遅延も大きい
        expect(long.player.recoveredFrames).toBeGreaterThan(
          short.player.recoveredFrames,
        );
        expect(short.player.concealedFrames).toBeGreaterThan(0);
        expect(long.player.maxDelayMs).toBeGreaterThan(short.player.maxDelayMs);
        // Assert: 500ms subscriber の遅延は budget 内に収まる
        expect(short.player.maxDelayMs).toBeLessThanOrEqual(500 + 20);
        // Assert: budget が DataChannel 経由で werift の再送打ち切りに反映される
        expect(short.server.budgetMs).toBe(500);
        expect(long.server.budgetMs).toBe(5000);
        expect(c.upstream.upstreamBudgetMs).toBe(5000);

        // Act: シナリオ D。バースト送信後、再生途中で割り込む
        const d = await runLatencyBudgetScenario(page, "runD", {
          interruptAfterMs: 700,
        });

        // Assert: 新 generation が CSRC で届き、旧 generation のバッファは捨てられ再生されない
        expect(d.player.generation).toBe(2);
        expect(d.player.flushedFrames).toBeGreaterThan(0);
        expect(d.player.oldGenerationPlayed).toBe(0);
        expect(d.playedAfter).toBeGreaterThan(d.playedBeforeInterrupt);
        expect(d.player.playedFrames).toBeLessThan(
          (d.answerMs + d.replyMs) / 20,
        );
      },
      ctx,
    );
  });
}
