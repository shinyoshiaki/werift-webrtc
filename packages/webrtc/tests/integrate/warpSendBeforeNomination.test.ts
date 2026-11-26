import { setTimeout } from "timers/promises";

import { DtlsVersion, RTCPeerConnection, RtpHeader } from "../../src";
import {
  collectMessages,
  connectWithHeldClientNomination,
  transportStatsOf,
} from "./warpArrange";

/**
 * WARP `warp.sendBeforeNomination`: the DTLS client sends application data
 * and media right after its Finished on a valid pair (RFC 8445 §12.1, SPED
 * draft-00 §3.1.2.2) instead of waiting for ICE nomination. The client's
 * nomination is held, so only the opt-in can open the DataChannel.
 */
describe("WARP sendBeforeNomination", () => {
  test("opt-in: client の nomination 前に SCTP / DataChannel が開き、双方向の message と client からの RTP が届く", async () => {
    // Arrange: client (DTLS client / ICE controlled) の nomination を保留した SPED 接続
    const peers = await connectWithHeldClientNomination(true);
    const { server, client, serverChannel } = peers;
    try {
      // Act: client が pair を選ばないまま DataChannel が両側で開くのを待つ
      const deadline = Date.now() + 10_000;
      while (
        !(
          serverChannel.readyState === "open" &&
          peers.clientChannel()?.readyState === "open"
        )
      ) {
        if (Date.now() > deadline) throw new Error("DataChannel did not open");
        await setTimeout(10);
      }
      const clientChannel = peers.clientChannel()!;
      const toServer = collectMessages(serverChannel, 1);
      const toClient = collectMessages(clientChannel, 1);
      clientChannel.send("client-before-nomination");
      serverChannel.send("server-reply");
      // Act: client の DTLS transport から RTP を 1 件送る
      const serverRtp = new Promise<number>((resolve) => {
        server.dtlsTransports[0].onRtp.subscribe((rtp) =>
          resolve(rtp.header.sequenceNumber),
        );
      });
      const sentRtp = await client.dtlsTransports[0].sendRtp(
        Buffer.from("rtp-before-nomination"),
        new RtpHeader({ sequenceNumber: 4242, ssrc: 0x4242, payloadType: 111 }),
      );

      // Assert: 両方向の message と client の RTP が届き、その間 client は pair を選んでいない
      expect(await toServer).toEqual(["client-before-nomination"]);
      expect(await toClient).toEqual(["server-reply"]);
      expect(sentRtp).toBeGreaterThan(0);
      expect(await serverRtp).toBe(4242);
      expect(peers.clientUnselected()).toBe(true);
      // Assert: client の stats に nomination 前の送信が記録される
      expect((await transportStatsOf(client)).warpPreNominationSendUsed).toBe(
        true,
      );
    } finally {
      peers.hold.release();
      await Promise.allSettled([server.close(), client.close()]);
    }
  }, 30_000);

  test("比較: opt-in しなければ、client の nomination を保留している間は DataChannel が開かない", async () => {
    // Arrange: opt-in なしで同じく client の nomination を保留する
    const peers = await connectWithHeldClientNomination(false);
    const { server, client, serverChannel } = peers;
    try {
      // Act: client の DTLS 接続後、しばらく待つ
      const deadline = Date.now() + 10_000;
      while (client.dtlsTransports[0].state !== "connected") {
        if (Date.now() > deadline) throw new Error("DTLS did not connect");
        await setTimeout(10);
      }
      await setTimeout(1_000);

      // Assert: client の SCTP 応答が nomination を待つので server 側の DataChannel は開かない
      expect(peers.clientUnselected()).toBe(true);
      expect(serverChannel.readyState).not.toBe("open");
      expect((await transportStatsOf(client)).warpPreNominationSendUsed).toBe(
        false,
      );
    } finally {
      peers.hold.release();
      await Promise.allSettled([server.close(), client.close()]);
    }
  }, 30_000);

  test("setConfiguration で既存の transport に反映され、sped なしでは同期的に throw する", async () => {
    // Arrange: sped の PeerConnection と transport
    const pc = new RTCPeerConnection({
      iceServers: [],
      sped: true,
      dtls: { protocolVersions: [DtlsVersion.V1_3] },
    });
    try {
      pc.createDataChannel("config");
      const transport = pc.dtlsTransports[0];

      // Act: sendBeforeNomination だけを有効にする
      pc.setConfiguration({ warp: { sendBeforeNomination: true } });

      // Assert: 公開設定と既存 transport の両方に反映され、他の WARP 設定は保たれる
      expect(pc.getConfiguration().warp).toEqual({
        allowEarlyServerData: false,
        earlyMediaPolicy: "drop",
        sendBeforeNomination: true,
      });
      expect(transport.config.warp?.sendBeforeNomination).toBe(true);
    } finally {
      await pc.close();
    }

    // Act / Assert: sped なしの opt-in は constructor で同期的に拒否される
    expect(
      () =>
        new RTCPeerConnection({
          iceServers: [],
          warp: { sendBeforeNomination: true },
        }),
    ).toThrow("warp.sendBeforeNomination requires PeerConfig.sped");
  });
});
