import { RTCPeerConnection } from "../../src";

/**
 * ICE restart 中は、相手の新しい usernameFragment を持つ candidate が、対応する
 * remote description を適用する前に届くことがある。これを OperationError で弾くと
 * 呼び出し側は candidate を失い、restart 後の candidate pair が作られないまま
 * （送信は続くのに相手に届かない）状態になる。remote description が未適用のときと
 * 同じように buffer して、対応する description の適用後に反映する。
 */
describe("addIceCandidate buffering across ICE generations", () => {
  const candidateFor = (usernameFragment: string) => ({
    candidate:
      "candidate:1 1 UDP 2130706431 203.0.113.1 50000 typ host generation 0",
    sdpMid: "0",
    usernameFragment,
  });

  const appliedCandidateCount = (pc: RTCPeerConnection) =>
    (pc._remoteDescription?.media ?? []).reduce(
      (count, media) => count + media.iceCandidates.length,
      0,
    );

  test("buffers a candidate whose usernameFragment is not applied yet, then applies it", async () => {
    const offerer = new RTCPeerConnection({});
    const answerer = new RTCPeerConnection({});

    try {
      offerer.createDataChannel("dc");
      const offer = await offerer.createOffer();
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offer);
      const answer = await answerer.createAnswer();
      await answerer.setLocalDescription(answer);
      await offerer.setRemoteDescription(answer);

      const appliedBefore = appliedCandidateCount(offerer);

      // 実行: 適用済み remote description に無い ufrag の candidate を渡す。
      // 従来は OperationError で reject していた。
      await expect(
        offerer.addIceCandidate(candidateFor("ufragFromNextGeneration")),
      ).resolves.toBeUndefined();

      // 検証: 捨てられておらず、まだ適用もされていない
      expect(appliedCandidateCount(offerer)).toBe(appliedBefore);

      // 実行: その ufrag を持つ remote description が届く（ICE restart 相当）
      const restarted = await answerer.createOffer({ iceRestart: true });
      await offerer.setRemoteDescription({
        type: restarted.type,
        sdp: restarted.sdp.replace(
          /^a=ice-ufrag:.*$/gm,
          "a=ice-ufrag:ufragFromNextGeneration",
        ),
      });

      // 検証: buffer していた candidate が適用される
      expect(appliedCandidateCount(offerer)).toBeGreaterThan(appliedBefore);
    } finally {
      await offerer.close();
      await answerer.close();
    }
  });

  test("keeps rejecting a candidate whose sdpMid does not exist", async () => {
    const offerer = new RTCPeerConnection({});
    const answerer = new RTCPeerConnection({});

    try {
      offerer.createDataChannel("dc");
      const offer = await offerer.createOffer();
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offer);
      const answer = await answerer.createAnswer();
      await answerer.setLocalDescription(answer);
      await offerer.setRemoteDescription(answer);

      // 検証: ufrag 以外の不整合は従来どおりエラーのまま（buffer 対象を広げない）
      await expect(
        offerer.addIceCandidate({
          candidate:
            "candidate:1 1 UDP 2130706431 203.0.113.1 50000 typ host generation 0",
          sdpMid: "nonexistent",
        }),
      ).rejects.toThrow();
    } finally {
      await offerer.close();
      await answerer.close();
    }
  });
});
