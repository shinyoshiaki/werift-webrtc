import { LiveEdge } from "../../../mediachannel/latency_budget/liveEdge.js";

describe("latency_budget LiveEdge", () => {
  test("upstream が止まっている間も、再送パケットの遅れに実時間の経過を反映する", () => {
    // Arrange: seq 3 が欠落し、seq 4 の受信後に通信が止まる (20ms = 960 ticks)
    const edge = new LiveEdge();
    edge.update(1 * 960, 0);
    edge.update(2 * 960, 20);
    edge.update(4 * 960, 60);

    // Act: 2 秒後、次の新しい RTP より先に seq 3 の再送が届く
    const lag = edge.lagMs(3 * 960, 2060);

    // Assert: 遅れは約 2 秒で、500ms の budget を超える (最新 RTP との差の 20ms ではない)
    expect(lag).toBeGreaterThanOrEqual(2000);
    expect(lag).toBeGreaterThan(500);
  });

  test("新しい RTP が届き続けていれば、直前の再送の遅れは小さい", () => {
    // Arrange
    const edge = new LiveEdge();
    edge.update(1 * 960, 0);
    edge.update(4 * 960, 60);

    // Act: 受信直後に届いた seq 3 の再送
    const lag = edge.lagMs(3 * 960, 61);

    // Assert: 約 21ms
    expect(lag).toBeLessThan(50);
  });

  test("publisher が変わったら reset で timestamp の基準を引き継がない", () => {
    // Arrange
    const edge = new LiveEdge();
    edge.update(1_000_000, 0);

    // Act: 別の基準 (大きく戻った timestamp) の publisher
    edge.reset();
    edge.update(5, 10);

    // Assert: 新しい基準で live edge が動く
    expect(edge.lagMs(5, 10)).toBe(0);
  });
});
