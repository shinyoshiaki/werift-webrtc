import { describe, expect, test } from "vitest";
import {
  type BandwidthEstimator,
  GccBandwidthEstimator,
  SenderBandwidthEstimator,
  type SentInfo,
  TwccFeedbackAdapter,
  kTwccFeedbackHistoryMaxSeqSpan,
} from "../../src";
import {
  PacketResult,
  captureMatchedFeedback,
  seededRandom,
  syntheticTwccFeedback,
  twccHistoryOf,
  twccSentInfo,
  wireTwccFeedback,
} from "./twccTestUtils";

/**
 * Arrange: simulated transport where this sender owns only some TSNs
 * (other BUNDLE senders fill the rest) and the receiver emits wire feedback
 * that may be duplicated, reordered, or corrective.
 */
function simulateTransport(seed: number) {
  const rand = seededRandom(seed);
  // Start just below a 16-bit wrap so every run crosses at least one wrap.
  const startExt = 0x10000 - 200 - Math.floor(rand() * 500);
  const totalPackets = 3_000 + Math.floor(rand() * 2_000);
  const owned = new Map<number, SentInfo>();
  const recvUsByExt = new Map<number, number>();
  for (let i = 0; i < totalPackets; i++) {
    const ext = startExt + i;
    const sendMs = 1_000 + i;
    if (rand() < 0.6) {
      owned.set(ext, twccSentInfo(ext, 100 + (i % 50), sendMs));
    }
    if (rand() >= 0.1) {
      recvUsByExt.set(ext, (sendMs + 20) * 1000 + Math.floor(rand() * 900));
    }
  }

  // Contiguous feedback windows, as ReceiverTWCC would produce them.
  type Window = { baseExt: number; recvUs: (number | undefined)[] };
  const windows: Window[] = [];
  for (let base = startExt; base < startExt + totalPackets; ) {
    const n = Math.min(
      1 + Math.floor(rand() * 40),
      startExt + totalPackets - base,
    );
    const recvUs = Array.from({ length: n }, (_, i) =>
      recvUsByExt.get(base + i),
    );
    windows.push({ baseExt: base, recvUs });
    base += n;
  }

  // Delivery order: duplicates, delayed (reordered) windows, and corrective
  // re-reports where some earlier losses are now received late.
  const deliveries: Window[] = [];
  const delayed: Window[] = [];
  for (const w of windows) {
    deliveries.push(w);
    const r = rand();
    if (r < 0.1) deliveries.push(w);
    else if (r < 0.2) delayed.push(w);
    else if (r < 0.3) {
      const late = w.recvUs.map(
        (us, i) => us ?? (rand() < 0.5 ? (1_000 + i) * 1000 : undefined),
      );
      delayed.push({ baseExt: w.baseExt, recvUs: late });
    }
    if (delayed.length > 0 && rand() < 0.3) {
      deliveries.push(delayed.shift()!);
    }
  }
  deliveries.push(...delayed);

  return { owned, deliveries, startExt, totalPackets };
}

/** Act: feed one simulated transport into an estimator / adapter. */
function runSimulation(
  seed: number,
  target: {
    onSent: (info: SentInfo) => void;
    onFeedback: (
      feedback: ReturnType<typeof wireTwccFeedback>,
    ) => { extSeq: number; sent: SentInfo; received: boolean }[];
  },
) {
  const sim = simulateTransport(seed);
  for (const info of sim.owned.values()) target.onSent(info);
  const reports: {
    covered: Set<number>;
    out: { extSeq: number; sent: SentInfo; received: boolean }[];
  }[] = [];
  for (const [i, w] of sim.deliveries.entries()) {
    const covered = new Set(w.recvUs.map((_, j) => w.baseExt + j));
    const out = target.onFeedback(
      wireTwccFeedback(w.baseExt, w.recvUs, i & 0xff),
    );
    reports.push({ covered, out });
  }
  return { ...sim, reports };
}

