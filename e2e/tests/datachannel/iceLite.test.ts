import {
  ensurePeerConnected,
  expectMessage,
  getSelectedRelayCandidatePair,
  peer,
  sleep,
  waitForDataChannelOpen,
  waitForIceGatheringComplete,
  waitForPeerConnection,
} from "../fixture";

type IceLiteStats = {
  localDescriptionSdp?: string;
  connectionState: string;
  iceConnectionState: string;
  iceTransports: {
    iceLite: boolean;
    iceRole: string;
    localCandidateTypes: string[];
    remoteCandidateTypes: string[];
    nominated?: {
      localCandidateType: string;
      remoteCandidateType: string;
      protocolType: string;
    };
  }[];
};

describe("datachannel/ice lite", () => {
  test("exchanges data between Chrome and werift ICE lite", async () => {
    // Arrange: Chrome 側のシグナリング接続を用意し、host candidate のみを使う PeerConnection を作る。
    await ensurePeerConnected();
    await sleep(100);
    const pc = new RTCPeerConnection({
      iceServers: [],
    });
    const channelPromise = new Promise<RTCDataChannel>((resolve) => {
      pc.ondatachannel = ({ channel }) => {
        resolve(channel);
      };
    });
    const serverInitiatedMessage = channelPromise.then(
      (channel) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            channel.removeEventListener("message", handleMessage);
            reject(new Error("timed out waiting for ICE lite server message"));
          }, 20_000);

          const handleMessage = (event: MessageEvent<string>) => {
            clearTimeout(timer);
            channel.removeEventListener("message", handleMessage);
            resolve(event.data);
          };

          channel.addEventListener("message", handleMessage, { once: true });
        }),
    );

    try {
      // Act: werift ICE lite 側の offer を受け取り、Chrome 側の answer を返す。
      const offer = await peer.request("datachannel_ice_lite_answer", {
        type: "init",
        payload: {},
      });
      expect(offer.sdp).toContain("a=ice-lite");
      expect(offer.sdp).not.toContain("typ srflx");
      expect(offer.sdp).not.toContain("typ relay");

      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIceGatheringComplete(pc);
      await peer.request("datachannel_ice_lite_answer", {
        type: "answer",
        payload: pc.localDescription,
      });

      const channel = await channelPromise;
      await Promise.all([
        waitForPeerConnection(pc),
        waitForDataChannelOpen(channel),
      ]);

      // Assert: werift からの初回送信を受け取れ、双方向の DataChannel 通信が成立する。
      expect(await serverInitiatedMessage).toBe("server-to-browser-ice-lite");
      await expectMessage(channel, "browser-to-server-ice-litepong", () => {
        channel.send("browser-to-server-ice-lite");
      });

      const browserStats = await getSelectedRelayCandidatePair(pc);
      const serverStats = (await peer.request("datachannel_ice_lite_answer", {
        type: "stats",
        payload: {},
      })) as IceLiteStats;

      // Assert: ICE lite 側は host candidate のみを広告し、controlled role で nominated pair を確定している。
      expect(browserStats.localCandidateType).toBe("host");
      expect(browserStats.remoteCandidateType).toBe("host");
      expect(serverStats.localDescriptionSdp).toContain("a=ice-lite");
      expect(
        serverStats.iceTransports.every((iceTransport) => iceTransport.iceLite),
      ).toBe(true);
      expect(
        serverStats.iceTransports.every(
          (iceTransport) => iceTransport.iceRole === "controlled",
        ),
      ).toBe(true);
      expect(
        serverStats.iceTransports.every((iceTransport) =>
          iceTransport.localCandidateTypes.every(
            (candidateType) => candidateType === "host",
          ),
        ),
      ).toBe(true);
      expect(
        serverStats.iceTransports.some((iceTransport) => {
          const { nominated } = iceTransport;
          return (
            nominated?.localCandidateType === "host" &&
            nominated?.remoteCandidateType === "host" &&
            nominated?.protocolType === "stun"
          );
        }),
      ).toBe(true);
    } finally {
      await peer
        .request("datachannel_ice_lite_answer", {
          type: "close",
          payload: {},
        })
        .catch(() => {});
      pc.close();
    }
  });
});
