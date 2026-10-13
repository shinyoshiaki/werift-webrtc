import {
  MediaStreamTrack,
  useRepairedRtpStreamId,
  useSdesMid,
  useSdesRTPStreamId,
} from "../../../src";
import {
  ANSWER_OR_ROLLBACK,
  describeCases,
  negotiationCase,
} from "../harness/negotiationCase";
import {
  createConnectedMultiVideoPeers,
  createConnectedVideoPeersWithRtx,
  createSimulcastPeers,
  extmapId,
  mungeSection,
  receivingMid,
  setExtmapId,
  setExtmapUri,
  ssrcOf,
} from "../harness/negotiationTransactionUtils";

/**
 * Live routing tables (extmap ID, SSRC, RTX pairing, MID+RID) are shared by
 * the current session and a pending proposal. A proposal may add keys, but a
 * key the current session uses keeps its value until the final answer.
 */
describeCases("negotiation transaction routing tables", () => {
  negotiationCase(
    "a remote re-offer that remaps an active header extension id is rejected before mutation",
    { ref: "2.4-T2a" },
    async (c) => {
      // Arrange: RID 拡張の ID を別 URI に付け替えた re-offer を作る。
      const { a, b, sendLayer, ridExtensionId } = await c.given(
        createSimulcastPeers(),
      );
      const offer = await a.createOffer();

      // Act: ID を再割当てする remote offer を適用する (RFC 8285 section 7)。拒否され状態は変わらない。
      await c.setRemote(
        b,
        setExtmapUri(offer.sdp, ridExtensionId, useRepairedRtpStreamId().uri),
        { rejects: "InvalidModificationError" },
      );

      // Assert: current の RID 付き RTP はそのまま届く。
      await sendLayer("high", 1111, "extmap-remap-rejected", { withRid: true });
    },
  );

  negotiationCase(
    "a remote re-offer that swaps the active MID and RID extension ids is rejected before mutation",
    { ref: "2.4-T2a" },
    async (c) => {
      // Arrange: current SDP で使っている MID と RID の extension ID を交換した re-offer を作る。
      const { a, b, sendLayer, ridExtensionId } = await c.given(
        createSimulcastPeers(),
      );
      const mid = extmapId(b.currentRemoteDescription!.sdp, useSdesMid().uri);
      const offer = await a.createOffer();
      const swapped = setExtmapId(
        setExtmapId(offer.sdp, useSdesMid().uri, ridExtensionId),
        useSdesRTPStreamId().uri,
        mid,
      );

      // Act: routing ID の対応が反転する re-offer を適用する。拒否され状態は変わらない。
      await c.setRemote(b, swapped, { rejects: "InvalidModificationError" });

      // Assert: current の MID/RID 解釈と RTP が保たれる。
      await sendLayer("high", 1111, "extmap-id-swap-rejected", {
        withRid: true,
      });
    },
  );

  negotiationCase.for(ANSWER_OR_ROLLBACK)(
    "a URI moved to a new header extension id keeps current RTP parsed through $finish",
    { ref: "2.4-T2b" },
    async (c, { finish }) => {
      // Arrange: RID 拡張の URI を未使用の ID 12 へ移した re-offer を作る。
      const { a, b, sendLayer } = await c.given(createSimulcastPeers());
      const offer = await a.createOffer();

      // Act: remote offer として適用する (answer はまだ返さない)。
      await c.setRemote(
        b,
        setExtmapId(offer.sdp, useSdesRTPStreamId().uri, 12),
      );

      // Assert: pending 中も旧 ID の RID 付き RTP は current の層へ届く。
      await sendLayer("high", 1111, `moved-id-pending-${finish}`, {
        withRid: true,
      });

      // Act: answer で確定する、または rollback する。
      await c.finish(b, finish);

      // Assert: 確定後も表は SDP と一致し (各操作後の invariant)、rollback なら旧 ID の RTP が届く。
      expect(b.signalingState).toEqual("stable");
      if (finish === "rollback")
        await sendLayer("low", 2222, "moved-id-after-rollback", {
          withRid: true,
        });
    },
  );

  negotiationCase.for([
    { finish: "answer", after: "1" },
    { finish: "rollback", after: "0" },
  ] as const)(
    "an SSRC a re-offer moves to another m-line keeps its current route until $finish",
    {
      ref: "2.1-T3 2.4-2 2.4-T3",
      exempt: "b commits a hand-edited offer that a never applied",
    },
    async (c, { finish, after }) => {
      // Arrange: m-line 0 の SSRC を m-line 1 に移し、m-line 0 には新しい SSRC 999111 を付けた re-offer を作る。
      const { a, b, outgoing } = await c.given(
        createConnectedMultiVideoPeers(2),
      );
      const offer = await a.createOffer();
      const ssrc0 = ssrcOf(offer.sdp, "0");
      const moved = mungeSection(
        mungeSection(offer.sdp, "0", (s) => s.split(ssrc0).join("999111")),
        "1",
        (s) => s.split(ssrcOf(offer.sdp, "1")).join(ssrc0),
      );

      // Act: SSRC を付け替える remote offer を適用する (answer はまだ返さない)。
      await c.setRemote(b, moved);

      // Assert: pending 中は current の経路のまま m-line 0 に届き、付け替えは保留される。
      expect(await receivingMid(outgoing[0], b, "ssrc-pending")).toEqual("0");

      // Act: answer で確定する、または rollback する。
      await c.finish(b, finish);

      // Assert: 確定すると SDP どおり m-line 1 へ、rollback なら m-line 0 のまま届く。
      expect(
        await receivingMid(outgoing[0], b, `ssrc-after-${finish}`),
      ).toEqual(after);
    },
  );

  negotiationCase.for(ANSWER_OR_ROLLBACK)(
    "an RTX SSRC a re-offer pairs with another media SSRC keeps its current pairing until $finish",
    {
      ref: "2.4-3 2.4-T4",
      exempt: "b commits a hand-edited offer that a never applied",
    },
    async (c, { finish }) => {
      // Arrange: FID の RTX SSRC は変えず、対になるメディア SSRC を 999333 に付け替えた re-offer を作る。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeersWithRtx(),
      );
      const offer = await a.createOffer();
      const [, media, rtx] = offer.sdp.match(/^a=ssrc-group:FID (\d+) (\d+)/m)!;
      const pairing = () =>
        b.getTransceivers()[0].receiver.snapshotReceiveTables().ssrcByRtx[rtx];
      expect(pairing()).toEqual(Number(media));

      // Act: RTX の対応を変える remote offer を適用する (answer はまだ返さない)。
      await c.setRemote(b, offer.sdp.split(media).join("999333"));

      // Assert: pending 中は current の RTX 対応のまま (付け替えは保留)。
      expect(pairing()).toEqual(Number(media));

      // Act: answer で確定する、または rollback する。
      await c.finish(b, finish);

      // Assert: 確定すると新しい対応に、rollback なら元の対応のまま RTP が届く。
      if (finish === "answer") expect(pairing()).toEqual(999333);
      if (finish === "rollback") expect(pairing()).toEqual(Number(media));
      if (finish === "rollback") await c.rtp(outgoing, incoming);
    },
  );

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
