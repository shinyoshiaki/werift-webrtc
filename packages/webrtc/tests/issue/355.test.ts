import {
  type MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  SessionDescription,
} from "../../src";
import { ringCentralOffer, rtcpLines, withDeclaredSsrc } from "../sdpUtils";

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

  test("RingCentral の offer (a=rtcp:48037 のまま) で SSRC を宣言すると RTP が track に配送される", async () => {
    // Arrange: a=rtcp:48037 を残したまま a=ssrc を宣言した offer に answer する
    const ssrc = 1234;
    const pc = new RTCPeerConnection({ iceServers: [] });
    const tracks: MediaStreamTrack[] = [];
    pc.onTrack.subscribe((track) => tracks.push(track));

    try {
      await pc.setRemoteDescription({
        type: "offer",
        sdp: withDeclaredSsrc(ringCentralOffer, ssrc),
      });
      await pc.setLocalDescription(await pc.createAnswer());
      const received: RtpPacket[] = [];
      tracks[0].onReceiveRtp.subscribe((packet) => received.push(packet));
      const [transceiver] = pc.getTransceivers();
      const packet = new RtpPacket(
        new RtpHeader({
          ssrc,
          payloadType: 0,
          sequenceNumber: 1,
          timestamp: 1,
        }),
        Buffer.from([1, 2, 3]),
      );

      // Act: DTLS transport が復号した RTP として PCMU (PT 0) のパケットを流す
      transceiver.dtlsTransport!.onRtp.execute(packet);

      // Assert: 宣言した SSRC の経路で track に届き、remoteDescription には a=rtcp:48037 が残る
      expect(tracks).toHaveLength(1);
      expect(received.map((p) => p.header.ssrc)).toEqual([ssrc]);
      expect(rtcpLines(pc.remoteDescription!.sdp)).toEqual([
        "a=rtcp:48037",
        "a=rtcp-mux",
      ]);
    } finally {
      await pc.close();
    }
  });
});
