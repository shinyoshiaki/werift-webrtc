import { setTimeout as sleep } from "timers/promises";

import { RtpMediaClock, RtpMediaTimeline } from "../../src/rtp/mediaClock";
import { RtpBuilder } from "../../src/util";
import {
  activeTimeoutCount,
  createEncodedVideoFrames,
  createManualMediaClockHarness,
  createRecordingScheduler,
} from "../utils";

describe("rtp/mediaClock", () => {
  describe("RtpMediaTimeline", () => {
    test.each([
      { clockRate: 8_000, frameDurationMs: 20, frameSamples: 160 },
      { clockRate: 16_000, frameDurationMs: 20, frameSamples: 320 },
      { clockRate: 24_000, frameDurationMs: 20, frameSamples: 480 },
      { clockRate: 48_000, frameDurationMs: 20, frameSamples: 960 },
      { clockRate: 48_000, frameDurationMs: 10, frameSamples: 480 },
      { clockRate: 90_000, frameDurationMs: 1000 / 30, frameSamples: 3000 },
      {
        clockRate: 90_000,
        frameDurationMs: 1000 / 29.97,
        frameSamples: 90_000 / 29.97,
      },
    ])(
      "audio/video $clockRate Hz / $frameSamples samples matches theoretical values",
      ({ clockRate, frameDurationMs, frameSamples }) => {
        // Arrange
        const timeline = new RtpMediaTimeline({
          clockRate,
          frameDurationMs,
          initialTimestamp: 1000,
        });
        const anchor = { time: 500, frameIndex: 0 };

        for (const n of [0, 1, 2, 50, 1234]) {
          // Act: フレーム番号 N の timestamp / deadline を絶対値で計算する
          const timestamp = timeline.timestamp(n);
          const deadline = timeline.deadline(anchor, n);

          // Assert: 理論値 initial + round(N*frameSamples)、origin + N*duration と一致する
          expect(timeline.frameSamples).toBeCloseTo(frameSamples, 9);
          expect(timestamp).toBe(1000 + Math.round(n * frameSamples));
          expect(deadline).toBeCloseTo(500 + n * frameDurationMs, 6);
        }
      },
    );

    test("frameSamples と frameDurationMs は片方から他方を導出する", () => {
      // Act: samples 指定と duration 指定でそれぞれ生成する
      const fromSamples = new RtpMediaTimeline({
        clockRate: 48_000,
        frameSamples: 960,
      });
      const fromDuration = new RtpMediaTimeline({
        clockRate: 90_000,
        frameDurationMs: 1000 / 29.97,
      });

      // Assert: 48kHz/960 = 20ms、90kHz/29.97fps = 3003.003... samples
      expect(fromSamples.frameDurationMs).toBe(20);
      expect(fromDuration.frameSamples).toBeCloseTo(3003.003003, 6);
      // Assert: 両方指定 / 未指定はエラー
      expect(
        () =>
          new RtpMediaTimeline({
            clockRate: 48_000,
            frameSamples: 960,
            frameDurationMs: 20,
          }),
      ).toThrow(TypeError);
      expect(() => new RtpMediaTimeline({ clockRate: 48_000 })).toThrow(
        TypeError,
      );
    });

    test("29.97fps の小数サンプルで 1 時間分進めても累積誤差は 1 sample 以内", () => {
      // Arrange: 90kHz / 29.97fps (= 3003.003... samples/frame)
      const timeline = new RtpMediaTimeline({
        clockRate: 90_000,
        frameDurationMs: 1000 / 29.97,
        initialTimestamp: 0,
      });
      const oneHourFrames = Math.ceil(3600 * 29.97);

      let maxError = 0;
      for (let n = 0; n <= oneHourFrames; n++) {
        // Act: 各フレームの経過サンプル数を計算する
        const samples = timeline.elapsedSamples(n);
        // 厳密値: N * 90000 / 29.97 = N * 9000000 / 2997
        const exact = (n * 9_000_000) / 2997;
        maxError = Math.max(maxError, Math.abs(samples - exact));
      }

      // Assert: 丸め誤差 (<= 0.5) のみで、累積しない
      expect(maxError).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(timeline.timestamp(oneHourFrames)).toBe(
        Math.round((oneHourFrames * 9_000_000) / 2997),
      );
    });

    test("resolveTick は到達済みの最新スロットと skip 数を返す", () => {
      // Arrange
      const timeline = new RtpMediaTimeline({
        clockRate: 48_000,
        frameSamples: 960,
        initialTimestamp: 0,
      });
      const anchor = { time: 0, frameIndex: 0 };

      // Act: deadline 前 / deadline ちょうど / 5 秒ストール後を解決する
      const early = timeline.resolveTick({
        anchor,
        nextFrameIndex: 51,
        lastFrameIndex: 50,
        now: 1019,
      });
      const onTime = timeline.resolveTick({
        anchor,
        nextFrameIndex: 51,
        lastFrameIndex: 50,
        now: 1020,
      });
      const stalled = timeline.resolveTick({
        anchor,
        nextFrameIndex: 51,
        lastFrameIndex: 50,
        now: 6000,
      });

      // Assert: deadline 前は undefined
      expect(early).toBeUndefined();
      // Assert: 定刻なら skip なしで次スロット
      expect(onTime).toEqual({
        frameIndex: 51,
        timestamp: 48960,
        elapsedSamples: 960,
        skippedFrames: 0,
        deadline: 1020,
        lateness: 0,
      });
      // Assert: ストール後は最新スロット 300 に飛び、間の 249 スロットを skip
      expect(stalled).toEqual({
        frameIndex: 300,
        timestamp: 288000,
        elapsedSamples: 240000,
        skippedFrames: 249,
        deadline: 6000,
        lateness: 0,
      });
    });

    test("stallPolicy delay の resolveTick は skip せず次スロットを元の deadline で返す", () => {
      // Arrange
      const timeline = new RtpMediaTimeline({
        clockRate: 48_000,
        frameSamples: 960,
        initialTimestamp: 0,
      });

      // Act: frame 50 の後、5 秒ストールした時刻で解決する
      const stalled = timeline.resolveTick({
        anchor: { time: 0, frameIndex: 0 },
        nextFrameIndex: 51,
        lastFrameIndex: 50,
        now: 6000,
        stallPolicy: "delay",
      });

      // Assert: 次の frame 51 を返し、遅れは lateness に現れる
      expect(stalled).toEqual({
        frameIndex: 51,
        timestamp: 48960,
        elapsedSamples: 960,
        skippedFrames: 0,
        deadline: 1020,
        lateness: 4980,
      });
    });

    test("RTP timestamp は 32-bit で wrap する", () => {
      // Arrange: initialTimestamp = 0xffffffff - 100
      const timeline = new RtpMediaTimeline({
        clockRate: 48_000,
        frameSamples: 960,
        initialTimestamp: 0xffffffff - 100,
      });

      // Act / Assert: 1 フレーム目で wrap し、以降も mod 2^32 で進む
      expect(timeline.timestamp(0)).toBe(0xffffffff - 100);
      expect(timeline.timestamp(1)).toBe(859);
      expect(timeline.timestamp(2)).toBe(1819);
      // 2^32 を複数回超えるフレーム数でも範囲内に収まる
      const far = timeline.timestamp(10_000_000);
      expect(far).toBe((0xffffffff - 100 + 10_000_000 * 960) % 2 ** 32);
    });
  });

  describe("RtpMediaClock (virtual time)", () => {
    test("start 直後に frame 0 を発火し、以後は絶対 deadline で tick する", () => {
      // Arrange
      const harness = createManualMediaClockHarness({ startTime: 100 });
      const clock = harness.createClock({
        clockRate: 48_000,
        frameDurationMs: 20,
        initialTimestamp: 0,
      });
      const ticks = harness.collectTicks(clock);

      // Act: 開始して 100ms 進める
      clock.start();
      harness.advance(100);

      // Assert: frame 0..5 が deadline 通りに 1 回ずつ発火する
      expect(ticks.map((t) => t.frameIndex)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(ticks.map((t) => t.timestamp)).toEqual([
        0, 960, 1920, 2880, 3840, 4800,
      ]);
      expect(ticks.map((t) => t.deadline)).toEqual([
        100, 120, 140, 160, 180, 200,
      ]);
      expect(ticks.every((t) => t.skippedFrames === 0)).toBe(true);
      expect(ticks[0].elapsedSamples).toBe(0);
      expect(ticks[1].elapsedSamples).toBe(960);
      clock.stop();
    });

    test("毎回 1ms 遅れるスケジューラで 1 分動かしても誤差は 1 フレーム未満", () => {
      // Arrange: 全コールバックが 1ms 遅れて呼ばれる環境
      const harness = createManualMediaClockHarness({ callbackLatency: 1 });
      const clock = harness.createClock({
        clockRate: 48_000,
        frameSamples: 960,
        initialTimestamp: 0,
      });
      const ticks = harness.collectTicks(clock);

      // Act: 1 分間動かす
      clock.start();
      harness.advance(60_000);
      clock.stop();

      // Assert: 各 tick の発火時刻 (deadline + lateness) とメディア時刻の差は 1 フレーム (20ms) 未満
      for (const tick of ticks) {
        const mediaMs = (tick.timestamp / 48_000) * 1000;
        const firedAt = tick.deadline + tick.lateness;
        expect(Math.abs(firedAt - mediaMs)).toBeLessThan(20);
      }
      // Assert: 1 分後の最終 tick もメディア時刻 59.98 秒ちょうどのスロット
      expect(ticks.at(-1)!.timestamp).toBe(2999 * 960);
      // Assert: 1 フレーム未満の遅延では skip しない
      expect(ticks.every((t) => t.skippedFrames === 0)).toBe(true);
      expect(ticks).toHaveLength(3000);
      expect(ticks.every((t) => t.lateness === 1)).toBe(true);
    });

    test("比較: 相対 interval + 固定加算の旧方式は 1 分で約 2.857 秒ずれる", () => {
      // Arrange: 同じ 1ms 遅延スケジューラで旧方式を動かす
      const harness = createManualMediaClockHarness({ callbackLatency: 1 });
      let timestamp = 0;
      const loop = () => {
        timestamp += 960;
        harness.scheduler.setTimeout(loop, 20);
      };
      harness.scheduler.setTimeout(loop, 20);

      // Act: 1 分間動かす
      harness.advance(60_000);

      // Assert: 実時間がメディアクロックより約 2.857 秒先行する
      const drift = harness.now() - (timestamp / 48_000) * 1000;
      expect(drift).toBeGreaterThan(2_800);
      expect(drift).toBeLessThan(2_900);
    });

    test("5 秒のストール後は最新スロットを 1 回だけ発火し burst しない", () => {
      // Arrange: ts=48000 (frame 50) まで進める
      const harness = createManualMediaClockHarness();
      const clock = harness.createClock({
        clockRate: 48_000,
        frameSamples: 960,
        initialTimestamp: 0,
      });
      const ticks = harness.collectTicks(clock);
      clock.start();
      harness.advance(1000);
      expect(ticks.at(-1)!.timestamp).toBe(48000);
      const before = ticks.length;

      // Act: イベントループを 5 秒止めてから、溜まったタイマーを処理させる
      harness.block(5000);
      harness.advance(0);

      // Assert: tick は 1 回だけで、間のスロットは skippedFrames として表現される
      expect(ticks.length - before).toBe(1);
      expect(ticks.at(-1)).toMatchObject({
        frameIndex: 300,
        timestamp: 288000,
        skippedFrames: 249,
        elapsedSamples: 240000,
      });

      // Act: さらに 1 フレーム進める
      harness.advance(20);

      // Assert: 以降は通常ペースに戻る
      expect(ticks.at(-1)).toMatchObject({
        frameIndex: 301,
        skippedFrames: 0,
        elapsedSamples: 960,
      });
      clock.stop();
    });

    test("stallPolicy delay: 5 秒のストール後も skip せず、遅延として吸収し burst しない", () => {
      // Arrange: ts=48000 (frame 50) まで進める
      const harness = createManualMediaClockHarness();
      const clock = harness.createClock({
        clockRate: 48_000,
        frameSamples: 960,
        initialTimestamp: 0,
        stallPolicy: "delay",
      });
      const ticks = harness.collectTicks(clock);
      clock.start();
      harness.advance(1000);
      const before = ticks.length;

      // Act: イベントループを 5 秒止めてから、溜まったタイマーを処理させる
      harness.block(5000);
      harness.advance(0);

      // Assert: tick は 1 回だけで、次の frame 51 が遅延付きで出る
      expect(ticks.length - before).toBe(1);
      expect(ticks.at(-1)).toMatchObject({
        frameIndex: 51,
        timestamp: 48960,
        skippedFrames: 0,
        elapsedSamples: 960,
        lateness: 4980,
      });

      // Act: 60ms 進める
      harness.advance(60);

      // Assert: ストール時刻を origin に 20ms 間隔で連続し、追いつき burst はしない
      expect(ticks.slice(-3).map((t) => [t.frameIndex, t.deadline])).toEqual([
        [52, 6020],
        [53, 6040],
        [54, 6060],
      ]);
      expect(ticks.every((t) => t.skippedFrames === 0)).toBe(true);
      clock.stop();
    });

    test("stallPolicy delay: 1 フレーム未満の遅延では re-anchor せずドリフトしない", () => {
      // Arrange: 全コールバックが 1ms 遅れて呼ばれる環境
      const harness = createManualMediaClockHarness({ callbackLatency: 1 });
      const clock = harness.createClock({
        clockRate: 48_000,
        frameSamples: 960,
        initialTimestamp: 0,
        stallPolicy: "delay",
      });
      const ticks = harness.collectTicks(clock);

      // Act: 1 分間動かす
      clock.start();
      harness.advance(60_000);
      clock.stop();

      // Assert: skip 方式と同じく 3000 フレームが元の deadline で出る
      expect(ticks).toHaveLength(3000);
      expect(ticks.at(-1)).toMatchObject({
        timestamp: 2999 * 960,
        deadline: 2999 * 20,
        lateness: 1,
      });
    });

    test("stallPolicy delay: エンコード済み映像は全フレームを連続 timestamp で送れる", () => {
      // Arrange: 30fps / keyframe 間隔 900 フレーム (30 秒) のエンコード済みフレーム列
      const frames = createEncodedVideoFrames(120, 900);
      const harness = createManualMediaClockHarness();
      const clock = harness.createClock({
        clockRate: 90_000,
        frameDurationMs: 1000 / 30,
        initialTimestamp: 0,
        stallPolicy: "delay",
      });
      const builder = new RtpBuilder({
        payloadType: 96,
        initialSequenceNumber: 0,
      });
      const sent: { frame: number; seq: number; ts: number }[] = [];
      clock.start((tick) => {
        const frame = frames.shift();
        if (!frame) {
          clock.stop();
          return;
        }
        const rtp = builder.create(frame.payload, { tick, marker: true });
        sent.push({
          frame: frame.index,
          seq: rtp.header.sequenceNumber,
          ts: rtp.header.timestamp,
        });
      });

      // Act: 途中で 2 秒ストールさせながら最後まで送る
      harness.advance(1000);
      harness.block(2000);
      harness.advance(10_000);

      // Assert: 1 フレームも欠けず、デルタフレームの参照チェーンが保たれる
      expect(sent.map((s) => s.frame)).toEqual(
        Array.from({ length: 120 }, (_, i) => i),
      );
      // Assert: seq / timestamp はギャップなく連続する (3000 samples/frame)
      expect(sent.map((s) => s.seq)).toEqual(
        Array.from({ length: 120 }, (_, i) => i),
      );
      expect(sent.map((s) => s.ts)).toEqual(
        Array.from({ length: 120 }, (_, i) => i * 3000),
      );
      expect(clock.state).toBe("stopped");
    });

    test("stallPolicy delay の resume は既定で pause 期間を詰める", () => {
      // Arrange: frame 10 まで進めて 1 秒 pause する
      const harness = createManualMediaClockHarness();
      const clock = harness.createClock({
        clockRate: 48_000,
        frameSamples: 960,
        initialTimestamp: 0,
        stallPolicy: "delay",
      });
      const ticks = harness.collectTicks(clock);
      clock.start();
      harness.advance(200);
      clock.pause();
      harness.advance(1000);

      // Act: オプションなしで resume する
      clock.resume();
      harness.advance(0);

      // Assert: ギャップなしで frame 11 から続く
      expect(ticks.at(-1)).toMatchObject({
        frameIndex: 11,
        timestamp: 10560,
        skippedFrames: 0,
        deadline: 1200,
      });
      clock.stop();
    });

    test("pause/resume 既定: pause 期間を timestamp ギャップに反映し burst しない", () => {
      // Arrange: frame 10 まで進めてから pause
      const harness = createManualMediaClockHarness();
      const clock = harness.createClock({
        clockRate: 48_000,
        frameSamples: 960,
        initialTimestamp: 0,
      });
      const ticks = harness.collectTicks(clock);
      clock.start();
      harness.advance(200);
      clock.pause();

      // Act: 1 秒 pause してから resume する
      harness.advance(1000);
      const countWhilePaused = ticks.length;
      clock.resume();
      harness.advance(0);

      // Assert: pause 中は tick しない、タイマーも残らない
      expect(countWhilePaused).toBe(11);
      // Assert: resume で 1 回だけ発火し、pause 期間分のギャップが入る
      expect(ticks).toHaveLength(12);
      expect(ticks.at(-1)).toMatchObject({
        frameIndex: 60,
        timestamp: 57600,
        skippedFrames: 49,
        elapsedSamples: 48000,
        deadline: 1200,
      });

      // Act: 40ms 進める
      harness.advance(40);

      // Assert: 再開時刻を origin として 20ms 間隔で続く
      expect(ticks.slice(-2).map((t) => [t.frameIndex, t.deadline])).toEqual([
        [61, 1220],
        [62, 1240],
      ]);
      clock.stop();
    });

    test("pause/resume continuous: pause 期間を詰めて 1 フレームだけ進める", () => {
      // Arrange
      const harness = createManualMediaClockHarness();
      const clock = harness.createClock({
        clockRate: 48_000,
        frameSamples: 960,
        initialTimestamp: 0,
      });
      const ticks = harness.collectTicks(clock);
      clock.start();
      harness.advance(200);
      clock.pause();
      harness.advance(1000);

      // Act: continuous で resume する
      clock.resume({ continuous: true });
      harness.advance(0);

      // Assert: 次のフレームから連続し、skip しない
      expect(ticks.at(-1)).toMatchObject({
        frameIndex: 11,
        timestamp: 10560,
        skippedFrames: 0,
        elapsedSamples: 960,
        deadline: 1200,
      });
      clock.stop();
    });

    test("tick 中の stop/pause は次のタイマーを残さない", () => {
      // Arrange
      const harness = createManualMediaClockHarness();
      const stopClock = harness.createClock({
        clockRate: 48_000,
        frameSamples: 960,
      });
      const pauseClock = harness.createClock({
        clockRate: 48_000,
        frameSamples: 960,
      });
      stopClock.onTick.subscribe((tick) => {
        if (tick.frameIndex === 2) stopClock.stop();
      });
      pauseClock.onTick.subscribe((tick) => {
        if (tick.frameIndex === 2) pauseClock.pause();
      });

      // Act: 2 フレーム目の tick 中に stop / pause させる
      stopClock.start();
      pauseClock.start();
      harness.advance(100);

      // Assert: どちらもタイマーが残らない
      expect(stopClock.state).toBe("stopped");
      expect(pauseClock.state).toBe("paused");
      expect(harness.pendingTimerCount()).toBe(0);
      pauseClock.stop();
    });

    test("購読者が例外を投げてもクロックの状態は更新済みで次の tick が続く", () => {
      // Arrange: frame 1 で例外を投げる購読者
      const harness = createManualMediaClockHarness();
      const clock = harness.createClock({
        clockRate: 48_000,
        frameSamples: 960,
        initialTimestamp: 0,
      });
      const ticks = harness.collectTicks(clock);
      clock.onTick.subscribe((tick) => {
        if (tick.frameIndex === 1) throw new Error("boom");
      });
      clock.start();
      harness.advance(0);

      // Act: 例外が呼び出し元へ伝搬する (握りつぶさない)
      expect(() => harness.advance(20)).toThrow("boom");
      harness.advance(20);

      // Assert: 状態は更新済みで、次のフレームが正しく続く
      expect(clock.lastTick?.frameIndex).toBe(2);
      expect(ticks.map((t) => t.frameIndex)).toEqual([0, 1, 2]);
      clock.stop();
    });

    test("AbortSignal の abort で stop 相当になる", () => {
      // Arrange
      const harness = createManualMediaClockHarness();
      const controller = new AbortController();
      const clock = harness.createClock({
        clockRate: 48_000,
        frameSamples: 960,
        signal: controller.signal,
      });
      const ticks = harness.collectTicks(clock);
      clock.start();
      harness.advance(40);

      // Act: abort して時間を進める
      controller.abort();
      harness.advance(100);

      // Assert: 以降 tick せず、タイマーも残らない
      expect(clock.state).toBe("stopped");
      expect(ticks).toHaveLength(3);
      expect(harness.pendingTimerCount()).toBe(0);
    });

    test("abort 済みの signal で start するとすぐ stop する", () => {
      // Arrange
      const harness = createManualMediaClockHarness();
      const clock = harness.createClock({
        clockRate: 48_000,
        frameSamples: 960,
        signal: AbortSignal.abort(),
      });

      // Act
      clock.start();

      // Assert: タイマーを張らずに停止状態になる
      expect(clock.state).toBe("stopped");
      expect(harness.pendingTimerCount()).toBe(0);
    });
  });

  describe("RtpMediaClock (real timers)", () => {
    test("stop() 後に Timeout ハンドルが残らない", async () => {
      // Arrange: 実タイマーで数 tick 動かす
      const clock = new RtpMediaClock({ clockRate: 48_000, frameSamples: 960 });
      const ticks: number[] = [];
      clock.start((tick) => ticks.push(tick.frameIndex));
      await sleep(70);
      const whileRunning = activeTimeoutCount();

      // Act: stop する
      clock.stop();

      // Assert: クロックが保持していた Timeout 1 個だけが解放される
      expect(ticks.length).toBeGreaterThan(0);
      expect(activeTimeoutCount()).toBe(whileRunning - 1);
    });

    test("AbortSignal 後に Timeout ハンドルが残らない", async () => {
      // Arrange: 実タイマーで動かす
      const controller = new AbortController();
      const clock = new RtpMediaClock({
        clockRate: 48_000,
        frameSamples: 960,
        signal: controller.signal,
      });
      clock.start();
      await sleep(30);
      const whileRunning = activeTimeoutCount();

      // Act: abort する
      controller.abort();

      // Assert: stop 状態になり、クロックの Timeout が解放される
      expect(clock.state).toBe("stopped");
      expect(activeTimeoutCount()).toBe(whileRunning - 1);
    });

    test("unref: true のタイマーはプロセス終了を妨げない", async () => {
      // Arrange: 実タイマーのハンドルを記録する scheduler
      const { handles, scheduler } = createRecordingScheduler();
      const clock = new RtpMediaClock({
        clockRate: 48_000,
        frameSamples: 960,
        scheduler,
        unref: true,
      });

      // Act
      clock.start();
      await sleep(50);
      clock.stop();

      // Assert: 生成された全ハンドルが unref 済み
      expect(handles.length).toBeGreaterThan(1);
      expect(handles.every((handle) => !handle.hasRef())).toBe(true);
    });
  });
});
