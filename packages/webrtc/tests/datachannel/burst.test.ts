import { RTCPeerConnection } from "../../src";
import {
  collectChannelMessages,
  createDataChannelPair,
  createIndexedMessages,
  startEventLoopLagMonitor,
} from "../utils";

describe("datachannel/burst", () => {
  test("large burst of send() is delivered in order and bufferedAmount drains", async () => {
    // Arrange
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    const [sender, receiver] = await createDataChannelPair({}, pc1, pc2);
    const messages = createIndexedMessages(5_000, 4_000);
    const total = messages.reduce((acc, m) => acc + m.length, 0);
    sender.bufferedAmountLowThreshold = 64 * 1024;
    let lowEvents = 0;
    sender.bufferedAmountLow.subscribe(() => lowEvents++);
    const receiving = collectChannelMessages(receiver, messages.length);
    const monitor = startEventLoopLagMonitor();

    // Act: 合計 20MB を同期的に一括 send する
    messages.forEach((m) => sender.send(m));
    const bufferedAfterSend = sender.bufferedAmount;
    const received = await receiving;
    const maxLagMs = monitor.stop();
    // 最後の send 完了通知 (SACK 後の microtask) を待つ
    await new Promise((r) => setTimeout(r, 100));

    // Assert: send 直後は全量がバッファされている
    expect(bufferedAfterSend).toBe(total);
    // Assert: 全メッセージが送信順のまま届く
    expect(received.length).toBe(messages.length);
    received.forEach((data, i) =>
      expect((data as Buffer).equals(messages[i])).toBe(true),
    );
    // Assert: bufferedAmount は 0 に戻り、しきい値を跨いだ時に 1 回だけ bufferedamountlow が発火する
    expect(sender.bufferedAmount).toBe(0);
    expect(lowEvents).toBe(1);
    // Assert: 転送後も接続は維持され、イベントループ遅延は consent 応答タイムアウト (1000ms) より十分小さい
    expect(pc1.connectionState).toBe("connected");
    expect(pc1.iceConnectionState).toBe("connected");
    expect(pc2.connectionState).toBe("connected");
    expect(maxLagMs).toBeLessThan(500);

    await pc1.close();
    await pc2.close();
  }, 60_000);
});
