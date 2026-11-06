import { setTimeout } from "timers/promises";

import type { Connection } from "../../../ice/src";
import {
  connectionMatrixCases,
  connectMatrixCase,
  sendInOrder,
  transportStatsOf,
} from "./warpArrange";

/**
 * チケット §5「接続・fallback・restart」: 2 つの実 RTCPeerConnection で
 * setup:active / setup:passive × Full×Full / Full×Lite × SPED on/off ×
 * DTLS 1.3 only / [1.3, 1.2] の全組み合わせを接続し、DataChannel が双方向に
 * 通ることと stream ID parity が DTLS role に従うことを確認する。
 */
describe("接続マトリクス", () => {
  test.concurrent.each(connectionMatrixCases())(
    "$name: 接続し、DataChannel が text / binary・複数 message・双方向の順序を保ち、stream ID parity が DTLS role に一致する",
    async (matrixCase) => {
      // Arrange: 組み合わせごとに 2 peer を接続し、両側から in-band DataChannel を開く
      const { offerer, answerer, channels } = await Promise.race([
        connectMatrixCase(matrixCase),
        setTimeout(20_000).then(() => {
          throw new Error("connection did not open");
        }),
      ]);
      try {
        const messages = (prefix: string) => [
          `${prefix}-1`,
          Buffer.from(`${prefix}-binary-2`),
          `${prefix}-3`,
          Buffer.from([0, 1, 2, 255]),
          `${prefix}-5`,
        ];

        // Act: 両方向の DataChannel で text / binary を交互に複数件送る
        const results = await Promise.all(
          channels.map(([local, remote], i) =>
            sendInOrder(local, remote, messages(`dc${i}`)),
          ),
        );

        // Assert: 各方向で送った順に、型を保って届く
        results.forEach((arrived, i) => {
          expect(arrived).toEqual(messages(`dc${i}`));
        });
        // Assert: DTLS role は setup の指定どおりで、stream ID parity は
        // DTLS client = 偶数 / server = 奇数 (RFC 8832 §6)
        const offererRole =
          matrixCase.answererRole === "client" ? "server" : "client";
        expect(offerer.dtlsTransports[0].role).toBe(offererRole);
        expect(answerer.dtlsTransports[0].role).toBe(matrixCase.answererRole);
        const parity = (role: string) => (role === "server" ? 1 : 0);
        expect(channels[0][0].id! % 2).toBe(parity(offererRole));
        expect(channels[1][0].id! % 2).toBe(parity(matrixCase.answererRole));
        expect(channels[0][1].id).toBe(channels[0][0].id);
        expect(channels[1][1].id).toBe(channels[1][0].id);
        // Assert: ICE は Full×Lite なら answerer が lite かつ controlled
        const answererIce = answerer.iceTransports[0].connection as Connection;
        expect(answererIce.iceLite).toBe(matrixCase.ice === "full-lite");
        expect(
          (offerer.iceTransports[0].connection as Connection).iceControlling,
        ).toBe(true);
        // Assert: 両者が DTLS 1.3 を持つので 1.3 で接続し、SPED の有無が stats に出る
        for (const pc of [offerer, answerer]) {
          const stats = await transportStatsOf(pc);
          expect(stats.tlsVersion).toBe("DTLS 1.3");
          if (matrixCase.sped) {
            expect(stats.warpSpedState).not.toBe("disabled");
          } else {
            expect(stats.warpSpedState).toBe("disabled");
          }
        }
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    60_000,
  );
});
