import { RTCPeerConnection, TransceiverPairingModes } from "../../src";
import { closeAll } from "./705.helpers";

/**
 * Issue #816: `transceiverPairing` selects how a remote offer pairs its
 * m-sections with local transceivers. The negotiation behavior of each mode
 * is in tests/negotiation/cases/negotiationTransactionPairing.test.ts.
 */
describe("issue 816: transceiverPairing configuration", () => {
  test("defaults to legacy, validates values and rejects changes", async () => {
    // Arrange / Act: 既定値と明示値で作成する
    const defaultPc = new RTCPeerConnection();
    const standardPc = new RTCPeerConnection({
      transceiverPairing: "standard",
    });

    try {
      // Assert: 既定は legacy (v0.27.0 と同じ関連付け) で getConfiguration に現れる。値の一覧は standard と legacy
      expect(defaultPc.getConfiguration().transceiverPairing).toBe("legacy");
      expect(standardPc.getConfiguration().transceiverPairing).toBe("standard");
      expect(TransceiverPairingModes).toEqual(["standard", "legacy"]);

      // Assert: 無効値 (旧名 "jsep" を含む) は生成時に TypeError
      for (const value of ["any", "jsep"]) {
        expect(
          () => new RTCPeerConnection({ transceiverPairing: value as never }),
        ).toThrow(TypeError);
      }

      // Assert: 途中変更は拒否し、同じ値の再設定は許可する
      expect(() =>
        defaultPc.setConfiguration({ transceiverPairing: "standard" }),
      ).toThrow(expect.objectContaining({ name: "InvalidModificationError" }));
      expect(() =>
        defaultPc.setConfiguration({ transceiverPairing: "legacy" }),
      ).not.toThrow();
      expect(defaultPc.getConfiguration().transceiverPairing).toBe("legacy");
    } finally {
      await closeAll(defaultPc, standardPc);
    }
  });

  test.each([
    { transceiverPairing: "standard" as const, transceivers: 2, mid: null },
    { transceiverPairing: "legacy" as const, transceivers: 1, mid: "0" },
  ])(
    "the #816 report: $transceiverPairing",
    async ({ transceiverPairing, transceivers, mid }) => {
      // Arrange: 報告の再現コード (b は remote offer の前に addTransceiver する)
      const a = new RTCPeerConnection({ iceServers: [] });
      const b = new RTCPeerConnection({ iceServers: [], transceiverPairing });
      a.addTransceiver("audio");
      await a.setLocalDescription(await a.createOffer());
      const own = b.addTransceiver("audio", { direction: "sendrecv" });

      try {
        // Act: a の offer を b に適用する
        await b.setRemoteDescription(a.localDescription!);

        // Assert: standard は remote offer 用の transceiver を作り own は MID null のまま、legacy は v0.27.0 と同じく own に関連付ける
        expect(b.getTransceivers().length).toBe(transceivers);
        expect(own.mid).toBe(mid);
        expect(own.direction).toBe("sendrecv");
      } finally {
        await closeAll(a, b);
      }
    },
  );
});
