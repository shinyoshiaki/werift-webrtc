import { setTimeout } from "timers/promises";

import {
  DtlsVersion,
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
} from "../../src";
import type { RTCTransportStats } from "../../src/media/stats";
import { exchangeIceCandidates } from "../utils";
import { holdPeerAuthentication } from "./warpArrange";

const earlyServerConfig = () => ({
  iceServers: [],
  sped: true,
  dtls: { protocolVersions: [DtlsVersion.V1_3] },
  warp: { allowEarlyServerData: true, earlyMediaPolicy: "buffer" as const },
});

async function bytesSentOf(pc: RTCPeerConnection) {
  const stats = (await pc.getStats()).values();
  for (const stat of stats) {
    if ((stat as RTCTransportStats).type === "transport") {
      return (stat as RTCTransportStats).bytesSent ?? 0;
    }
  }
  return 0;
}

describe("WARP early server media", () => {
  test("DataChannel のない media-only 接続でも、公開 API だけで認証前の RTP を送出する", async () => {
    // Arrange: offerer が DTLS server になる media-only の SPED 接続。server が
    // client の Finished を処理するのを保留し、0.5-RTT の範囲 (write-ready・
    // client 未認証) に留める。
    const server = new RTCPeerConnection(earlyServerConfig());
    const client = new RTCPeerConnection(earlyServerConfig());
    const track = new MediaStreamTrack({ kind: "audio" });
    let sequenceNumber = 0;
    const pump = setInterval(() => {
      sequenceNumber++;
      track.writeRtp(
        new RtpPacket(
          new RtpHeader({ sequenceNumber, timestamp: sequenceNumber * 960 }),
          Buffer.from("early-media"),
        ).serialize(),
      );
    }, 10);
    let release: (() => void) | undefined;
    try {
      server.addTransceiver(track, { direction: "sendonly" });
      exchangeIceCandidates(server, client);
      await server.setLocalDescription(await server.createOffer());
      await client.setRemoteDescription(server.localDescription!);
      await client.setLocalDescription(await client.createAnswer());
      ({ release } = holdPeerAuthentication(server.dtlsTransports[0]!));

      // Act: answer を適用し、送信用の track が書き続ける RTP の送出を待つ。
      void server.setRemoteDescription(client.localDescription!);
      const deadline = Date.now() + 10_000;
      let sent = 0;
      while (sent === 0 && Date.now() < deadline) {
        await setTimeout(20);
        sent = await bytesSentOf(server);
      }

      // Assert: server は client を認証する前 (connecting) のまま、RTP を送出した。
      expect(server.dtlsTransports[0]!.role).toBe("server");
      expect(server.dtlsTransports[0]!.state).toBe("connecting");
      expect(server.sctpTransport ?? null).toBeNull();
      expect(sent).toBeGreaterThan(0);
    } finally {
      clearInterval(pump);
      release?.();
      await Promise.allSettled([server.close(), client.close()]);
    }
  }, 30_000);
});