describe("TwccFeedbackAdapter", () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "周回・重複・並べ替え・corrective を混ぜても各送信パケットの受信は高々 1 回 (seed %i)",
    (seed) => {
      // Arrange
      const adapter = new TwccFeedbackAdapter(60_000);

      // Act
      const { owned, reports } = runSimulation(seed, {
        onSent: (info) => adapter.onSent(info),
        onFeedback: (fb) => adapter.onFeedback(fb),
      });

      // Assert: 各 feedback の出力は、その feedback が実際に覆った TSN だけ
      //         （= 最も近い正しい世代）で、送信記録もその TSN のもの
      const receivedCount = new Map<number, number>();
      for (const { covered, out } of reports) {
        for (const p of out) {
          expect(covered.has(p.extSeq)).toBe(true);
          expect(p.sent).toBe(owned.get(p.extSeq));
          if (p.received) {
            receivedCount.set(p.extSeq, (receivedCount.get(p.extSeq) ?? 0) + 1);
          }
        }
      }
      // Assert: 受信として数えた回数は全パケットで 1 回以下
      expect(Math.max(0, ...receivedCount.values())).toBeLessThanOrEqual(1);
      // Assert: 他 sender の TSN は一度も対応づけない
      for (const ext of receivedCount.keys()) {
        expect(owned.has(ext)).toBe(true);
      }
    },
  );

  test("受信確定した packet の再報告は無視し、未受信 packet は後から受信へ訂正できる", () => {
    // Arrange: 100, 101, 102 を送信
    const adapter = new TwccFeedbackAdapter(60_000);
    for (let s = 100; s <= 102; s++) adapter.onSent(twccSentInfo(s, 1000, 0));

    // Act: 100, 102 受信 / 101 未着 → corrective で 101 遅着 + 102 再報告
    const first = adapter.onFeedback(
      wireTwccFeedback(100, [10_000, undefined, 12_000]),
    );
    const corrective = adapter.onFeedback(
      wireTwccFeedback(101, [13_000, 12_000]),
    );

    // Assert: 1 回目は 100 受信 / 101 未着 / 102 受信
    expect(first.map((p) => [p.extSeq, p.received])).toEqual([
      [100, true],
      [101, false],
      [102, true],
    ]);
    // Assert: corrective では 101 だけが受信へ訂正され、102 は再計上しない
    expect(corrective.map((p) => [p.extSeq, p.received])).toEqual([
      [101, true],
    ]);
    expect(adapter.size).toBe(0);
  });

  test("履歴 span は 32768 未満で、同じ 16bit 番号の候補は常に 1 つ", () => {
    // Arrange
    const adapter = new TwccFeedbackAdapter(60_000);

    // Act: 70,000 件を wrap しながら送信
    for (let i = 0; i < 70_000; i++) {
      adapter.onSent(twccSentInfo(i & 0xffff, 100, i * 0.01));
    }

    // Assert: 最新から span 未満だけが残り、16bit 番号は重複しない
    const keys = [...twccHistoryOf(adapter).keys()];
    expect(keys.at(-1)).toBe(69_999);
    expect(keys.at(-1)! - keys[0]).toBe(kTwccFeedbackHistoryMaxSeqSpan - 1);
    expect(new Set(keys.map((k) => k & 0xffff)).size).toBe(keys.length);
  });

  test("最初の feedback は最新送信番号を基準に世代を決める", () => {
    // Arrange: 2 周目の途中から履歴を持つ sender
    const adapter = new TwccFeedbackAdapter(60_000);
    adapter.onSent(twccSentInfo(0x10000 * 2 + 5, 100, 0));

    // Act: 16bit 番号 5 の feedback
    const out = adapter.onFeedback(wireTwccFeedback(5, [1_000]));

    // Assert: 3 世代目 (131077) に対応する
    expect(out.map((p) => p.extSeq)).toEqual([0x10000 * 2 + 5]);
  });

  test("遅れて届いた古い feedback で unwrap の基準が後退しない", () => {
    // Arrange: wrap をまたいで 65530..65545 を送信
    const adapter = new TwccFeedbackAdapter(60_000);
    for (let s = 65530; s <= 65545; s++) {
      adapter.onSent(twccSentInfo(s & 0xffff, 100, 0));
    }

    // Act: wrap 後の feedback → wrap 前の遅延 feedback → wrap 後の続き
    const after = adapter.onFeedback(wireTwccFeedback(0, [1_000, 1_100]));
    const late = adapter.onFeedback(wireTwccFeedback(65530, [900]));
    const next = adapter.onFeedback(wireTwccFeedback(2, [1_200]));

    // Assert: それぞれ正しい世代の extended 番号に対応する
    expect(after.map((p) => p.extSeq)).toEqual([65536, 65537]);
    expect(late.map((p) => p.extSeq)).toEqual([65530]);
    expect(next.map((p) => p.extSeq)).toEqual([65538]);
  });
});

describe("estimator は共通 adapter の出力だけを使う", () => {
  const estimators: [string, () => BandwidthEstimator][] = [
    ["legacy", () => new SenderBandwidthEstimator()],
    ["gcc", () => new GccBandwidthEstimator(300_000)],
  ];

  test.each(estimators)(
    "%s: 周回・重複・corrective を混ぜても受信計上は送信パケットごとに高々 1 回",
    (_name, create) => {
      // Arrange
      const estimator = create();
      const matched = captureMatchedFeedback(estimator);

      // Act
      const { owned } = runSimulation(11, {
        onSent: (info) => estimator.rtpPacketSent(info),
        onFeedback: (fb) => {
          estimator.receiveTWCC(fb);
          return matched.at(-1) ?? [];
        },
      });

      // Assert: estimator に渡った受信報告は送信パケットごとに 1 回以下
      const received = matched.flat().filter((p) => p.received);
      const unique = new Set(received.map((p) => p.extSeq));
      expect(received.length).toBe(unique.size);
      for (const ext of unique) expect(owned.has(ext)).toBe(true);
    },
  );

  test("legacy: corrective feedback の再報告を二重に加算しない", () => {
    // Arrange: レビュー再現。100..102 を送信
    const legacy = new SenderBandwidthEstimator();
    const cumulative = (legacy as any).cumulativeResult;
    const added: number[] = [];
    const addPacket = cumulative.addPacket.bind(cumulative);
    cumulative.addPacket = (size: number, sendMs: number, recvMs: number) => {
      added.push(size);
      addPacket(size, sendMs, recvMs);
    };
    for (let s = 100; s <= 102; s++) {
      legacy.rtpPacketSent(twccSentInfo(s, 1000, Date.now()));
    }

    // Act: 100, 102 受信 / 101 未着 → corrective で 101 遅着 + 102 再報告
    legacy.receiveTWCC(
      syntheticTwccFeedback([
        new PacketResult({
          sequenceNumber: 100,
          received: true,
          receivedAtMs: 10,
        }),
        new PacketResult({ sequenceNumber: 101, received: false }),
        new PacketResult({
          sequenceNumber: 102,
          received: true,
          receivedAtMs: 12,
        }),
      ]),
    );
    legacy.receiveTWCC(
      syntheticTwccFeedback([
        new PacketResult({
          sequenceNumber: 101,
          received: true,
          receivedAtMs: 13,
        }),
        new PacketResult({
          sequenceNumber: 102,
          received: true,
          receivedAtMs: 12,
        }),
      ]),
    );

    // Assert: 3 パケットだけが加算される
    expect(added).toHaveLength(3);
  });
});
