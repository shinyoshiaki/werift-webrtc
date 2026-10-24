import assert from "node:assert/strict";
import { test } from "node:test";

import {
  demuxCodecFixture,
  streamPacketizedFixture,
} from "../../server/codecRtpUtils";

test("fixture loop keeps frame spacing across the loop boundary", async () => {
  // Arrange: 書き込み時刻を記録する偽 track と、1 周分のサンプル数
  const demuxed = await demuxCodecFixture("vp8");
  const samplesPerLoop = demuxed.samples.length;
  const sentAt: number[] = [];
  const abort = new AbortController();
  const track = { codec: undefined, writeRtp: () => {} };

  // Act: 3 周目の先頭まで送って停止する
  await streamPacketizedFixture({
    codec: "vp8",
    track: track as never,
    signal: abort.signal,
    loop: true,
    onFrameSent: () => {
      sentAt.push(performance.now());
      if (sentAt.length === samplesPerLoop * 2 + 1) {
        abort.abort();
      }
    },
  });

  // Assert: 周回境界の送信間隔が通常のフレーム間隔 + 余裕に収まる
  const toleranceMs = 100;
  const expectedMs = demuxed.averageIntervalSec * 1000;
  for (const boundary of [samplesPerLoop, samplesPerLoop * 2]) {
    const gap = sentAt[boundary] - sentAt[boundary - 1];
    assert.ok(
      gap < expectedMs + toleranceMs,
      `gap at loop boundary ${gap.toFixed(0)}ms (expected ~${expectedMs.toFixed(0)}ms)`,
    );
  }
});
