/**
 * Reproduce the worked examples embedded in gcc-vs-legacy.html.
 * Run from the repository root:
 * node_modules/.bin/tsx reviews/gcc-vs-legacy.trace.ts
 * Use --write to refresh only the embedded JSON; otherwise check it.
 * This is an estimator-input illustration, not a network/encoder benchmark.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TransportWideCC } from "../packages/rtp/src/rtcp/rtpfb/twcc";
import { kTrendlineSmoothingCoeff } from "../packages/webrtc/src/media/sender/estimators/gcc/constants";
import { GccBandwidthEstimator } from "../packages/webrtc/src/media/sender/estimators/gcc/gccBwe";
import { InterArrivalDelta } from "../packages/webrtc/src/media/sender/estimators/gcc/interArrivalDelta";
import { TrendlineEstimator } from "../packages/webrtc/src/media/sender/estimators/gcc/trendlineEstimator";
import { SenderBandwidthEstimator } from "../packages/webrtc/src/media/sender/estimators/legacyCumulativeBwe";

const packetBytes = 1200;
const sendIntervalMs = 12;
const packetCount = 40;

function observe(serviceMs: number, propagationMs: number) {
  let previousExitMs = 0;
  const packets = Array.from({ length: packetCount }, (_, i) => {
    const sendMs = i * sendIntervalMs;
    const startMs = Math.max(sendMs, previousExitMs);
    const exitMs = startMs + serviceMs;
    previousExitMs = exitMs;
    return {
      seq: i + 1,
      sendMs,
      startMs,
      exitMs,
      recvMs: exitMs + propagationMs,
      waitMs: startMs - sendMs,
    };
  });
  const feedbackMs = packets[packets.length - 1].recvMs + 40;
  // legacy uses Date.now internally; keep every sample in the recent past.
  const epochMs = Date.now() - feedbackMs;
  let nowMs = epochMs;
  const legacy = new SenderBandwidthEstimator();
  const gcc = new GccBandwidthEstimator(800000, { clock: () => nowMs });
  const interArrival = new InterArrivalDelta();
  const trendline = new TrendlineEstimator();
  const events = { legacy: [] as number[], gcc: [] as number[] };
  legacy.onAvailableBitrate.subscribe((bps) => events.legacy.push(bps));
  gcc.onAvailableBitrate.subscribe((bps) => events.gcc.push(bps));
  // Isolate delay: equal initial target, no probe session or process timer.
  gcc.setBitrates(5000, 800000, 2000000);

  for (const p of packets) {
    nowMs = epochMs + p.sendMs;
    const info = {
      wideSeq: p.seq,
      size: packetBytes,
      sendingAtMs: nowMs,
      sentAtMs: nowMs,
    };
    legacy.rtpPacketSent(info);
    gcc.rtpPacketSent(info);
  }
  nowMs = epochMs + feedbackMs;
  const feedback = new TransportWideCC({ referenceTime: 0 });
  Object.defineProperty(feedback, "packetResults", {
    value: packets.map((p) => ({
      sequenceNumber: p.seq,
      received: true,
      receivedAtMs: p.recvMs,
    })),
  });
  let accumulatedDelayMs = 0;
  let smoothedDelayMs = 0;
  const trace = packets.map((p) => {
    const delta = interArrival.computeDeltas(
      epochMs + p.sendMs,
      p.recvMs,
      packetBytes,
      nowMs,
    );
    if (delta) {
      trendline.update(delta.recvDeltaMs, delta.sendDeltaMs, p.recvMs);
      // 図の累積・平滑化も同じ群間差と実装の係数から計算する。
      accumulatedDelayMs += delta.recvDeltaMs - delta.sendDeltaMs;
      smoothedDelayMs =
        kTrendlineSmoothingCoeff * smoothedDelayMs +
        (1 - kTrendlineSmoothingCoeff) * accumulatedDelayMs;
    }
    return {
      seq: p.seq,
      deltas: trendline.numDeltas,
      accumulatedDelayMs,
      smoothedDelayMs,
      slope: trendline.trend,
      trend: trendline.modifiedTrend,
      threshold: trendline.adaptiveThreshold,
      state: trendline.state,
    };
  });

  // 同じ送信履歴と TWCC を、現在の二つの推定器へ入力する。
  legacy.receiveTWCC(feedback);
  gcc.receiveTWCC(feedback);

  // 単独で採取した検出器の状態と、GCC 全体での状態が一致することを確認する。
  assert.equal(gcc.usageState, trendline.state);
  const sendSpanMs = packets.at(-1)!.sendMs - packets[0].sendMs;
  const recvSpanMs = packets.at(-1)!.recvMs - packets[0].recvMs;
  const totalBits = packetBytes * packetCount * 8;
  const result = {
    serviceMs,
    propagationMs,
    feedbackMs,
    packets,
    trace,
    sendSpanMs,
    recvSpanMs,
    legacyBps: legacy.availableBitrate,
    gccBps: gcc.availableBitrate,
    events,
    usage: gcc.usageState,
  };
  // legacy の累積計算と通知値を検証する。GCC は最終通知と公開値を照合する。
  assert.equal(
    result.legacyBps,
    Math.floor((totalBits * 1000) / Math.max(sendSpanMs, recvSpanMs)),
  );
  assert.deepEqual(events.legacy, [result.legacyBps]);
  assert.deepEqual(events.gcc, [result.gccBps]);
  legacy.dispose();
  gcc.dispose();
  return result;
}

const data = {
  packetBytes,
  sendIntervalMs,
  packetCount,
  initialTargetBps: 800000,
  scenarios: {
    steady: observe(12, 40),
    queue: observe(16, 40),
    fixed: observe(12, 160),
  },
};
// 待ち行列が増える場合だけ overuse になり、固定遅延では結果が変わらない。
assert.equal(data.scenarios.queue.usage, "overuse");
assert.equal(data.scenarios.queue.gccBps, 505000);
assert.equal(data.scenarios.steady.usage, "normal");
assert.equal(data.scenarios.fixed.usage, "normal");
assert.equal(data.scenarios.steady.gccBps, data.scenarios.fixed.gccBps);

const htmlPath = resolve("reviews/gcc-vs-legacy.html");
const html = readFileSync(htmlPath, "utf8");
const pattern =
  /(<script id="estimator-data" type="application\/json">\n)([\s\S]*?)(\n {2}<\/script>)/;
assert.match(html, pattern, "Embedded estimator-data element must exist");
if (process.argv.includes("--write")) {
  writeFileSync(
    htmlPath,
    html.replace(
      pattern,
      (_match, before, _data, after) => before + JSON.stringify(data) + after,
    ),
  );
} else {
  assert.deepEqual(JSON.parse(html.match(pattern)![2]), data);
}
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(data.scenarios).map(([name, s]) => [
        name,
        {
          legacyBps: s.legacyBps,
          gccBps: s.gccBps,
          usage: s.usage,
          firstOveruseAtPacket: s.trace.find((t) => t.state === "overuse")?.seq,
        },
      ]),
    ),
  ),
);
