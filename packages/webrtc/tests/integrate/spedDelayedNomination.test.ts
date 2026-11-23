import { setTimeout } from "timers/promises";

import { exchangeOfferAnswer } from "../utils";
import { createTcpLoopbackSpedPeers, delayTcpNomination } from "./warpArrange";

describe("SPED over ICE-TCP: nomination が遅れる場合", () => {
  test("nomination が 2 秒 (early queue の保持期限) を超えて遅れても、認証済み pair で handshake を終えて DTLS / DataChannel が接続する", async () => {
    // Arrange: TCP loopback だけで接続する SPED peer。nomination Request だけを 2.5 秒遅らせる
    const nomination = delayTcpNomination(2_500);
    const { peers, channels } = createTcpLoopbackSpedPeers();
    const states = peers.map(() => [] as string[]);
    peers.forEach((pc, i) =>
      pc.connectionStateChange.subscribe((s) => states[i].push(s)),
    );
    try {
      // Act: offer / answer を交換し、遅れた nomination の後まで待つ
      await exchangeOfferAnswer(peers[0], peers[1]);
      const deadline = Date.now() + 15_000;
      while (
        channels.some((c) => c.readyState !== "open") &&
        Date.now() < deadline
      ) {
        await setTimeout(50);
      }
      const arrived = new Promise<string>((resolve) => {
        channels[1].onMessage.subscribe((m) => resolve(m.toString()));
      });
      channels[0].send("after-delayed-nomination");

      // Assert: DTLS は失敗せず connected、両 DataChannel が open で届く
      expect(peers.map((pc) => pc.dtlsTransports[0].state)).toEqual([
        "connected",
        "connected",
      ]);
      expect(channels.map((c) => c.readyState)).toEqual(["open", "open"]);
      expect(await arrived).toBe("after-delayed-nomination");
      for (const s of states) expect(s).not.toContain("failed");
    } finally {
      nomination.restore();
      await Promise.allSettled(peers.map((pc) => pc.close()));
    }
  }, 30_000);
});
