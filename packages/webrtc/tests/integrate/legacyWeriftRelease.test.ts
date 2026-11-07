import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { DtlsVersion, RTCPeerConnection } from "../../src";
import {
  connectAcrossBuilds,
  iceTcpOnlyConfig,
  legacyRoleCombos,
  openChannelsFromBothSides,
  resolveLegacyWeriftRelease,
  sendBothWays,
  transportStatsOf,
} from "./warpArrange";

/**
 * 公開済みの旧 werift (既定 0.26.0: DTLS 1.2 のみ・SPED 非対応。SCTP の INIT
 * 送信側と stream ID の parity を ICE role で決め、initiator は INIT /
 * COOKIE_ECHO を無視する) と現行 werift の相互接続。SCTP 開始側、DTLS 1.3 /
 * SPED を提示する現行側の DTLS 1.2 への fallback、ICE-TCP、両側からの in-band
 * DataChannel を確認する。調査の記録は reviews/legacy-werift-compatibility.md。
 * opt-in: `npm run test:legacy-werift` (WERIFT_LEGACY_RELEASE か
 * WERIFT_LEGACY_RELEASE_AUTO_INSTALL=1)。未指定の `npm test` では skip する。
 */
const release = resolveLegacyWeriftRelease();
if (!release && process.env.WERIFT_LEGACY_RELEASE_REQUIRED === "1") {
  throw new Error(
    "set WERIFT_LEGACY_RELEASE or WERIFT_LEGACY_RELEASE_AUTO_INSTALL=1",
  );
}
const describeLegacy = release ? describe : describe.skip;

