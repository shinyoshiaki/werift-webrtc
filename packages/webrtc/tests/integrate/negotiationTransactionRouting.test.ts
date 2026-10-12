import { negotiationCases } from "./negotiationCaseRunner";

/**
 * Live routing tables (extmap ID, SSRC, RTX pairing, MID+RID) are shared by
 * the current session and a pending proposal. A proposal may add keys, but a
 * key the current session uses keeps its value until the final answer.
 */
negotiationCases("negotiation transaction routing tables", [
  `
    case: a remote re-offer that remaps an active header extension id is rejected before mutation
    ref: 2.4-T2a
    given: createSimulcastPeers()
    Arrange: RID 拡張の ID を別 URI に付け替えた re-offer を作る。
    a createOffer as=offer
    Act: ID を再割当てする remote offer を適用する (RFC 8285 section 7)。拒否され状態は変わらない。
    b setRemote setExtmapUri(offer.sdp, ridExtensionId, useRepairedRtpStreamId().uri) rejects=InvalidModificationError
    Assert: current の RID 付き RTP はそのまま届く。
    do sendLayer("high", 1111, "extmap-remap-rejected", { withRid: true })
  `,
  `
    case: a remote re-offer that swaps the active MID and RID extension ids is rejected before mutation
    ref: 2.4-T2a
    given: createSimulcastPeers()
    Arrange: current SDP で使っている MID と RID の extension ID を交換した re-offer を作る。
    let mid = extmapId(b.currentRemoteDescription.sdp, useSdesMid().uri)
    a createOffer as=offer
    let swapped = setExtmapId(setExtmapId(offer.sdp, useSdesMid().uri, ridExtensionId), useSdesRTPStreamId().uri, mid)
    Act: routing ID の対応が反転する re-offer を適用する。拒否され状態は変わらない。
    b setRemote swapped rejects=InvalidModificationError
    Assert: current の MID/RID 解釈と RTP が保たれる。
    do sendLayer("high", 1111, "extmap-id-swap-rejected", { withRid: true })
  `,
  `
    case: a URI moved to a new header extension id keeps current RTP parsed through $finish
    ref: 2.4-T2b
    given: createSimulcastPeers()
    each: ANSWER_OR_ROLLBACK
    Arrange: RID 拡張の URI を未使用の ID 12 へ移した re-offer を作る。
    a createOffer as=offer
    Act: remote offer として適用する (answer はまだ返さない)。
    b setRemote setExtmapId(offer.sdp, useSdesRTPStreamId().uri, 12)
    Assert: pending 中も旧 ID の RID 付き RTP は current の層へ届く。
    do sendLayer("high", 1111, "moved-id-pending-$finish", { withRid: true })
    Act: answer で確定する、または rollback する。
    b finish $finish
    Assert: 確定後も表は SDP と一致し (各操作後の invariant)、rollback なら旧 ID の RTP が届く。
    expect b.signalingState == "stable"
    [finish=rollback] do sendLayer("low", 2222, "moved-id-after-rollback", { withRid: true })
  `,
  `
    case: an SSRC a re-offer moves to another m-line keeps its current route until $finish
    ref: 2.1-T3 2.4-2 2.4-T3
    given: createConnectedMultiVideoPeers(2)
    each: [
      { finish: "answer", after: "1" },
      { finish: "rollback", after: "0" },
    ]
    exempt: b commits a hand-edited offer that a never applied
    Arrange: m-line 0 の SSRC を m-line 1 に移し、m-line 0 には新しい SSRC 999111 を付けた re-offer を作る。
    a createOffer as=offer
    let ssrc0 = ssrcOf(offer.sdp, "0")
    let moved = mungeSection(mungeSection(offer.sdp, "0", (s) => s.split(ssrc0).join("999111")), "1", (s) => s.split(ssrcOf(offer.sdp, "1")).join(ssrc0))
    Act: SSRC を付け替える remote offer を適用する (answer はまだ返さない)。
    b setRemote moved
    Assert: pending 中は current の経路のまま m-line 0 に届き、付け替えは保留される。
    expect receivingMid(outgoing[0], b, "ssrc-pending") == "0"
    Act: answer で確定する、または rollback する。
    b finish $finish
    Assert: 確定すると SDP どおり m-line 1 へ、rollback なら m-line 0 のまま届く。
    expect receivingMid(outgoing[0], b, "ssrc-after-$finish") == "$after"
  `,
  `
    case: an RTX SSRC a re-offer pairs with another media SSRC keeps its current pairing until $finish
    ref: 2.4-3 2.4-T4
    given: createConnectedVideoPeersWithRtx()
    each: ANSWER_OR_ROLLBACK
    exempt: b commits a hand-edited offer that a never applied
    Arrange: FID の RTX SSRC は変えず、対になるメディア SSRC を 999333 に付け替えた re-offer を作る。
    a createOffer as=offer
    let [fid, media, rtx] = offer.sdp.match(/^a=ssrc-group:FID (\\d+) (\\d+)/m)
    let pairing = () => b.getTransceivers()[0].receiver.snapshotReceiveTables().ssrcByRtx[rtx]
    expect pairing() == Number(media)
    Act: RTX の対応を変える remote offer を適用する (answer はまだ返さない)。
    b setRemote offer.sdp.split(media).join("999333")
    Assert: pending 中は current の RTX 対応のまま (付け替えは保留)。
    expect pairing() == Number(media)
    Act: answer で確定する、または rollback する。
    b finish $finish
    Assert: 確定すると新しい対応に、rollback なら元の対応のまま RTP が届く。
    [finish=answer] expect pairing() == 999333
    [finish=rollback] expect pairing() == Number(media)
    [finish=rollback] rtp outgoing -> incoming
  `,
  `
    case: a second simulcast m-line that reuses the RID names routes by MID through $finish
    ref: 2.4-1 2.4-T5
    given: createSimulcastPeers()
    each: ANSWER_OR_ROLLBACK
    Arrange: 同じ RID 名 (high/low) を使う 2 本目の simulcast m-line を re-offer で足す。
    do a.addTransceiver(new MediaStreamTrack({ kind: "video" }), { direction: "sendonly", sendEncodings: [{ rid: "high" }, { rid: "low" }] })
    a createOffer
    a setLocal
    let second = a.getTransceivers()[1].mid
    Act: re-offer を適用する (answer はまだ返さない)。
    b setRemote local(a)
    Assert: current の m-line の RID は current の receiver に、新しい m-line の RID は新しい receiver に届く。
    do sendLayer("high", 1111, "rid-current-pending", { withRid: true })
    do sendLayer("high", 3333, "rid-new-pending", { withRid: true, mid: second })
    Act: answer で確定する、または rollback する。
    b finish $finish
    Assert: どちらの結果でも current の m-line の RID 経路は変わらず、answer なら新しい m-line にも届く。
    do sendLayer("low", 2222, "rid-current-after-$finish", { withRid: true, mid: firstMid })
    [finish=answer] do sendLayer("low", 4444, "rid-new-after-answer", { withRid: true, mid: second })
  `,
]);
