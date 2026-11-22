import { describe, expect, test } from "vitest";

import {
  collectDeliveredRtp,
  firefoxSimulcastLayers,
  negotiateFirefoxSimulcast,
  retransmissionsOf,
  sendFirefoxSimulcastWithRepair,
} from "../rtpReceiverTestUtils";

/**
 * Acceptance test of ticket be690c2e: simulcast received by RID from a
 * Firefox description that also lists each layer's `a=ssrc` and
 * `a=ssrc-group:FID` used to announce an extra SSRC track, and the high
 * layer's RTX was restored onto it; now `ontrack` gives one track per RID
 * and every layer's RTX restores onto its own RID track. The RTP enters at
 * the receiving DTLS transport, as after SRTP decryption.
 */
describe("acceptance: Firefox simulcast with a=ssrc / FID gives RID tracks only, each repairing its layer", () => {
  test.each([
    { role: "offer" as const, side: "Firefox の offer を受ける側" },
    { role: "answer" as const, side: "Firefox の answer を受ける側" },
  ])(
    "($side) 6章: onTrack は RID の数だけ発火し、両レイヤーの RTX はそれぞれの RID のトラックへ復元される",
    async ({ role }) => {
      const { pc, announced, ontrack, receive } =
        await negotiateFirefoxSimulcast(role);

      try {
        // Assert: transceiver.onTrack が通知したトラックは RID ごとの 2 本だけで、SSRC だけのトラックはない。
        expect(announced.map((t) => [t.rid, t.ssrc])).toEqual([
          ["high", undefined],
          ["low", undefined],
        ]);
        const delivered = Object.fromEntries(
          announced.map((t) => [t.rid!, collectDeliveredRtp(t)]),
        );

        // Act: 各レイヤーが媒体 1, 3 を RID 付きで送り、落ちた 2 を repaired RID 付きの RTX で再送する。
        sendFirefoxSimulcastWithRepair(receive);

        // Assert: 両レイヤーとも、媒体と RTX から復元した 2 が自分の RID のトラックに届く。
        for (const layer of firefoxSimulcastLayers) {
          expect(delivered[layer.rid].map((p) => [p.ssrc, p.seq])).toEqual([
            [layer.ssrc, 1],
            [layer.ssrc, 3],
            [layer.ssrc, 2],
          ]);
          expect(retransmissionsOf(delivered[layer.rid])).toEqual([
            [layer.ssrc, 2],
          ]);
        }

        // Assert: パケットを受けた後も ontrack は再発火しない。
        expect(announced).toHaveLength(2);
      } finally {
        await pc.close();
      }
    },
  );
});
