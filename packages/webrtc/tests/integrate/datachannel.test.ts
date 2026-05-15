import { RTCPeerConnection } from "../../src";
import type { RTCStats } from "../../src/media/stats";

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

function hasTcpCandidate(sdp: string) {
  return sdp
    .split(/\r?\n/)
    .some(
      (line) => line.startsWith("a=candidate:") && /\s(?:TCP|tcp)\s/.test(line),
    );
}

async function getSelectedCandidatePair(pc: RTCPeerConnection): Promise<{
  localCandidate?: { protocol?: string; tcpType?: string };
  remoteCandidate?: { protocol?: string; tcpType?: string };
}> {
  const stats = await pc.getStats();
  const values = Array.from(stats.values()) as Array<
    RTCStats & {
      selectedCandidatePairId?: string;
      localCandidateId?: string;
      remoteCandidateId?: string;
      protocol?: string;
      tcpType?: string;
    }
  >;
  const transport = values.find(
    (stat) =>
      stat.type === "transport" &&
      typeof stat.selectedCandidatePairId === "string",
  );
  const pair = transport?.selectedCandidatePairId
    ? values.find((stat) => stat.id === transport.selectedCandidatePairId)
    : undefined;
  const localCandidate = pair?.localCandidateId
    ? values.find((stat) => stat.id === pair.localCandidateId)
    : undefined;
  const remoteCandidate = pair?.remoteCandidateId
    ? values.find((stat) => stat.id === pair.remoteCandidateId)
    : undefined;

  return {
    localCandidate,
    remoteCandidate,
  };
}

describe("datachannel", () => {
  test("send some messages at same time", async () =>
    new Promise<void>(async (done) => {
      const pc1 = new RTCPeerConnection();
      const pc2 = new RTCPeerConnection();

      pc2.onDataChannel.subscribe((channel) => {
        Promise.all([
          channel.onMessage.watch((v) => v === "1"),
          channel.onMessage.watch((v) => v === "2"),
          channel.onMessage.watch((v) => v === "3"),
        ]).then(async () => {
          await pc1.close();
          await pc2.close();
          done();
        });
      });

      const channel = pc1.createDataChannel("dc");
      channel.onopen = () => {
        channel.send("1");
        channel.send("2");
        channel.send("3");
      };

      await pc1.setLocalDescription(await pc1.createOffer());

      await pc2.setRemoteDescription(pc1.localDescription!);
      await pc2.setLocalDescription(await pc2.createAnswer());
      await pc1.setRemoteDescription(pc2.localDescription!);
    }));

  test("sends messages over ICE-TCP", async () => {
    const config = {
      iceServers: [],
      iceUseIpv6: false,
      iceUseTcp: true,
    };
    const pc1 = new RTCPeerConnection(config);
    const pc2 = new RTCPeerConnection(config);

    try {
      const messageReceived = new Promise<void>((resolve) => {
        pc2.onDataChannel.subscribe((channel) => {
          channel.onMessage
            .watch((message) => message === "tcp-message")
            .then(() => resolve());
        });
      });

      const channel = pc1.createDataChannel("dc");
      channel.onopen = () => {
        channel.send("tcp-message");
      };

      // Act: offer/answer で TCP candidate のみを相互に適用する。
      await pc1.setLocalDescription(await pc1.createOffer());
      expect(hasTcpCandidate(pc1.localDescription!.sdp)).toBe(true);
      await pc2.setRemoteDescription({
        type: "offer",
        sdp: filterSdpToTcp(pc1.localDescription!.sdp),
      });

      await pc2.setLocalDescription(await pc2.createAnswer());
      expect(hasTcpCandidate(pc2.localDescription!.sdp)).toBe(true);
      await pc1.setRemoteDescription({
        type: "answer",
        sdp: filterSdpToTcp(pc2.localDescription!.sdp),
      });

      await messageReceived;

      const [pc1Selected, pc2Selected] = await Promise.all([
        getSelectedCandidatePair(pc1),
        getSelectedCandidatePair(pc2),
      ]);

      // Assert: 双方向通信が成功し、選択された candidate pair が TCP である。
      expect(pc1Selected.localCandidate?.protocol).toBe("tcp");
      expect(pc1Selected.localCandidate?.tcpType).toBe("active");
      expect(pc1Selected.remoteCandidate?.protocol).toBe("tcp");
      expect(pc2Selected.localCandidate?.protocol).toBe("tcp");
      expect(pc2Selected.remoteCandidate?.protocol).toBe("tcp");
    } finally {
      await pc1.close();
      await pc2.close();
    }
  });
});
