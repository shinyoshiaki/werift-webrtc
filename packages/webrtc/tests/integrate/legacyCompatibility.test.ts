import {
  createCompatibilityPeers,
  prepareProvisionalAnswers,
  prepareRidLoopback,
} from "./legacyCompatibilityArrange";

describe("WARP preserves existing negotiation and simulcast behavior", () => {
  test("remote rollback retains an application-added transceiver", async () => {
    // Arrange
    const {
      peers: [caller, callee],
      close,
    } = createCompatibilityPeers();
    caller.addTransceiver("audio");
    try {
      await callee.setRemoteDescription(await caller.createOffer());
      const applicationTransceiver = callee.addTransceiver("video");

      // Act: remote offer の後でアプリが追加した設定を残して rollback する。
      await callee.setRemoteDescription({ type: "rollback" });

      // Assert: アプリ所有の transceiver は削除・停止されない。
      expect(callee.signalingState).toBe("stable");
      expect(callee.getTransceivers()).toContain(applicationTransceiver);
      expect(applicationTransceiver.stopped).toBe(false);
    } finally {
      await close();
    }
  });

  test("pranswer remains pending and accepts another responder's final answer", async () => {
    // Arrange
    const { caller, offer, pranswer, answer, close } =
      await prepareProvisionalAnswers();
    try {
      // Act: 最初の応答先の暫定応答を適用する。
      await caller.setRemoteDescription(pranswer);

      // Assert: 暫定応答は current descriptions に昇格しない。
      expect(caller.signalingState).toBe("have-remote-pranswer");
      expect(caller.pendingLocalDescription?.sdp).toBe(offer?.sdp);
      expect(caller.pendingRemoteDescription?.type).toBe("pranswer");
      expect(caller.currentLocalDescription).toBeNull();
      expect(caller.currentRemoteDescription).toBeNull();

      // Act: 異なる tls-id の応答先を最終 answer として選ぶ。
      await caller.setRemoteDescription(answer);

      // Assert: 最終応答を受理してから pending SDP が current に移る。
      expect(caller.signalingState).toBe("stable");
      expect(caller.pendingLocalDescription).toBeNull();
      expect(caller.pendingRemoteDescription).toBeNull();
      expect(caller.currentRemoteDescription?.type).toBe("answer");
    } finally {
      await close();
    }
  });

  test("RID loopback keeps high and low sequence spaces separate", async () => {
    // Arrange
    const { packet, receive, received, close } = await prepareRidLoopback();
    try {
      // Act: 別 RID の RTP と、RID を省略した各 SSRC の後続 RTP を配送する。
      receive(packet("high", 100));
      receive(packet("low", 900));
      receive(packet("high", 101, false));
      receive(packet("low", 901, false));

      // Assert: 各 sender に流れる sequence number は対応レイヤーだけになる。
      expect(received.high).toEqual([100, 101]);
      expect(received.low).toEqual([900, 901]);
    } finally {
      await close();
    }
  });
});
