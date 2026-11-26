import { vi } from "vitest";

import { RTCPeerConnection } from "../../src";
import { createDataChannelPair, createIndexedMessages } from "../utils";
import {
  closed,
  negotiatedChannelsBeforeConnect,
  openChannelPair,
  peersBeforeConnect,
  recordMessagesUntilClose,
  settleSctpDeliveries,
} from "./dataChannelFlowUtils";

describe("datachannel/close delivers what was sent before close()", () => {
  test("messages sent before close() while connecting reach the peer, then both ends close", async () => {
    // Arrange: 未接続の negotiated channel にメッセージを積む
    const pending = negotiatedChannelsBeforeConnect();
    try {
      const messages = Array.from({ length: 20 }, (_, i) => `m${i}`);
      const remote = recordMessagesUntilClose(pending.remote);
      messages.forEach((m) => pending.local.send(m));

      // Act: 接続前に close() し、その後で接続する
      pending.local.close();
      // Assert: 接続前は closing のまま待ち、メッセージは捨てられない
      expect(pending.local.readyState).toBe("closing");
      expect(pending.local.bufferedAmount).toBe(
        messages.reduce((n, m) => n + m.length, 0),
      );
      await pending.connect();
      await Promise.all([closed(pending.local), closed(pending.remote)]);

      // Assert: 全メッセージが順番どおりに届き、その後で close が来る
      expect(remote.messages).toEqual(messages);
      expect(remote.messagesAtClose).toBe(messages.length);
      expect(pending.local.bufferedAmount).toBe(0);
    } finally {
      await pending.close();
    }
  });

  test("pc.close() before the association is established closes the channel and drops its messages", async () => {
    // Arrange: 未接続の negotiated channel にメッセージを積んで close() する
    const pending = negotiatedChannelsBeforeConnect();
    pending.local.send("never sent");
    pending.local.close();

    // Act: 確立しないまま PeerConnection を閉じる
    await pending.pc1.close();

    // Assert: closed になり、送られなかった分は bufferedAmount から減らない
    expect(pending.local.readyState).toBe("closed");
    expect(pending.local.bufferedAmount).toBe("never sent".length);
    await pending.pc2.close();
  });

  test("an in-band channel closed before its DATA_CHANNEL_OPEN is sent closes at once and sends nothing", async () => {
    // Arrange: 未接続の PeerConnection に in-band channel を作り、メッセージを積む
    const peers = peersBeforeConnect();
    try {
      const announced: string[] = [];
      peers.pc2.onDataChannel.subscribe((c) => announced.push(c.label));
      const unannounced = peers.pc1.createDataChannel("unannounced");
      const kept = peers.pc1.createDataChannel("kept");
      unannounced.send("never sent");

      // Act: DATA_CHANNEL_OPEN を送る前に閉じる
      unannounced.close();
      // Assert: closing を待たずにその場で closed になる
      expect(unannounced.readyState).toBe("closed");

      // Act: 接続し、閉じなかった channel が相手に届くまで待つ
      await peers.connect();
      await vi.waitFor(() => expect(kept.readyState).toBe("open"), {
        timeout: 5_000,
        interval: 20,
      });

      // Assert: 閉じた channel は相手に知らされず、メッセージも送られない
      await settleSctpDeliveries(100);
      expect(announced).toEqual(["kept"]);
      expect(unannounced.bufferedAmount).toBe("never sent".length);
    } finally {
      await peers.close();
    }
  });

  test.each([{}, { negotiated: true, id: 0 }])(
    "close() right after a burst (%o): every message arrives in order before close fires on the sender",
    async (options) => {
      // Arrange: 開いた channel の組
      const pair = await openChannelPair(options);
      try {
        const messages = createIndexedMessages(2_000, 1_000);
        const remote = recordMessagesUntilClose(pair.remote);
        let receivedAtSenderClose = -1;
        pair.local.addEventListener("close", () => {
          receivedAtSenderClose = remote.messages.length;
        });

        // Act: 大量に送った直後に閉じる
        messages.forEach((m) => pair.local.send(m));
        pair.local.close();
        // Assert: close() 直後に bufferedAmount は減っていない
        expect(pair.local.bufferedAmount).toBe(2_000_000);
        await Promise.all([closed(pair.local), closed(pair.remote)]);

        // Assert: 送信側の close までに全メッセージが順番どおりに届いている
        expect(receivedAtSenderClose).toBe(messages.length);
        expect(remote.messages).toHaveLength(messages.length);
        remote.messages.forEach((m, i) =>
          expect((m as Buffer).equals(messages[i])).toBe(true),
        );
        expect(pair.local.bufferedAmount).toBe(0);
      } finally {
        await pair.close();
      }
    },
    30_000,
  );

  test("close() in the datachannel handler: the opener gets the ACK first, no error, both ends close", async () => {
    // Arrange: 相手が datachannel ハンドラの中ですぐ close() する
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    try {
      let remoteChannel: ReturnType<RTCPeerConnection["createDataChannel"]>;
      const remoteClosed = new Promise<void>((resolve) => {
        pc2.ondatachannel = ({ channel }) => {
          remoteChannel = channel;
          channel.close();
          closed(channel).then(resolve);
        };
      });
      const local = pc1.createDataChannel("closed-by-handler");
      const states: string[] = [];
      local.stateChanged.subscribe((state) => states.push(state));
      const errors: unknown[] = [];
      local.addEventListener("error", (e) => errors.push(e));
      pc1.onIceCandidate.subscribe((c) => c && pc2.addIceCandidate(c));
      pc2.onIceCandidate.subscribe((c) => c && pc1.addIceCandidate(c));

      // Act: 接続して両端が閉じるのを待つ
      await pc1.setLocalDescription(await pc1.createOffer());
      await pc2.setRemoteDescription(pc1.localDescription!);
      await pc2.setLocalDescription(await pc2.createAnswer());
      await pc1.setRemoteDescription(pc2.localDescription!);
      await Promise.all([remoteClosed, closed(local)]);
      await settleSctpDeliveries(200);

      // Assert: 開いた側は ACK で open になってから閉じ、例外も unhandled rejection も出ない
      expect(states).toEqual(["open", "closing", "closed"]);
      expect(remoteChannel!.readyState).toBe("closed");
      expect(errors).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await pc1.close();
      await pc2.close();
    }
  });

  test("closing fires on the end the peer closed, not on the end calling close()", async () => {
    // Arrange
    const [local, remote] = await createDataChannelPair({});
    const seen: string[] = [];
    local.onclosing = () => seen.push("local onclosing");
    local.addEventListener("closing", () => seen.push("local closing"));
    remote.onclosing = () => seen.push("remote onclosing");
    remote.addEventListener("closing", () => seen.push("remote closing"));

    // Act: 片側から閉じる
    local.close();
    // Assert: close() した側は closing になるが closing は通知しない (W3C)
    expect(local.readyState).toBe("closing");
    await vi.waitFor(() => expect(remote.readyState).toBe("closed"));

    // Assert: 相手側では onclosing と addEventListener の両方に 1 回ずつ届く
    expect(seen).toEqual(["remote onclosing", "remote closing"]);
    await vi.waitFor(() => expect(local.readyState).toBe("closed"));
  });

  test("pc.close() inside a stateChange subscriber of close() leaves the channel closed without error", async () => {
    // Arrange: closing になった瞬間に PeerConnection を閉じる購読者
    const pending = negotiatedChannelsBeforeConnect();
    pending.local.stateChanged.subscribe((state) => {
      if (state === "closing") void pending.pc1.close();
    });

    // Act: 購読者の中で pc.close() される close() を呼ぶ
    const act = () => pending.local.close();

    // Assert: 例外なく closed になる
    expect(act).not.toThrow();
    await vi.waitFor(() => expect(pending.local.readyState).toBe("closed"));
    await pending.pc2.close();
  });
});
