import {
  createConnectedPeerPair,
  expectMessage,
  getHarnessConfig,
  getHarnessMetrics,
  resetHarnessMetrics,
} from "./fixture";

describe("chrome stun", () => {
  test("connects two peers and reaches the STUN server", async () => {
    const config = await getHarnessConfig();
    await resetHarnessMetrics();

    const peerPair = await createConnectedPeerPair({
      iceServers: [{ urls: config.stun.url }],
    });

    try {
      // Act: offerer から answerer へ DataChannel メッセージを送り、同一ページ内の 2 PeerConnection が接続できることを確認する。
      await expectMessage(
        peerPair.answererChannel,
        "hello-from-offerer",
        () => {
          peerPair.offererChannel.send("hello-from-offerer");
        },
      );

      // Act: answerer から offerer へ逆方向でも送信し、双方向通信になっていることを確認する。
      await expectMessage(
        peerPair.offererChannel,
        "hello-from-answerer",
        () => {
          peerPair.answererChannel.send("hello-from-answerer");
        },
      );

      const metrics = await getHarnessMetrics();

      // Assert: Chrome が STUN Binding を実際に投げており、単なる host candidate 接続ではないことを確認する。
      expect(metrics.stunBindingRequests).toBeGreaterThan(0);
    } finally {
      await peerPair.close();
    }
  });
});
