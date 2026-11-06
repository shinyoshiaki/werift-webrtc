import { describe, expect, test } from "vitest";
import { TwccFeedbackAdapter } from "../../src";
import { twccHistoryOf, twccSentInfo, wireTwccFeedback } from "./twccTestUtils";

// 受信の重複排除・世代対応・履歴の上限は tests/pbt/twcc の性質テストで確かめる。
// ここでは性質テストの生成器が作らない unwrap 基準の境界だけを固定例で残す。
describe("TwccFeedbackAdapter", () => {
  test("最初の feedback は最新送信番号を基準に世代を決める", () => {
    // Arrange: 2 周目の途中から履歴を持つ sender
    const adapter = new TwccFeedbackAdapter(60_000);
    adapter.onSent(twccSentInfo(0x10000 * 2 + 5, 100, 0));

    // Act: 16bit 番号 5 の feedback
    const out = adapter.onFeedback(wireTwccFeedback(5, [1_000]), 0);

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
      0,
    );

    // Assert: 履歴は削られず、すべてが元の拡張番号で受信として照合される
    expect(out.map((p) => p.extSeq)).toEqual(sent);
    expect(out.every((p) => p.received)).toBe(true);
    expect(adapter.latestSentSeq).toBe(65560);
  });

  test("最初の周回の境界で 65536 の確認が 65535 より先に届いても、両方を元の番号で照合できる", () => {
    // Arrange: 拡張 TSN 65534, 65536, 65535, 65537 の順で送信確認が届く
    const adapter = new TwccFeedbackAdapter(60_000);
    for (const seq of [65534, 65536, 65535, 65537]) {
      adapter.onSent(twccSentInfo(seq, 100, 0));
    }

    // Act: 16-bit 番号 65534 から 4 件（0 と 1 を含む）の受信 feedback
    const out = adapter.onFeedback(
      wireTwccFeedback(65534, [1_000, 1_100, 1_200, 1_300]),
      0,
    );

    // Assert: 65535 を 131071 と読まず、TSN 0（= 65536）も一致する
    expect(out.map((p) => p.extSeq)).toEqual([65534, 65535, 65536, 65537]);
    expect(adapter.latestSentSeq).toBe(65537);
  });

  test("32768 の後に遅れて 0 の送信確認が届いても、履歴の番号 span は 32768 未満のまま", () => {
    // Arrange: 拡張 TSN 32768 の確認のあとに、0 の確認が遅れて届く
    const adapter = new TwccFeedbackAdapter(60_000);
    adapter.onSent(twccSentInfo(32768, 100, 1_000));

    // Act
    adapter.onSent(twccSentInfo(0, 100, 900));

    // Assert: 0 は span の外なので残らず、16-bit 番号 0 の候補が 2 世代にならない
    const keys = [...historyOf(adapter).keys()];
    expect(keys).toEqual([32768]);
    expect(adapter.onFeedback(wireTwccFeedback(0, [2_000]), 1_000)).toEqual([]);
  });

  test("順序外に届いた古い送信確認も、後ろの新しい項目に隠れず時間窓で削除される", () => {
    // Arrange: 10・11 を確認したあと、9（送信は 10 より前）の確認が遅れて届く
    const adapter = new TwccFeedbackAdapter(10_000);
    adapter.onSent(twccSentInfo(10, 100, 1_000));
    adapter.onSent(twccSentInfo(11, 100, 5_000));
    adapter.onSent(twccSentInfo(9, 100, 500));

    // Act: 9 だけが 10 秒窓の外になる時刻で掃除する（10・11 は窓の中）
    adapter.prune(10_700);

    // Assert: 窓の中の 10 より後ろに挿入された 9 も、挿入順に関係なく消える
    expect([...historyOf(adapter).keys()]).toEqual([10, 11]);
  });

  test("送信完了が時間窓を超えて遅れた送信確認は、履歴に残らず feedback にも対応しない", () => {
    // Arrange: 時間窓 1 秒、送信開始 0ms・送信完了 20,000ms の送信確認
    const adapter = new TwccFeedbackAdapter(1_000);

    // Act: 送信確認を記録し、直後に feedback を照合する
    adapter.onSent(twccSentInfo(5, 100, 0, { sentAtMs: 20_000 }));
    const out = adapter.onFeedback(wireTwccFeedback(5, [20_010_000]), 20_010);

    // Assert: 完了時刻を「現在」とみなすので窓の外。保存も照合もされない
    expect(adapter.size).toBe(0);
    expect(out).toEqual([]);
  });

  test("送信が止まったあとに時間窓を超えて届いた feedback は、古い送信履歴に対応しない", () => {
    // Arrange: 時間窓 10 秒で 1 件送信し、その後は送信しない（onSent による掃除が起きない）
    const adapter = new TwccFeedbackAdapter(10_000);
    adapter.onSent(twccSentInfo(5, 100, 0));

    // Act: 50 秒後に feedback が届く
    const out = adapter.onFeedback(wireTwccFeedback(5, [50_000_000]), 50_000);

    // Assert: 照合の時点で窓の外なので対応しない
    expect(out).toEqual([]);
    expect(adapter.size).toBe(0);
  });

  test("遅れて届いた古い feedback で unwrap の基準が後退しない", () => {
    // Arrange: wrap をまたいで 65530..65545 を送信
    const adapter = new TwccFeedbackAdapter(60_000);
    for (let s = 65530; s <= 65545; s++) {
      adapter.onSent(twccSentInfo(s, 100, 0));
    }

    // Act: wrap 後の feedback → wrap 前の遅延 feedback → wrap 後の続き
    const after = adapter.onFeedback(wireTwccFeedback(0, [1_000, 1_100]), 0);
    const late = adapter.onFeedback(wireTwccFeedback(65530, [900]), 0);
    const next = adapter.onFeedback(wireTwccFeedback(2, [1_200]), 0);

    // Assert: それぞれ正しい世代の extended 番号に対応する
    expect(after.map((p) => p.extSeq)).toEqual([65536, 65537]);
    expect(late.map((p) => p.extSeq)).toEqual([65530]);
    expect(next.map((p) => p.extSeq)).toEqual([65538]);
  });
});

/** Test-only read: the adapter's send history keyed by extended sequence. */
function historyOf(adapter: TwccFeedbackAdapter) {
  return (adapter as unknown as { history: Map<number, unknown> }).history;
}
