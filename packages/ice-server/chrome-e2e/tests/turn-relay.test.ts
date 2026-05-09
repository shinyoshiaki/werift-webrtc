import {
  createConnectedPeerPair,
  expectMessage,
  getHarnessConfig,
  getSelectedRelayCandidatePair,
} from "./fixture";

describe("chrome turn relay", () => {
  test("forces relay candidates and exchanges data in both directions", async () => {
    const config = await getHarnessConfig();
    const peerPair = await createConnectedPeerPair({
      iceServers: [
        {
          urls: config.turn.url,
          username: config.turn.username,
          credential: config.turn.credential,
        },
      ],
      iceTransportPolicy: "relay",
    });

    try {
      // Act: relay 強制設定のまま offerer から answerer へデータを流し、TURN 経路で配送されることを確認する。
      await expectMessage(
        peerPair.answererChannel,
        "relay-from-offerer",
        () => {
          peerPair.offererChannel.send("relay-from-offerer");
        },
      );

      // Act: answerer から offerer への逆方向も流し、双方向通信が成立していることを確認する。
      await expectMessage(
        peerPair.offererChannel,
        "relay-from-answerer",
        () => {
          peerPair.answererChannel.send("relay-from-answerer");
        },
      );

      const selectedPair = await getSelectedRelayCandidatePair(
        peerPair.offerer,
      );

      // Assert: 選択された candidate pair が relay/relay で、host や srflx に逃げていないことを確認する。
      expect(selectedPair.localCandidateType).toBe("relay");
      expect(selectedPair.remoteCandidateType).toBe("relay");
    } finally {
      await peerPair.close();
    }
  });
});
