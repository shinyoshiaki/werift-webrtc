import { describe, expect, test } from "vitest";
import {
  SenderBandwidthEstimator,
  TwccFeedbackAdapter,
  kTwccFeedbackHistoryMaxSeqSpan,
} from "../../src";
import {
  PacketResult,
  syntheticTwccFeedback,
  twccHistoryOf,
  twccSentInfo,
  wireTwccFeedback,
} from "./twccTestUtils";

describe("TwccFeedbackAdapter", () => {
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
