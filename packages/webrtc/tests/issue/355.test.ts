import { RTCPeerConnection, SessionDescription } from "../../src";
import { ringCentralOffer, rtcpLines } from "../sdpUtils";

// https://github.com/shinyoshiaki/werift-webrtc/issues/355
describe("issue 355: a=rtcp without address (RFC 3605)", () => {
  test("RingCentral の offer を SessionDescription.parse できる", () => {
    // Act: アドレス省略形の a=rtcp:48037 を含む offer をパースする
    const description = SessionDescription.parse(ringCentralOffer);
    const media = description.media[0];

    // Assert: 例外にならず、有効 RTCP アドレスは session-level の c= になる
    expect(media.rtcpPort).toBe(48037);
    expect(media.rtcpHost).toBeUndefined();
    expect(media.rtcpMux).toBe(true);
    expect(media.rtcpHost ?? media.host ?? description.host).toBe(
      "208.87.41.111",
    );
  });

  test("RingCentral の offer で setRemoteDescription / createAnswer まで進む", async () => {
    // Arrange
    const pc = new RTCPeerConnection({ iceServers: [] });

    try {
      // Act: remote offer として適用し、answer を作る
      await pc.setRemoteDescription({ type: "offer", sdp: ringCentralOffer });
      const answer = await pc.createAnswer();

      // Assert: answer が作れ、remoteDescription に a=rtcp-mux と a=rtcp:48037 が残る
      expect(answer.sdp).toContain("m=audio");
      expect(rtcpLines(pc.remoteDescription!.sdp)).toEqual([
        "a=rtcp:48037",
        "a=rtcp-mux",
      ]);
    } finally {
      await pc.close();
    }
  });
});
