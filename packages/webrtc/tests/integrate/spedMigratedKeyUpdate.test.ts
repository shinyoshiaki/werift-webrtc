import { setTimeout } from "timers/promises";

import { prepareMigratingSpedPeers } from "./warpArrange";

describe("SPED: ICE restart で別の 5-tuple へ移る間の KeyUpdate", () => {
  test.each([
    { name: "旧経路の候補は一覧から消える", retainIpv4: false },
    {
      name: "旧経路 (IPv4) の候補が一覧に残るが経路は失われている",
      retainIpv4: true,
    },
  ])(
    "$name: controlling 側の nomination が 2 秒超遅れる間に KeyUpdate しても、ACK が新しい認証済み経路で返り、接続と双方向の DataChannel を保つ",
    async ({ retainIpv4 }) => {
      // Arrange: IPv4 で接続済みの SPED peer
      const peers = await prepareMigratingSpedPeers();
      const { offerer, answerer, channels, iceOf, until } = peers;
      const states = [offerer, answerer].map(() => [] as string[]);
      [offerer, answerer].forEach((pc, i) =>
        pc.connectionStateChange.subscribe((s) => states[i].push(s)),
      );
      try {
        // Act: IPv6 へ restart し (retainIpv4 なら IPv4 候補を残して IPv4 経路を遮断)、
        // controlling 側の nomination 応答の処理を 2.5 秒遅らせる
        await peers.restartOntoIpv6(2_500, { retainIpv4 });
        await until(
          () =>
            iceOf(answerer).canSendApplicationData() &&
            iceOf(answerer).nominated?.remoteAddr[0] === "::1",
          "answerer nominates the IPv6 pair",
        );
        // 前提: offerer はまだ新しい経路を nominate していない
        expect(iceOf(offerer).nominated).toBeUndefined();
        // 前提: retainIpv4 なら旧経路 (DTLS が保持する宛先) の候補が現世代の一覧に残る
        expect(
          iceOf(offerer).checkList.some(
            (pair) => pair.remoteAddr[0] === "127.0.0.1",
          ),
        ).toBe(retainIpv4);

        // Act: その間に answerer (DTLS client) が KeyUpdate を送り、キューの保持期限 (2 秒) を超えて待つ
        await answerer.dtlsTransports[0].dtls!.keyUpdate(false);
        await setTimeout(5_000);
        const arrived = channels.map(
          (c) =>
            new Promise<string>((resolve) =>
              c.onMessage.subscribe((m) => resolve(m.toString())),
            ),
        );
        channels[0].send("from-offerer");
        channels[1].send("from-answerer");

        // Assert: 両 peer が接続を保ち、両 DataChannel が open のまま双方向に届く
        expect([offerer, answerer].map((pc) => pc.connectionState)).toEqual([
          "connected",
          "connected",
        ]);
        expect(channels.map((c) => c.readyState)).toEqual(["open", "open"]);
        expect(await Promise.all(arrived)).toEqual([
          "from-answerer",
          "from-offerer",
        ]);
        for (const s of states) expect(s).not.toContain("failed");
        // Assert: 両側とも新しい IPv6 の経路を使っている
        expect(iceOf(offerer).nominated?.remoteAddr[0]).toBe("::1");
        expect(iceOf(answerer).nominated?.remoteAddr[0]).toBe("::1");
      } finally {
        peers.restore();
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    40_000,
  );
});
