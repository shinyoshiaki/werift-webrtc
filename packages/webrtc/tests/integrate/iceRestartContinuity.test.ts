import { setTimeout } from "timers/promises";

import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
} from "../../src";
import {
  exchangeOfferAnswer,
  waitForConnectionState,
  withRestartedIceCredentials,
} from "../utils";

describe("ICE restart continuity", () => {
  test("相手だけが資格情報を変えた answer を適用しても、新候補が届くまで旧経路の RTP を受け取り続ける", async () => {
    // Arrange: pc2 → pc1 の音声が流れている接続済みセッション。
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    const outgoing = new MediaStreamTrack({ kind: "audio" });
    let received = 0;
    let sequenceNumber = 0;
    const pump = setInterval(() => {
      sequenceNumber = (sequenceNumber + 1) & 0xffff;
      outgoing.writeRtp(
        new RtpPacket(
          new RtpHeader({ sequenceNumber, timestamp: sequenceNumber * 960 }),
          Buffer.from("media"),
        ).serialize(),
      );
    }, 10);
    try {
      pc1.onTrack.subscribe((track) => {
        track.onReceiveRtp.subscribe(() => received++);
      });
      pc1.addTransceiver("audio", { direction: "recvonly" });
      await pc1.setLocalDescription(await pc1.createOffer());
      await pc2.setRemoteDescription(pc1.localDescription!);
      const [answerer] = pc2.getTransceivers();
      answerer.direction = "sendonly";
      await answerer.sender.replaceTrack(outgoing);
      await pc1.setRemoteDescription(await pc2.createAnswer());
      await pc2.setLocalDescription(pc1.remoteDescription!);
      await Promise.all([
        waitForConnectionState(pc1, "connected", 10_000),
        waitForConnectionState(pc2, "connected", 10_000),
      ]);
      const deadline = Date.now() + 5_000;
      while (received === 0 && Date.now() < deadline) await setTimeout(20);
      expect(received, "restart 前に RTP が流れている").toBeGreaterThan(0);

      // Act: 再交渉で、相手 (pc2) だけが ICE 資格情報を更新した answer を pc1 に
      // 適用する。pc2 の新しい候補はまだ届かない (後で trickle される)。
      await pc1.setLocalDescription(await pc1.createOffer());
      await pc2.setRemoteDescription(pc1.localDescription!);
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription({
        type: "answer",
        sdp: withRestartedIceCredentials(answer.sdp),
      });
      const before = received;
      await setTimeout(250);

      // Assert: 新 pair の認証前も、相手が送り続ける旧選択 pair の RTP を配送する
      // (RFC 8445 §9)。
      expect(received - before).toBeGreaterThan(0);
    } finally {
      clearInterval(pump);
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  }, 30_000);
});
