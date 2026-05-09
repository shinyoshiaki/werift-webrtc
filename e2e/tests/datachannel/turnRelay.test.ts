import {
  ensurePeerConnected,
  expectMessage,
  getSelectedRelayCandidatePair,
  getTurnRelayConfig,
  peer,
  sleep,
  waitForDataChannelOpen,
  waitForIceGatheringComplete,
  waitForPeerConnection,
} from "../fixture";

type TurnRelayStats = {
  connectionState: string;
  iceConnectionState: string;
  iceTransports: {
    state: string;
    localCandidateTypes: string[];
    remoteCandidateTypes: string[];
    nominated?: {
      localCandidateType: string;
      remoteCandidateType: string;
      protocolType: string;
      relayTransport?: string;
    };
  }[];
};

describe("datachannel/turn relay", () => {
  test.each([
    {
      name: "udp",
      getUrl: (config: Awaited<ReturnType<typeof getTurnRelayConfig>>) =>
        config.turn.udpUrl,
      relayProtocol: "udp",
    },
    {
      name: "tcp",
      getUrl: (config: Awaited<ReturnType<typeof getTurnRelayConfig>>) =>
        config.turn.tcpUrl,
      relayProtocol: "tcp",
    },
    {
      name: "tls",
      getUrl: (config: Awaited<ReturnType<typeof getTurnRelayConfig>>) =>
        config.turn.tlsUrl,
      relayProtocol: "tls",
    },
  ])(
    "exchanges data over $name TURN relay between Chrome and werift",
    async ({ getUrl, name, relayProtocol }) => {
      // Arrange: ブラウザ側のシグナリング接続と TURN 設定を揃え、relay-only の PeerConnection を作る。
      await ensurePeerConnected();
      await sleep(100);
      const config = await getTurnRelayConfig();
      const pc = new RTCPeerConnection({
        iceServers: [
          {
            urls: getUrl(config),
            username: config.turn.username,
            credential: config.turn.credential,
          },
        ],
        iceTransportPolicy: "relay",
      });
      const channel = pc.createDataChannel("turn-relay");
      const serverInitiatedMessage = expectMessage(
        channel,
        `server-to-browser-${name}`,
        () => {},
      );

      try {
        // Act: Chrome 側で relay 候補の gather を完了させた offer を作り、werift 側へ渡す。
        await pc.setLocalDescription(await pc.createOffer());
        await waitForIceGatheringComplete(pc);
        const answer = await peer.request("datachannel_turn_relay", {
          type: "init",
          payload: {
            offer: pc.localDescription,
            transport: name,
          },
        });
        await pc.setRemoteDescription(answer);
        await Promise.all([
          waitForPeerConnection(pc),
          waitForDataChannelOpen(channel),
        ]);

        // Act: werift 起点の送信を受け取り、TURN relay 経由の逆方向通信が成立していることを確認する。
        await serverInitiatedMessage;

        // Act: Chrome からも送信し、werift 側の応答が返ることを確認する。
        await expectMessage(channel, `browser-to-server-${name}pong`, () => {
          channel.send(`browser-to-server-${name}`);
        });

        const browserStats = await getSelectedRelayCandidatePair(pc);
        const serverStats = (await peer.request("datachannel_turn_relay", {
          type: "stats",
          payload: {},
        })) as TurnRelayStats;

        // Assert: Chrome 側ではローカル候補が relay で、選択された TURN transport が期待どおりであることを確認する。
        expect(browserStats.localCandidateType).toBe("relay");
        expect(browserStats.localRelayProtocol).toBe(relayProtocol);
        expect(browserStats.remoteCandidateType).not.toBe("host");
        expect(browserStats.remoteCandidateType).not.toBe("srflx");

        // Assert: werift 側では nominated pair が TURN protocol を使い、ローカル候補も relay になっていることを確認する。
        expect(serverStats.connectionState).toBe("connected");
        expect(
          serverStats.iceTransports.every((iceTransport) =>
            iceTransport.localCandidateTypes.every(
              (candidateType) => candidateType === "relay",
            ),
          ),
        ).toBe(true);
        expect(
          serverStats.iceTransports.some((iceTransport) => {
            const { nominated } = iceTransport;
            return (
              nominated?.localCandidateType === "relay" &&
              nominated.protocolType === "turn" &&
              nominated.relayTransport === relayProtocol
            );
          }),
        ).toBe(true);
      } finally {
        await peer
          .request("datachannel_turn_relay", {
            type: "close",
            payload: {},
          })
          .catch(() => {});
        pc.close();
      }
    },
  );
});
