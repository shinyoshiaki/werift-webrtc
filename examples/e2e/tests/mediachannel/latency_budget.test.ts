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
          // subscriber ごとに minDelay を変える (500ms 側 60ms、5000ms 側 300ms)
          minDelays: [60, 300],
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
        // Assert: 再送で回収したフレームも、デコーダへは seq 順に渡している
        expect(short.player.outOfOrderDecodedFrames).toBe(0);
        expect(long.player.outOfOrderDecodedFrames).toBe(0);
        expect(long.player.recoveredFrames).toBeGreaterThan(0);
        // Assert: minDelay が subscriber ごとに効き、再生開始時の遅延が設定差に沿う
        expect(short.minDelayMs).toBe(60);
        expect(long.minDelayMs).toBe(300);
        expect(short.player.startDelayMs).toBeGreaterThanOrEqual(60);
        expect(long.player.startDelayMs).toBeGreaterThanOrEqual(300);
        expect(long.player.startDelayMs).toBeGreaterThan(
          short.player.startDelayMs + 100,
        );
        // Assert: budget が DataChannel 経由で werift の再送打ち切りに反映される
        expect(short.server.budgetMs).toBe(500);
        expect(long.server.budgetMs).toBe(5000);
        expect(c.upstream.upstreamBudgetMs).toBe(5000);

        // Act: シナリオ C (長いロス)。werift 送信履歴 (512) が 3.5 秒 (175 パケット) 連続ロスを再送する
        const cLong = await runLatencyBudgetScenario(page, "runC", {
          budgets: [5000],
          minDelayMs: 100,
          durationMs: 14_000,
          loss: latencyBudgetLoss.downstreamLong,
        });
        const longBurst = cLong.subscribers["5000"];

        // Assert: 150 件を超える連続ロスを budget 内で全て回収し、打ち切りはない
        expect(longBurst.player.missingFrames).toBeGreaterThan(150);
        expect(longBurst.player.recoveredFrames).toBe(
          longBurst.player.missingFrames,
        );
        expect(longBurst.player.nackGaveUp).toBe(0);

        // Act: シナリオ C (upstream ロス)。upstream の欠落を 5000ms で回収し、500ms / 5000ms に中継する
        const cUp = await runLatencyBudgetScenario(page, "runC", {
          budgets: [500, 5000],
          minDelayMs: 100,
          durationMs: 10_000,
          upstreamLoss: { intervalMs: 4000, durationMs: 1000 },
        });
        const shortUp = cUp.subscribers["500"];
        const longUp = cUp.subscribers["5000"];

        // Assert: upstream で 500ms を超えて回収したパケットは 500ms subscriber へ中継しない
        expect(cUp.upstream.nack.recovered).toBeGreaterThan(0);
        expect(shortUp.server.skippedLate).toBeGreaterThan(0);
        // Assert: 5000ms subscriber には全て中継する
        expect(longUp.server.skippedLate).toBe(0);
        // Assert: 回収したフレームも seq 順にデコードしている
        expect(shortUp.player.outOfOrderDecodedFrames).toBe(0);
        expect(longUp.player.outOfOrderDecodedFrames).toBe(0);

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

        // Act: シナリオ D (新しい応答が来ない)。割り込み後に新 generation の RTP を送らない
        const dSilent = await runLatencyBudgetScenario(page, "runD", {
          interruptAfterMs: 700,
          reply: false,
        });

        // Assert: 新 generation の RTP が届かなくても、割り込み後は旧バッファを再生しない
        expect(dSilent.player.generation).toBe(2);
        expect(dSilent.player.flushedFrames).toBeGreaterThan(0);
        expect(dSilent.player.oldGenerationPlayed).toBe(0);
        expect(dSilent.playedWhileWaitingReply).toBe(0);

        // Act: シナリオ D (新しい応答が遅れる)。新 generation の RTP を 1.5 秒遅らせる
        const dDelayed = await runLatencyBudgetScenario(page, "runD", {
          interruptAfterMs: 700,
          replyDelayMs: 1500,
        });

        // Assert: 遅れている間は無音で、旧バッファは再生されない
        expect(dDelayed.player.oldGenerationPlayed).toBe(0);
        expect(dDelayed.playedWhileWaitingReply).toBe(0);
        expect(dDelayed.replyMs).toBeGreaterThan(0);

        // Act: シナリオ D (CSRC なし)。CSRC を読めない環境として、generation は制御通知の開始 RTP timestamp で判定する
        const dNoCsrc = await runLatencyBudgetScenario(page, "runD", {
          interruptAfterMs: 700,
          replyDelayMs: 1500,
          noCsrc: true,
        });

        // Assert: 旧応答は再生されず、遅れて届いた新しい応答は破棄されずに再生される
        expect(dNoCsrc.player.generation).toBe(2);
        expect(dNoCsrc.player.oldGenerationPlayed).toBe(0);
        expect(dNoCsrc.playedWhileWaitingReply).toBe(0);
        expect(dNoCsrc.replyMs).toBeGreaterThan(0);
        expect(dNoCsrc.playedAfter).toBeGreaterThan(
          dNoCsrc.playedAfterInterrupt,
        );
        expect(dNoCsrc.player.playedFrames).toBeLessThan(
          (dNoCsrc.answerMs + dNoCsrc.replyMs) / 20,
        );
      },
      ctx,
    );
  });
}
