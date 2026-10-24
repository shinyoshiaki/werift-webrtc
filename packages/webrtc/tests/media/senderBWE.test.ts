import { SenderBandwidthEstimator } from "../../src/media/sender/senderBWE";
import { pendingFeedback, recordSentPackets } from "../fixture";

describe("media/sender/senderBWE", () => {
  test("keeps sent packets for feedback only for a bounded time", () => {
    // Arrange: 10 秒前に送った 100 packet。
    const estimator = new SenderBandwidthEstimator();
    const now = Date.now();
    recordSentPackets(estimator, { count: 100, sentAtMs: now - 10_000 });

    // Act: いま 1 packet 送る。
    recordSentPackets(estimator, { count: 1, firstSeq: 100, sentAtMs: now });

    // Assert: feedback を待つ packet は新しいものだけが残る (送った数だけ増えない)。
    expect([...pendingFeedback(estimator).keys()]).toEqual([100]);
  });

  test("keeps recent packets and at most half the sequence space", () => {
    // Arrange / Act: 同じ時刻に、16-bit の sequence を一周以上する数の packet を送る。
    const estimator = new SenderBandwidthEstimator();
    recordSentPackets(estimator, { count: 0x10000 + 10 });

    // Assert: 直近の packet は残り、件数は sequence 空間の半分を超えない。
    const pending = pendingFeedback(estimator);
    expect(pending.size).toBe(0x8000);
    expect(pending.has(9)).toBe(true);
  });
});
