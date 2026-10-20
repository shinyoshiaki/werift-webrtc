import { MediaStreamTrack } from "../../../src";
import {
  ANSWER_OR_ROLLBACK,
  describeCases,
  negotiationCase,
} from "../harness/negotiationCase";
import { createSimulcastPeers } from "../harness/negotiationTransactionUtils";

/**
 * Live routing tables (extmap ID, SSRC, RTX pairing, MID+RID) are shared by
 * the current session and a pending proposal. A proposal may add keys, but a
 * key the current session uses keeps its value until the final answer.
 */
describeCases("negotiation transaction routing tables", () => {
  negotiationCase.for(ANSWER_OR_ROLLBACK)(
    "a second simulcast m-line that reuses the RID names routes by MID through $finish",
    { ref: "2.4-1 2.4-T5" },
    async (c, { finish }) => {
      // Arrange: 同じ RID 名 (high/low) を使う 2 本目の simulcast m-line を re-offer で足す。
      const { a, b, sendLayer, firstMid } = await c.given(
        createSimulcastPeers(),
      );
      a.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
        direction: "sendonly",
        sendEncodings: [{ rid: "high" }, { rid: "low" }],
      });
      const aOffer = await a.createOffer();
      await c.setLocal(a, aOffer);
      const second = a.getTransceivers()[1].mid!;

      // Act: re-offer を適用する (answer はまだ返さない)。
      await c.setRemote(b, a.localDescription);

      // Assert: current の m-line の RID は current の receiver に、新しい m-line の RID は新しい receiver に届く。
      await sendLayer("high", 1111, "rid-current-pending", { withRid: true });
      await sendLayer("high", 3333, "rid-new-pending", {
        withRid: true,
        mid: second,
      });

      // Act: answer で確定する、または rollback する。
      await c.finish(b, finish);

      // Assert: どちらの結果でも current の m-line の RID 経路は変わらず、answer なら新しい m-line にも届く。
      await sendLayer("low", 2222, `rid-current-after-${finish}`, {
        withRid: true,
        mid: firstMid,
      });
      if (finish === "answer")
        await sendLayer("low", 4444, "rid-new-after-answer", {
          withRid: true,
          mid: second,
        });
    },
  );
});