describeLegacy("公開済み旧 werift との相互接続", () => {
  let Legacy: { RTCPeerConnection: new (config?: object) => any };
  afterAll(() => release!.cleanup());
  beforeAll(async () => {
    // Arrange: 旧 werift の公開 API を読み込む
    const manifest = JSON.parse(
      readFileSync(join(release!.dir, "package.json"), "utf8"),
    ) as { main: string };
    Legacy = await import(
      pathToFileURL(join(release!.dir, manifest.main)).href
    );
  });

  test.each([
    {
      name: "旧 offerer (ICE controlling) × 現行 answerer DTLS server: 両端が INIT を送る",
      legacy: "offerer" as const,
      answererRole: "server" as const,
    },
    {
      name: "現行 offerer DTLS client × 旧 answerer (ICE controlled) DTLS server: 両端が INIT を待つ",
      legacy: "answerer" as const,
      answererRole: "server" as const,
    },
    {
      name: "旧 ICE-lite offerer (ICE controlled) DTLS server × 現行 answerer (ICE controlling) DTLS client: 両端が INIT を待つ",
      legacy: "offerer" as const,
      answererRole: "client" as const,
      legacyIceLite: true,
    },
    {
      name: "旧 offerer × 現行 answerer DTLS client: role が揃う",
      legacy: "offerer" as const,
      answererRole: "client" as const,
    },
    {
      name: "現行 offerer × 旧 answerer DTLS client: role が揃う",
      legacy: "answerer" as const,
      answererRole: "client" as const,
    },
  ] as {
    name: string;
    legacy: "offerer" | "answerer";
    answererRole: "client" | "server";
    legacyIceLite?: boolean;
  }[])(
    "$name でも DataChannel が開き、双方向に届く",
    async ({ legacy, answererRole, legacyIceLite = false }) => {
      // Arrange: 一方を旧 werift、他方を現行 werift で作る
      const legacyPc = new Legacy.RTCPeerConnection({
        iceServers: [],
        iceLite: legacyIceLite,
      });
      const currentPc = new RTCPeerConnection({ iceServers: [] });
      const [offerer, answerer] =
        legacy === "offerer" ? [legacyPc, currentPc] : [currentPc, legacyPc];
      try {
        // Act: plain な SDP / candidate だけで接続し、双方向に送る
        const { offererChannel, answererChannel, openedAfterMs } =
          await connectAcrossBuilds({ offerer, answerer, answererRole });
        const received = (channel: any) =>
          new Promise<string>((resolve) => {
            channel.onMessage.subscribe((message: string | Buffer) =>
              resolve(message.toString()),
            );
          });
        const toAnswerer = received(answererChannel);
        const toOfferer = received(offererChannel);
        offererChannel.send("from-offerer");
        answererChannel.send("from-answerer");

        // Assert: 両方向に届き、SCTP T1 再送 (初期 RTO 3 秒) を待たずに開く
        expect(await toAnswerer).toBe("from-offerer");
        expect(await toOfferer).toBe("from-answerer");
        expect(openedAfterMs).toBeLessThan(3_000);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    30_000,
  );

  test.each(
    legacyRoleCombos().flatMap((combo) =>
      [false, true].map((sped) => ({ ...combo, sped })),
    ),
  )(
    "$name, 現行が DTLS [1.3, 1.2] (sped: $sped): 旧 werift (1.2 のみ・SPED 非対応) とは DTLS 1.2 で接続し、双方向に届く",
    async ({ legacy, answererRole, sped }) => {
      // Arrange: 現行側だけ DTLS 1.3 と 1.2 を提示し、sped なら SPED も有効にする
      const legacyPc = new Legacy.RTCPeerConnection({ iceServers: [] });
      const currentPc = new RTCPeerConnection({
        iceServers: [],
        sped,
        dtls: { protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2] },
      });
      const [offerer, answerer] =
        legacy === "offerer" ? [legacyPc, currentPc] : [currentPc, legacyPc];
      try {
        // Act: 接続して双方向に送る
        const { offererChannel, answererChannel } = await connectAcrossBuilds({
          offerer,
          answerer,
          answererRole,
        });
        const arrived = await sendBothWays(offererChannel, answererChannel);

        // Assert: 両方向に届き、現行側は DTLS 1.2 (SPED は direct DTLS へ fallback)
        expect(arrived).toEqual(["from-offerer", "from-answerer"]);
        const stats = await transportStatsOf(currentPc);
        expect(stats.tlsVersion).toBe("DTLS 1.2");
        expect(stats.warpSpedState).toBe(sped ? "fallback" : "disabled");
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    30_000,
  );

  test.each(legacyRoleCombos())(
    "$name, ICE-TCP のみ: DataChannel が開き、双方向に届く",
    async ({ legacy, answererRole }) => {
      // Arrange: 両者とも ICE-TCP の candidate pair だけを使う
      const legacyPc = new Legacy.RTCPeerConnection({
        iceServers: [],
        ...iceTcpOnlyConfig(),
      });
      const currentPc = new RTCPeerConnection({
        iceServers: [],
        ...iceTcpOnlyConfig(),
      });
      const [offerer, answerer] =
        legacy === "offerer" ? [legacyPc, currentPc] : [currentPc, legacyPc];
      try {
        // Act: 接続して双方向に送る
        const { offererChannel, answererChannel } = await connectAcrossBuilds({
          offerer,
          answerer,
          answererRole,
        });
        const arrived = await sendBothWays(offererChannel, answererChannel);

        // Assert: 両方向に届く
        expect(arrived).toEqual(["from-offerer", "from-answerer"]);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    30_000,
  );

  test.each(legacyRoleCombos())(
    "$name: 接続後に両側から同時に in-band DataChannel を開いても stream ID が衝突せず、label どおりに届く",
    async ({ legacy, answererRole }) => {
      // Arrange: 旧 werift と現行 werift を接続する
      const legacyPc = new Legacy.RTCPeerConnection({ iceServers: [] });
      const currentPc = new RTCPeerConnection({ iceServers: [] });
      const [offerer, answerer] =
        legacy === "offerer" ? [legacyPc, currentPc] : [currentPc, legacyPc];
      try {
        await connectAcrossBuilds({ offerer, answerer, answererRole });

        // Act: 両側から同時に DataChannel を開き、それぞれで 1 件送る
        const pairs = await openChannelsFromBothSides(offerer, answerer);
        const arrived = pairs.map(
          ([, remote]) =>
            new Promise<string>((resolve) =>
              remote.onMessage.subscribe((m: string | Buffer) =>
                resolve(m.toString()),
              ),
            ),
        );
        pairs.forEach(([local]) => local.send(`via-${local.label}`));

        // Assert: 相手側に同じ label・同じ ID で現れ、両方向とも届く
        for (const [local, remote] of pairs) {
          expect(remote.label).toBe(local.label);
          expect(remote.id).toBe(local.id);
        }
        expect(await Promise.all(arrived)).toEqual([
          "via-from-offerer",
          "via-from-answerer",
        ]);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    30_000,
  );
});
