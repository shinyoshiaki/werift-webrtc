import {
  ensurePeerConnected,
  expectMessage,
  getPeerConnectionDiagnostics,
  getSelectedRelayCandidatePair,
  peer,
  sleep,
  waitForDataChannelOpen,
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
    const channel = pc.createDataChannel("dc");
    let answerSdp: string | undefined;
    pc.onicecandidate = ({ candidate }) => {
      peer
        .request("datachannel_ice_lite_answer", {
          type: "candidate",
          payload: candidate,
        })
        .catch(() => {});
    };

    try {
      // Act: Chrome 側の offer を送り、werift ICE lite 側の answer を受け取る。
      await pc.setLocalDescription(await pc.createOffer());
      const answer = await peer.request("datachannel_ice_lite_answer", {
        type: "init",
        payload: pc.localDescription,
      });
      answerSdp = answer.sdp;
      expect(answer.sdp).toContain("a=ice-lite");
      expect(answer.sdp).not.toContain("typ srflx");
      expect(answer.sdp).not.toContain("typ relay");

      await pc.setRemoteDescription(answer);
      await waitForDataChannelOpen(channel);

      // Assert: browser -> werift -> browser の往復で双方向の DataChannel 通信が成立する。
      await expectMessage(channel, "browser-to-server-ice-litepong", () => {
        channel.send("browser-to-server-ice-lite");
      });

      const browserStats = await getSelectedRelayCandidatePair(pc);
      const serverStats = (await peer.request("datachannel_ice_lite_answer", {
        type: "stats",
        payload: {},
      })) as IceLiteStats;

      // Assert: ICE lite 側は host candidate のみを広告し、controlled role で nominated pair を確定している。
      expect(["host", "prflx"]).toContain(browserStats.localCandidateType);
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
            ["host", "prflx"].includes(nominated?.remoteCandidateType ?? "")
          );
        }),
      ).toBe(true);
    } catch (error) {
      // Assert: タイムアウトや接続失敗時に selected pair と answer SDP の候補行を残して原因を追えるようにする。
      const browserDiagnostics = await getPeerConnectionDiagnostics(pc);
      const serverDiagnostics = await peer
        .request("datachannel_ice_lite_answer", {
          type: "stats",
          payload: {},
        })
        .catch(() => undefined);
      const answerCandidateLines =
        answerSdp
          ?.split(/\r?\n/)
          .filter(
            (line) =>
              line.startsWith("a=candidate:") || line === "a=end-of-candidates",
          ) ?? [];

      throw new Error(
        `ICE lite e2e diagnostics:\n${JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
            browserDiagnostics,
            answerCandidateLines,
            serverDiagnostics,
          },
          null,
          2,
        )}`,
      );
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
