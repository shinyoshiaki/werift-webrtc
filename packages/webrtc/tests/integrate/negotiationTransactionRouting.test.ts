import { MediaStreamTrack } from "../../src";
import {
  assertNegotiationInvariants,
  createConnectedMultiVideoPeers,
  createConnectedVideoPeersWithRtx,
  createSimulcastPeers,
  mungeSection,
  receivingMid,
  sectionOf,
  sendAndExpectRtp,
} from "./negotiationTransactionUtils";

/**
 * Live routing tables (extmap ID, SSRC, RTX pairing, MID+RID) are shared by
 * the current session and a pending proposal. A proposal may add keys, but a
 * key the current session uses keeps its value until the final answer.
 */
describe("negotiation transaction routing tables", () => {
  test("a remote re-offer that remaps an active header extension id is rejected before mutation", async () => {
    const { offerer, answerer, sendLayer, ridExtensionId, close } =
      await createSimulcastPeers();
    try {
      // Arrange: RID 拡張の ID を別 URI に付け替えた re-offer を作る。
      const current = answerer.currentRemoteDescription!.sdp;
      const offer = (await offerer.createOffer()).sdp.replace(
        new RegExp(
          `^a=extmap:${ridExtensionId} urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id`,
          "gm",
        ),
        `a=extmap:${ridExtensionId} urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id`,
      );

      // Act: ID を再割当てする remote offer を適用する (RFC 8285 section 7)。
      await expect(
        answerer.setRemoteDescription({ type: "offer", sdp: offer }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: 状態は変わらず、current の RID 付き RTP はそのまま届く。
      expect(answerer.signalingState).toBe("stable");
      expect(answerer.currentRemoteDescription!.sdp).toBe(current);
      assertNegotiationInvariants(answerer);
      await sendLayer("high", 1111, "extmap-remap-rejected", { withRid: true });
    } finally {
      await close();
    }
  });

  test.each(["answer", "rollback"] as const)(
    "a URI moved to a new header extension id keeps current RTP parsed through %s",
    async (finish) => {
      const { offerer, answerer, sendLayer, ridExtensionId, close } =
        await createSimulcastPeers();
      try {
        // Arrange: RID 拡張の URI を未使用の ID へ移した re-offer を作る。
        const offer = (await offerer.createOffer()).sdp.replace(
          new RegExp(
            `^a=extmap:${ridExtensionId} (urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id)`,
            "gm",
          ),
          "a=extmap:12 $1",
        );

        // Act: remote offer として適用する (answer はまだ返さない)。
        await answerer.setRemoteDescription({ type: "offer", sdp: offer });

        // Assert: pending 中も旧 ID の RID 付き RTP は current の層へ届く。
        assertNegotiationInvariants(answerer);
        await sendLayer("high", 1111, `moved-id-pending-${finish}`, {
          withRid: true,
        });

        // Act: answer で確定する、または rollback する。
        if (finish === "answer") {
          await answerer.setLocalDescription(await answerer.createAnswer());
        } else {
          await answerer.setRemoteDescription({ type: "rollback" });
        }

        // Assert: 確定後も表は SDP と一致し、rollback なら旧 ID の RTP が届く。
        expect(answerer.signalingState).toBe("stable");
        assertNegotiationInvariants(answerer);
        if (finish === "rollback") {
          await sendLayer("low", 2222, "moved-id-after-rollback", {
            withRid: true,
          });
        }
      } finally {
        await close();
      }
    },
  );

  test.each(["answer", "rollback"] as const)(
    "an SSRC a re-offer moves to another m-line keeps its current route until %s",
    async (finish) => {
      const { offerer, answerer, outgoing, close } =
        await createConnectedMultiVideoPeers(2);
      try {
        // Arrange: m-line 0 の SSRC を m-line 1 に移し、m-line 0 には新しい SSRC を付けた re-offer を作る。
        const [mid0, mid1] = offerer.getTransceivers().map((t) => t.mid!);
        const offer = (await offerer.createOffer()).sdp;
        const ssrcOf = (mid: string) =>
          sectionOf(offer, mid).match(/^a=ssrc:(\d+) /m)![1];
        const [ssrc0, ssrc1] = [ssrcOf(mid0), ssrcOf(mid1)];
        const moved = mungeSection(
          mungeSection(offer, mid0, (section) =>
            section.split(ssrc0).join("999111"),
          ),
          mid1,
          (section) => section.split(ssrc1).join(ssrc0),
        );

        // Act: SSRC を付け替える remote offer を適用する (answer はまだ返さない)。
        await answerer.setRemoteDescription({ type: "offer", sdp: moved });

        // Assert: pending 中は current の経路のまま m-line 0 に届き、付け替えは保留される。
        expect(await receivingMid(outgoing[0], answerer, "ssrc-pending")).toBe(
          mid0,
        );
        assertNegotiationInvariants(answerer);

        // Act: answer で確定する、または rollback する。
        if (finish === "answer") {
          await answerer.setLocalDescription(await answerer.createAnswer());
        } else {
          await answerer.setRemoteDescription({ type: "rollback" });
        }

        // Assert: 確定すると SDP どおり m-line 1 へ、rollback なら m-line 0 のまま届く。
        expect(
          await receivingMid(outgoing[0], answerer, `ssrc-after-${finish}`),
        ).toBe(finish === "answer" ? mid1 : mid0);
        assertNegotiationInvariants(answerer);
      } finally {
        await close();
      }
    },
  );

  test.each(["answer", "rollback"] as const)(
    "an RTX SSRC a re-offer pairs with another media SSRC keeps its current pairing until %s",
    async (finish) => {
      const { offerer, answerer, outgoing, incoming } =
        await createConnectedVideoPeersWithRtx();
      try {
        // Arrange: FID の RTX SSRC は変えず、対になるメディア SSRC を付け替えた re-offer を作る。
        const offer = (await offerer.createOffer()).sdp;
        const [, mediaSsrc, rtxSsrc] = offer.match(
          /^a=ssrc-group:FID (\d+) (\d+)/m,
        )!;
        const repaired = offer.split(mediaSsrc).join("999333");
        const receiver = answerer.getTransceivers()[0].receiver;
        const pairing = () =>
          receiver.snapshotReceiveTables().ssrcByRtx[Number(rtxSsrc)];
        expect(pairing()).toBe(Number(mediaSsrc));

        // Act: RTX の対応を変える remote offer を適用する (answer はまだ返さない)。
        await answerer.setRemoteDescription({ type: "offer", sdp: repaired });

        // Assert: pending 中は current の RTX 対応のまま (付け替えは保留)。
        expect(pairing()).toBe(Number(mediaSsrc));
        assertNegotiationInvariants(answerer);

        // Act: answer で確定する、または rollback する。
        if (finish === "answer") {
          await answerer.setLocalDescription(await answerer.createAnswer());
        } else {
          await answerer.setRemoteDescription({ type: "rollback" });
        }

        // Assert: 確定すると新しい対応に、rollback なら元の対応のまま。
        expect(pairing()).toBe(
          finish === "answer" ? 999333 : Number(mediaSsrc),
        );
        assertNegotiationInvariants(answerer);
        if (finish === "rollback") {
          await sendAndExpectRtp(outgoing, incoming, "rtx-after-rollback");
        }
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
  );

  test.each(["answer", "rollback"] as const)(
    "a second simulcast m-line that reuses the RID names routes by MID through %s",
    async (finish) => {
      const { offerer, answerer, sendLayer, firstMid, close } =
        await createSimulcastPeers();
      try {
        // Arrange: 同じ RID 名 (high/low) を使う 2 本目の simulcast m-line を re-offer で足す。
        offerer.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
          direction: "sendonly",
          sendEncodings: [{ rid: "high" }, { rid: "low" }],
        });
        await offerer.setLocalDescription(await offerer.createOffer());
        const secondMid = offerer.getTransceivers()[1].mid!;

        // Act: re-offer を適用する (answer はまだ返さない)。
        await answerer.setRemoteDescription(offerer.localDescription!);

        // Assert: current の m-line の RID は current の receiver に、新しい m-line の RID は新しい receiver に届く。
        await sendLayer("high", 1111, "rid-current-pending", {
          withRid: true,
        });
        await sendLayer("high", 3333, "rid-new-pending", {
          withRid: true,
          mid: secondMid,
        });
        assertNegotiationInvariants(answerer);

        // Act: answer で確定する、または rollback する。
        if (finish === "answer") {
          await answerer.setLocalDescription(await answerer.createAnswer());
          await offerer.setRemoteDescription(answerer.localDescription!);
        } else {
          await answerer.setRemoteDescription({ type: "rollback" });
          await offerer.setLocalDescription({ type: "rollback" });
        }

        // Assert: どちらの結果でも current の m-line の RID 経路は変わらない。
        await sendLayer("low", 2222, `rid-current-after-${finish}`, {
          withRid: true,
          mid: firstMid,
        });
        if (finish === "answer") {
          await sendLayer("low", 4444, "rid-new-after-answer", {
            withRid: true,
            mid: secondMid,
          });
        }
        assertNegotiationInvariants(answerer);
      } finally {
        await close();
      }
    },
  );
});
