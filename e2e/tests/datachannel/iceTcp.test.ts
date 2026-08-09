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

type IceTcpStats = {
  connectionState: string;
  iceConnectionState: string;
  iceTransports: {
    state: string;
    localCandidateTypes: string[];
    remoteCandidateTypes: string[];
    nominated?: {
      localCandidateType: string;
      localCandidateTransport: string;
      localTcpType?: string;
      remoteCandidateType: string;
      remoteCandidateTransport: string;
      remoteTcpType?: string;
      protocolType: string;
    };
  }[];
};

function filterSdpToTcp(sdp: string) {
  return sdp
    .split(/\r?\n/)
    .filter((line) => {
      if (line.startsWith("a=candidate:")) {
        return /\s(?:TCP|tcp)\s/.test(line);
      }
      return true;
    })
    .join("\r\n");
}

function getDirectTcpCandidateLines(sdp: string) {
  return sdp
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.startsWith("a=candidate:") &&
        /\s(?:TCP|tcp)\s/.test(line) &&
        !/\styp relay\b/i.test(line),
    );
}

function addSyntheticActiveTcpCandidate(sdp: string) {
  const syntheticCandidate =
    "a=candidate:1 1 tcp 1518280447 0.0.0.0 9 typ host tcptype active generation 0";
  return sdp
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line === "a=end-of-candidates") {
        return [syntheticCandidate, line];
      }
      return [line];
    })
    .join("\r\n");
}

async function hasDirectTcpAllocation(pc: RTCPeerConnection) {
  const stats = (await pc.getStats()) as unknown as Map<string, RTCStats>;
  return Array.from(stats.values()).some(
    (stat) =>
      stat.type === "local-candidate" &&
      (stat as any).candidateType === "host" &&
      (stat as any).protocol === "tcp" &&
      (stat as any).tcpType === "active",
  );
}

async function requestWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

describe("datachannel/ice tcp", () => {
  // Full CI (type/build/test:small → e2e) leaves less headroom than a standalone
  // run. Keep the vitest timeout above gathering (30s) + connect (45s) + messages.
  test("exchanges data over direct ICE-TCP between Chrome and werift", async ({
    skip,
  }: { skip: (message?: string) => void }) => {
    // Arrange: Chrome 側で candidate gathering を完了させ、direct TCP 経路の有無を確認する。
    await ensurePeerConnected();
    // turnRelay と同様、シグナリング接続直後の競合を避ける
    await sleep(100);
    const pc = new RTCPeerConnection({
      iceServers: [],
    });
    const channel = pc.createDataChannel("ice-tcp");

    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIceGatheringComplete(pc, 30_000);

      const directTcpCandidates = getDirectTcpCandidateLines(
        pc.localDescription?.sdp ?? "",
      );
      const hasHiddenTcpAllocation = await hasDirectTcpAllocation(pc);
      const hasTcpAllocation =
        directTcpCandidates.length > 0 || hasHiddenTcpAllocation;
      if (!hasTcpAllocation) {
        skip(
          "Chromium does not provide direct ICE-TCP candidates in this environment",
        );
        return;
      }

      // Act: werift 側の passive TCP answer に対して、Chrome の active TCP check で DataChannel を開通させる。
      // Prefer real SDP TCP candidates; synthetic 0.0.0.0:9 is only a last resort
      // when Chromium allocates TCP but omits host lines from the local description.
      const tcpOnlyOfferSdp =
        directTcpCandidates.length > 0
          ? filterSdpToTcp(pc.localDescription!.sdp)
          : addSyntheticActiveTcpCandidate(
              filterSdpToTcp(pc.localDescription!.sdp),
            );
      const answer = await requestWithTimeout(
        peer.request("datachannel_ice_tcp", {
          type: "init",
          payload: {
            offer: {
              type: pc.localDescription!.type,
              sdp: tcpOnlyOfferSdp,
            },
          },
        }),
        30_000,
        "datachannel_ice_tcp init",
      );
      await pc.setRemoteDescription(answer);
      // 接続失敗は skip に変換しない（回帰を silence しない）
      await Promise.all([
        waitForPeerConnection(pc, 45_000),
        waitForDataChannelOpen(channel, 45_000),
      ]);

      await expectMessage(channel, "server-to-browser-ice-tcp", () => {});
      await expectMessage(channel, "browser-to-server-ice-tcppong", () => {
        channel.send("browser-to-server-ice-tcp");
      });

      const browserStats = await getSelectedRelayCandidatePair(pc);
      const serverStats = (await peer.request("datachannel_ice_tcp", {
        type: "stats",
        payload: {},
      })) as IceTcpStats;

      // Assert: browser / werift の両方で selected pair が TCP になっている。
      expect(browserStats.localCandidateProtocol).toBe("tcp");
      expect(browserStats.remoteCandidateProtocol).toBe("tcp");
      expect(browserStats.localCandidateTcpType).toBeDefined();
      expect(serverStats.connectionState).toBe("connected");
      expect(
        serverStats.iceTransports.some((iceTransport) => {
          const { nominated } = iceTransport;
          return (
            nominated?.protocolType === "tcp" &&
            nominated.localCandidateTransport === "tcp" &&
            nominated.remoteCandidateTransport === "tcp"
          );
        }),
      ).toBe(true);
    } finally {
      await peer
        .request("datachannel_ice_tcp", {
          type: "close",
          payload: {},
        })
        .catch(() => {});
      pc.close();
    }
  }, 120_000);
});
