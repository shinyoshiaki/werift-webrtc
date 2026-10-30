import { setTimeout } from "timers/promises";
import type { RTCDataChannel } from "../../src";
import { RTCPeerConnection } from "../../src";
import {
  awaitMessage,
  exchangeOfferAnswer,
  waitForConnectionState,
  waitForSctpEstablished,
} from "../utils";

describe("datachannel/streamId", () => {
  test("接続済み max-bundle に両端が最初の DataChannel を足しても stream ID が衝突しない", async () => {
    // Arrange: media だけで接続済みの max-bundle セッションを作る。
    const pc1 = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
    const pc2 = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
    try {
      pc1.addTransceiver("audio");
      await exchangeOfferAnswer(pc1, pc2);
      await Promise.all([
        waitForConnectionState(pc1, "connected", 10_000),
        waitForConnectionState(pc2, "connected", 10_000),
      ]);
      const remote1 = new Promise<RTCDataChannel>((r) =>
        pc1.onDataChannel.subscribe(r),
      );
      const remote2 = new Promise<RTCDataChannel>((r) =>
        pc2.onDataChannel.subscribe(r),
      );

      // Act: 両端が最初の DataChannel を作り、回答側の setLocalDescription より
      // 先に相手へ answer を適用する (相手の INIT が先に association を張る)。
      const dc1 = pc1.createDataChannel("from-pc1");
      const dc2 = pc2.createDataChannel("from-pc2");
      await pc1.setLocalDescription(await pc1.createOffer());
      await pc2.setRemoteDescription(pc1.localDescription!);
      const answer = await pc2.createAnswer();
      await pc1.setRemoteDescription(answer);
      // 回答側は setLocalDescription 前に相手の INIT で association が確立する。
      await waitForSctpEstablished(pc2);
      await pc2.setLocalDescription(answer);
      const [onPc1, onPc2] = await Promise.race([
        Promise.all([remote1, remote2]),
        setTimeout(5_000).then(() => {
          throw new Error("the peer's DataChannel was not announced");
        }),
      ]);

      // Assert: 両端が stable で、相手のチャネルがそれぞれ通知される。
      expect(pc1.signalingState).toBe("stable");
      expect(pc2.signalingState).toBe("stable");
      expect(onPc2.label).toBe("from-pc1");
      expect(onPc1.label).toBe("from-pc2");
      // Assert: DTLS client は偶数、server は奇数 (RFC 8832 §6) で ID が異なる。
      expect(dc1.id).not.toBe(dc2.id);
      expect((dc1.id! - dc2.id!) % 2).not.toBe(0);
      expect(onPc2.id).toBe(dc1.id);
      expect(onPc1.id).toBe(dc2.id);

      // Act: それぞれのチャネルから送信する。
      const toPc2 = awaitMessage(onPc2);
      const toPc1 = awaitMessage(onPc1);
      dc1.send("hello from pc1");
      dc2.send("hello from pc2");

      // Assert: 同名の相手チャネルへ届き、別名のローカルチャネルへ誤配送されない。
      expect(await toPc2).toBe("hello from pc1");
      expect(await toPc1).toBe("hello from pc2");
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  }, 30_000);
});
