import { RtpBuilder } from "../../src/util";
import { createManualMediaClockHarness, createVfrTimings } from "../utils";

describe("rtp/mediaPacer", () => {
  test("可変フレームレートのフレームを各 pts の絶対 deadline で送出する", () => {
    // Arrange: 16.7 / 33.3 / 50ms が混在する 90kHz のフレーム列
    const harness = createManualMediaClockHarness({ startTime: 100 });
    const pacer = harness.createPacer<number>({
      clockRate: 90_000,
      initialTimestamp: 1000,
    });
    const ticks = harness.collectPacerTicks(pacer);
    const timings = createVfrTimings(6);
    for (const { index, pts } of timings) {
      pacer.push(index, { pts });
    }

    // Act: 開始して 300ms 進める
    pacer.start();
    harness.advance(300);

    // Assert: 発火時刻は start + pts/90 ms、timestamp は initial + pts
    expect(ticks.map((t) => t.frame)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ticks.map((t) => t.timestamp)).toEqual(
      timings.map((t) => 1000 + t.pts),
    );
    ticks.forEach((tick, i) => {
      expect(tick.firedAt).toBeCloseTo(100 + timings[i].pts / 90, 6);
    });
    // Assert: 遅延の付け替えは起きていない
    expect(ticks.every((t) => t.delay === 0)).toBe(true);
    pacer.stop();
  });

  test("毎回 1ms 遅れるスケジューラで 1 分動かしても可変間隔の deadline からずれない", () => {
    // Arrange: 1 分強の VFR フレーム列を全部 push しておく
    const harness = createManualMediaClockHarness({ callbackLatency: 1 });
    const pacer = harness.createPacer<number>({
      clockRate: 90_000,
      initialTimestamp: 0,
    });
    const ticks = harness.collectPacerTicks(pacer);
    const timings = createVfrTimings(2000);
    for (const { index, pts } of timings) {
      pacer.push(index, { pts });
    }

    // Act: 1 分間動かす
    pacer.start();
    harness.advance(60_000);
    pacer.stop();

    // Assert: deadline は最初のフレーム基準の origin + pts/90 のまま、遅れは毎回 1ms だけ
    expect(ticks.length).toBeGreaterThan(1000);
    const origin = ticks[0].deadline;
    for (const tick of ticks.slice(1)) {
      expect(tick.deadline).toBeCloseTo(origin + tick.pts / 90, 6);
      expect(tick.lateness).toBeCloseTo(1, 6);
    }
    expect(ticks.every((t) => t.delay === 0)).toBe(true);
  });

  test("ストール時はフレームを飛ばさず 1 回だけ送り、以降は元の間隔で遅延として吸収する", () => {
    // Arrange: 30 フレームの VFR 列を push し、200ms 進める
    const harness = createManualMediaClockHarness();
    const pacer = harness.createPacer<number>({
      clockRate: 90_000,
      initialTimestamp: 0,
    });
    const ticks = harness.collectPacerTicks(pacer);
    const timings = createVfrTimings(30);
    for (const { index, pts } of timings) {
      pacer.push(index, { pts });
    }
    pacer.start();
    harness.advance(200);
    const before = ticks.length;
    const nextPts = timings[before].pts;

    // Act: 5 秒ストールさせ、溜まったタイマーを処理させる
    harness.block(5000);
    harness.advance(0);

    // Assert: 1 フレームだけ送出され、burst しない
    expect(ticks.length - before).toBe(1);
    const stalledTick = ticks.at(-1)!;
    expect(stalledTick.frame).toBe(before);
    expect(stalledTick.lateness).toBeCloseTo(5200 - nextPts / 90, 6);

    // Act: 最後まで進める
    harness.advance(10_000);

    // Assert: 全フレームが順番通り、timestamp は pts のまま連続する
    expect(ticks.map((t) => t.frame)).toEqual(timings.map((t) => t.index));
    expect(ticks.map((t) => t.timestamp)).toEqual(timings.map((t) => t.pts));
    // Assert: ストール後は送出時刻を基準に元の pts 間隔を保つ
    for (let i = before + 1; i < ticks.length; i++) {
      expect(ticks[i].firedAt - ticks[i - 1].firedAt).toBeCloseTo(
        (timings[i].pts - timings[i - 1].pts) / 90,
        6,
      );
    }
    // Assert: 吸収した遅延量が delay に現れる
    expect(ticks.at(-1)!.delay).toBeCloseTo(stalledTick.lateness, 6);
  });

  test("B フレーム: dts 順に送出し、RTP timestamp は pts から決める", () => {
    // Arrange: decode 順 I P B B (pts 0, 9000, 3000, 6000)
    const harness = createManualMediaClockHarness();
    const pacer = harness.createPacer<string>({
      clockRate: 90_000,
      initialTimestamp: 0,
    });
    const ticks = harness.collectPacerTicks(pacer);
    pacer.push("I", { pts: 3000, dts: 0 });
    pacer.push("P", { pts: 12000, dts: 3000 });
    pacer.push("B1", { pts: 6000, dts: 6000 });
    pacer.push("B2", { pts: 9000, dts: 9000 });

    // Act
    pacer.start();
    harness.advance(200);

    // Assert: dts 間隔 (33.3ms) で送出し、timestamp は最初の pts 基準
    expect(ticks.map((t) => t.frame)).toEqual(["I", "P", "B1", "B2"]);
    expect(ticks.map((t) => t.timestamp)).toEqual([0, 9000, 3000, 6000]);
    ticks.forEach((tick, i) => {
      expect(tick.firedAt).toBeCloseTo((i * 1000) / 30, 6);
    });
    // Assert: dts が戻るフレームは push できない
    expect(() => pacer.push("bad", { pts: 0, dts: 0 })).toThrow(RangeError);
    pacer.stop();
  });

  test("キューが空の間に遅れて届いたフレームは即送出し、後続のまとめ届きも burst しない", () => {
    // Arrange: 2 フレームだけ送ってキューを空にする
    const harness = createManualMediaClockHarness();
    const pacer = harness.createPacer<number>({
      clockRate: 90_000,
      initialTimestamp: 0,
    });
    const ticks = harness.collectPacerTicks(pacer);
    pacer.push(0, { pts: 0 });
    pacer.push(1, { pts: 3000 });
    pacer.start();
    harness.advance(100);

    // Act: 1 秒後に frame 2..5 (本来 66.7ms〜) がまとめて届く
    harness.advance(1000);
    for (let i = 2; i < 6; i++) {
      pacer.push(i, { pts: i * 3000 });
    }
    harness.advance(0);

    // Assert: すぐ送られるのは frame 2 だけ
    expect(ticks.map((t) => t.frame)).toEqual([0, 1, 2]);

    // Act: 100ms 進める
    harness.advance(100);

    // Assert: 残りは 33.3ms 間隔で続く
    expect(ticks.map((t) => t.frame)).toEqual([0, 1, 2, 3, 4, 5]);
    for (let i = 3; i < 6; i++) {
      expect(ticks[i].firedAt - ticks[i - 1].firedAt).toBeCloseTo(1000 / 30, 6);
    }
    pacer.stop();
  });

  test("pause 中は送出せず、resume で次フレームを即送出して pause 時間を delay に加える", () => {
    // Arrange: 10 フレームを push して 50ms 進めてから pause
    const harness = createManualMediaClockHarness();
    const pacer = harness.createPacer<number>({
      clockRate: 90_000,
      initialTimestamp: 0,
    });
    const ticks = harness.collectPacerTicks(pacer);
    for (let i = 0; i < 10; i++) {
      pacer.push(i, { pts: i * 3000 });
    }
    pacer.start();
    harness.advance(50);
    pacer.pause();

    // Act: 1 秒 pause する
    harness.advance(1000);
    const whilePaused = ticks.length;
    // Act: resume して 0ms / 34ms 進める
    pacer.resume();
    harness.advance(0);
    const afterResume = ticks.length;
    harness.advance(34);

    // Assert: pause 中はタイマーもなく送出しない
    expect(whilePaused).toBe(2);
    // Assert: resume 直後は 1 フレームだけ、次は 33.3ms 後
    expect(afterResume).toBe(3);
    expect(ticks.length).toBe(4);
    expect(ticks[2].delay).toBeCloseTo(1050 - 2000 / 30, 6);
    pacer.stop();
  });

  test("tick 中の stop / abort でタイマーとキューが残らない", () => {
    // Arrange
    const harness = createManualMediaClockHarness();
    const controller = new AbortController();
    const stopPacer = harness.createPacer<number>({ clockRate: 90_000 });
    const abortPacer = harness.createPacer<number>({
      clockRate: 90_000,
      signal: controller.signal,
    });
    for (let i = 0; i < 10; i++) {
      stopPacer.push(i, { pts: i * 3000 });
      abortPacer.push(i, { pts: i * 3000 });
    }
    stopPacer.onTick.subscribe((tick) => {
      if (tick.frame === 2) stopPacer.stop();
    });
    abortPacer.onTick.subscribe((tick) => {
      if (tick.frame === 2) controller.abort();
    });

    // Act: 2 フレーム目の tick 中に stop / abort させる
    stopPacer.start();
    abortPacer.start();
    harness.advance(500);

    // Assert: どちらも停止し、タイマーとキューが残らない
    expect(stopPacer.state).toBe("stopped");
    expect(abortPacer.state).toBe("stopped");
    expect(stopPacer.queueLength).toBe(0);
    expect(abortPacer.queueLength).toBe(0);
    expect(harness.pendingTimerCount()).toBe(0);
    expect(() => stopPacer.push(99, { pts: 0 })).toThrow();
  });

  test("RtpBuilder と組み合わせると seq は連続し timestamp は pts を保つ", () => {
    // Arrange: VFR フレーム列と RtpBuilder
    const harness = createManualMediaClockHarness();
    const pacer = harness.createPacer({
      clockRate: 90_000,
      initialTimestamp: 0xffffffff - 2000,
    });
    const builder = new RtpBuilder({
      payloadType: 96,
      initialSequenceNumber: 0,
    });
    const sent: { seq: number; ts: number }[] = [];
    pacer.start((tick) => {
      const rtp = builder.create(tick.frame, { tick, marker: true });
      sent.push({ seq: rtp.header.sequenceNumber, ts: rtp.header.timestamp });
    });
    const timings = createVfrTimings(5);

    // Act: リアルタイムに届くフレームを順に push する
    for (const { index, pts } of timings) {
      pacer.push(Buffer.from([index]), { pts });
    }
    harness.advance(500);

    // Assert: seq は 0..4、timestamp は pts 差分のまま 32-bit wrap する
    expect(sent.map((s) => s.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(sent.map((s) => s.ts)).toEqual(
      timings.map((t) => (0xffffffff - 2000 + t.pts) % 2 ** 32),
    );
    pacer.stop();
  });
});
