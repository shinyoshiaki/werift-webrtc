import { SctpTransportManager } from "../../src/sctpManager";

describe("SctpManager.connectSctp", () => {
  test("start() 前に確立済みの SCTP は connected イベントを待たずに完了する", async () => {
    // Arrange: 既に connected 状態で、connected が二度と発火しない SCTP
    const manager = new SctpTransportManager();
    const ensureStarted = vi.fn(async () => {});
    manager.sctpRemotePort = 5000;
    manager.sctpTransport = {
      ensureStarted,
      sctp: {
        state: "connected",
        stateChanged: { connected: { asPromise: () => new Promise(() => {}) } },
      },
    } as any;

    // Act: 接続待ちを実行する
    const result = await Promise.race([
      manager.connectSctp().then(() => "done"),
      new Promise((r) => setTimeout(() => r("hang"), 200)),
    ]);

    // Assert: 待ち続けずに完了し、開始処理 (ensureStarted) は呼ばれる
    expect(result).toBe("done");
    expect(ensureStarted).toHaveBeenCalledWith(5000);
  });
});
