import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { RTCPeerConnection } from "../../src";
import { connectAcrossBuilds, resolveLegacyWeriftRelease } from "./warpArrange";

/**
 * 公開済みの旧 werift (既定 0.26.0。SCTP の INIT 送信側を ICE role で決め、
 * initiator は INIT / COOKIE_ECHO を無視する) と現行 werift の相互接続。
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

describeLegacy("公開済み旧 werift との相互接続 (SCTP 開始側)", () => {
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
});
