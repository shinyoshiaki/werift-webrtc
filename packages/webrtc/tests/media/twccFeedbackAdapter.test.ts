import { describe, expect, test } from "vitest";
import { TwccFeedbackAdapter } from "../../src";
import { twccSentInfo, wireTwccFeedback } from "./twccTestUtils";

// 受信の重複排除・世代対応・履歴の上限は tests/pbt/twcc の性質テストで確かめる。
// ここでは性質テストの生成器が作らない unwrap 基準の境界だけを固定例で残す。
describe("TwccFeedbackAdapter", () => {
  test("最初の feedback は最新送信番号を基準に世代を決める", () => {
    // Arrange: 2 周目の途中から履歴を持つ sender
    const adapter = new TwccFeedbackAdapter(60_000);
    adapter.onSent(twccSentInfo(0x10000 * 2 + 5, 100, 0));

    // Act: 16bit 番号 5 の feedback
    const out = adapter.onFeedback(wireTwccFeedback(5, [1_000]));

    // Assert: 3 世代目 (131077) に対応する
    expect(out.map((p) => p.extSeq)).toEqual([0x10000 * 2 + 5]);
  });

  test("送信確認が 1 件だけ順序外に届いても、0xffff をまたいで全パケットを照合できる", () => {
    // Arrange: RTCRtpSender と同じ拡張 TSN 65500..65560 を、65510 と 65511 だけ逆順に記録する
    const adapter = new TwccFeedbackAdapter(60_000);
    const sent = Array.from({ length: 61 }, (_, i) => 65500 + i);
    const order = [...sent];
    [order[10], order[11]] = [order[11]!, order[10]!];
    for (const seq of order) {
      adapter.onSent(twccSentInfo(seq, 100, 0));
    }

    // Act: 全パケット受信の feedback（16-bit 番号 65500 から 61 件、wrap をまたぐ）
    const out = adapter.onFeedback(
      wireTwccFeedback(
        65500,
        sent.map((_, i) => 1_000 + i * 100),
      ),
    );

    // Assert: 履歴は削られず、すべてが元の拡張番号で受信として照合される
    expect(out.map((p) => p.extSeq)).toEqual(sent);
    expect(out.every((p) => p.received)).toBe(true);
    expect(adapter.latestSentSeq).toBe(65560);
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
