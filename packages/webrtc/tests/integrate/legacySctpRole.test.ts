import { setTimeout } from "timers/promises";

import { collectMessages, connectWithLegacySctpPeer } from "./warpArrange";

/**
 * 旧 werift (SCTP の INIT 送信側を ICE role で決める) と現行 (DTLS role で
 * 決める) の組み合わせ。offerer が ICE controlling なので、answerer が DTLS
 * server になると ICE role と DTLS role の対応がずれる。
 */
describe("旧 werift peer との SCTP 開始側の不一致", () => {
  test.each([
    {
      name: "両端が INIT を送る (現行 DTLS server ↔ 旧 controlling)",
      legacy: "offerer" as const,
      answererRole: "server" as const,
    },
    {
      name: "両端が INIT を待つ (現行 DTLS client ↔ 旧 controlled)",
      legacy: "answerer" as const,
      answererRole: "server" as const,
    },
    {
      name: "role が揃う通常の組み合わせ",
      legacy: "answerer" as const,
      answererRole: "client" as const,
    },
  ])(
    "$name でも DataChannel が開き、双方向に届く",
    async ({ legacy, answererRole }) => {
      // Arrange / Act: 旧 werift を模した peer と接続し、DataChannel が開くのを待つ
      const connection = await Promise.race([
        connectWithLegacySctpPeer({ legacy, answererRole }),
        setTimeout(15_000).then(() => {
          throw new Error("DataChannel did not open");
        }),
      ]);
      const { offerer, answerer, offererChannel, answererChannel } = connection;
      try {
        // Act: 双方向に 1 件ずつ送る
        const toAnswerer = collectMessages(answererChannel, 1);
        const toOfferer = collectMessages(offererChannel, 1);
        offererChannel.send("from-offerer");
        answererChannel.send("from-answerer");

        // Assert: 両方向とも届く
        expect(await toAnswerer).toEqual(["from-offerer"]);
        expect(await toOfferer).toEqual(["from-answerer"]);
        // Assert: SCTP の T1 再送 (初期 RTO 3 秒) を待たずに開く
        expect(connection.openedAfterMs).toBeLessThan(3_000);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    30_000,
  );
});
