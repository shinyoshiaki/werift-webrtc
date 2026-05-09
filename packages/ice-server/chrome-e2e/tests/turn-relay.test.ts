import {
  createConnectedPeerPair,
  expectMessage,
  getHarnessConfig,
  getSelectedRelayCandidatePair,
} from "./fixture";

describe("chrome turn relay", () => {
  test.each([
    {
      name: "udp",
      getUrl: (config: Awaited<ReturnType<typeof getHarnessConfig>>) =>
        config.turn.udpUrl,
      relayProtocol: "udp",
    },
    {
      name: "tcp",
      getUrl: (config: Awaited<ReturnType<typeof getHarnessConfig>>) =>
        config.turn.tcpUrl,
      relayProtocol: "tcp",
    },
  ])(
    "forces relay candidates and exchanges data in both directions over $name TURN transport",
    async ({ getUrl, relayProtocol }) => {
      const config = await getHarnessConfig();
      const peerPair = await createConnectedPeerPair({
        iceServers: [
          {
            urls: getUrl(config),
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
          `relay-from-offerer-${relayProtocol}`,
          () => {
            peerPair.offererChannel.send(`relay-from-offerer-${relayProtocol}`);
          },
        );

        // Act: answerer から offerer への逆方向も流し、双方向通信が成立していることを確認する。
        await expectMessage(
          peerPair.offererChannel,
          `relay-from-answerer-${relayProtocol}`,
          () => {
            peerPair.answererChannel.send(`relay-from-answerer-${relayProtocol}`);
          },
        );

        const selectedPair = await getSelectedRelayCandidatePair(
          peerPair.offerer,
        );

        // Assert: 選択された candidate pair が relay/relay で、TURN サーバ接続も指定 transport を使っていることを確認する。
        expect(selectedPair.localCandidateType).toBe("relay");
        expect(selectedPair.remoteCandidateType).toBe("relay");
        expect(selectedPair.localRelayProtocol).toBe(relayProtocol);
      } finally {
        await peerPair.close();
      }
    },
  );
});
