import { setTimeout } from "timers/promises";

import { DtlsVersion, RTCPeerConnection } from "../../src";
import { exchangeIceCandidates } from "../utils";
import {
  coreHandshakeComplete,
  holdApplicationPath,
  queuedSpedSendsOf,
} from "./warpArrange";

describe("SPED final ACK", () => {
  test("nomination を保留しても、server の handshake 完了は最終 ACK が実際に送られた後で、相手も完了する", async () => {
    // Arrange: SPED / DTLS 1.3 の接続で、両端の ICE を application data を送れない
    // 状態 (nomination 未完了) に保留する。
    const config = {
      iceServers: [],
      sped: true,
      dtls: { protocolVersions: [DtlsVersion.V1_3] },
    };
    const offerer = new RTCPeerConnection(config);
    const answerer = new RTCPeerConnection(config);
    offerer.addTransceiver("audio");
    const holds: { release: () => void }[] = [];
    try {
      exchangeIceCandidates(offerer, answerer);
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      holds.push(holdApplicationPath(offerer), holdApplicationPath(answerer));
      await answerer.setLocalDescription(await answerer.createAnswer());
      const [server, client] = [
        offerer.dtlsTransports[0]!,
        answerer.dtlsTransports[0]!,
      ].sort((x) => (x.role === "server" ? -1 : 1));

      // Act: answer を適用し、server の handshake 完了を待つ。
      const applied = offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.race([
        server.waitForHandshakeComplete(),
        setTimeout(10_000).then(() => {
          throw new Error("server handshake did not complete");
        }),
      ]);

      // Assert: 完了した時点で最終 ACK は送信キューに残っていない。
      expect(server.role).toBe("server");
      expect(queuedSpedSendsOf(server)).toBe(0);
      // Assert: nomination の保留中でも、ACK を受け取った相手 (client) も完了する。
      const deadline = Date.now() + 5_000;
      while (!coreHandshakeComplete(client) && Date.now() < deadline) {
        await setTimeout(20);
      }
      expect(coreHandshakeComplete(client)).toBe(true);
      await applied;
    } finally {
      for (const hold of holds) hold.release();
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 30_000);
});
