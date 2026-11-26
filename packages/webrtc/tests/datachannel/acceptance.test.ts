import { describe, expect, test, vi } from "vitest";

import type { RTCDataChannel } from "../../src";
import { collectChannelMessages, createIndexedMessages } from "../utils";
import {
  channelsToCloseWhileSending,
  closed,
  injectDataLoss,
  openChannelPair,
  peersBeforeConnect,
  recordBufferedAmountLow,
  recordMessagesUntilClose,
  settleSctpDeliveries,
} from "./dataChannelFlowUtils";

/**
 * Acceptance test of ticket 4b9e1b10: the downstream adapter needs only the
 * public `send()` / `close()` / `bufferedAmount` / `bufferedamountlow` API.
 * Messages sent before `close()` are delivered (also before the connection is
 * up), closing inside `ondatachannel` does not throw, empty messages are sent,
 * the README high / low water mark sends everything, and what pc.close() threw
 * away unsent is not reported as sent. Real peer connections.
 */
describe("acceptance: DataChannel backpressure and close through the public API only", () => {
  test.each([{ mode: "before-connect" as const }, { mode: "open" as const }])(
    "($mode) 4.2章 ①: close() の前に send() したメッセージがすべて順番どおり届いてから両側が closed になる",
    async ({ mode }) => {
      const { local, remote, connect, close } =
        await channelsToCloseWhileSending(mode);
      const sent = createIndexedMessages(32, 8 * 1024);
      const received = recordMessagesUntilClose(remote);
      try {
        // Act: メッセージを送った直後に close() する (未接続、または送信が詰まっている間)。
        for (const message of sent) local.send(message);
        const bufferedAtClose = local.bufferedAmount;
        local.close();

        // Assert: close() の時点で未送信分が残っており、それが捨てられずに channel は closing のまま待つ。
        expect(bufferedAtClose).toBeGreaterThan(0);
        expect(local.readyState).toBe("closing");
        expect(local.bufferedAmount).toBe(bufferedAtClose);

        // Act: 接続して、両側の close を待つ。
        await connect();
        await Promise.all([closed(local), closed(remote)]);

        // Assert: 受信側の close までに、全メッセージが順番どおり届いている。
        expect(received.messagesAtClose).toBe(sent.length);
        expect(received.messages).toEqual(sent);
      } finally {
        await close();
      }
    },
  );

  test("4.2章 ②: ondatachannel の中で close() すると、受信側は open せずに閉じ、開いた側は open の後に close を受け、例外も出ない", async () => {
    const { pc1, pc2, connect, close } = peersBeforeConnect();
    const errors: unknown[] = [];
    const onUnhandled = (reason: unknown) => errors.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const opener = pc1.createDataChannel("closed-by-peer");
      const events: string[] = [];
      opener.addEventListener("open", () => events.push("open"));
      opener.addEventListener("close", () => events.push("close"));
      opener.addEventListener("error", (e) => errors.push(e));
      let accepted: RTCDataChannel | undefined;
      const acceptedEvents: string[] = [];
      pc2.ondatachannel = ({ channel }) => {
        accepted = channel;
        channel.addEventListener("open", () => acceptedEvents.push("open"));
        channel.addEventListener("close", () => acceptedEvents.push("close"));
        channel.close();
      };

      // Act: 接続し、受信側が ondatachannel の中で close() する。
      await connect();
      await vi.waitFor(() => expect(opener.readyState).toBe("closed"), {
        timeout: 5000,
      });

      // Assert: DCEP ACK が reset より先に届くので、開いた側は open → close の順に受ける。
      expect(events).toEqual(["open", "close"]);
      // Assert: ハンドラの中で閉じた受信側は open を発火せず、close だけを受ける。
      await vi.waitFor(() => expect(accepted?.readyState).toBe("closed"));
      expect(acceptedEvents).toEqual(["close"]);
      // Assert: 例外も unhandled rejection も出ない。
      expect(errors).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await close();
    }
  });

  test('4.1章 ③: send("") / send(Buffer.alloc(0)) が空メッセージとして順番どおり届き、bufferedAmount は増えない', async () => {
    const { local, remote, close } = await openChannelPair();
    try {
      const received = collectChannelMessages(remote, 4);

      // Act: 通常のメッセージの間に空の string と空の Buffer を送る。
      local.send("before");
      const bufferedBeforeEmpty = local.bufferedAmount;
      local.send("");
      local.send(Buffer.alloc(0));

      // Assert: 空メッセージは bufferedAmount に何も足さない。
      expect(local.bufferedAmount).toBe(bufferedBeforeEmpty);

      local.send("after");
      // Assert: ピアに "" と空 Buffer として、前後のメッセージと順番どおりに届く。
      expect(await received).toEqual(["before", "", Buffer.alloc(0), "after"]);
    } finally {
      await close();
    }
  });

  test("4.3章: README の high / low water mark だけで全メッセージを送り切れ、bufferedAmount は読み取り専用", async () => {
    const { local, remote, close } = await openChannelPair();
    try {
      const HIGH_WATER_MARK = 64 * 1024;
      local.bufferedAmountLowThreshold = 16 * 1024;
      const chunks = createIndexedMessages(64, 8 * 1024);
      const received = collectChannelMessages(remote, chunks.length);
      let waits = 0;

      // Act: README の例どおり、high water mark を超えたら bufferedamountlow を待って送る。
      for (const chunk of chunks) {
        if (local.bufferedAmount > HIGH_WATER_MARK) {
          waits++;
          await new Promise<void>((resolve) =>
            local.addEventListener("bufferedamountlow", () => resolve(), {
              once: true,
            }),
          );
        }
        local.send(chunk);
      }

      // Assert: 送信は詰まって待ったが、bufferedamountlow で必ず再開し、全メッセージが順番どおり届く。
      expect(waits).toBeGreaterThan(0);
      expect(await received).toEqual(chunks);
      // Assert: 届いた後は bufferedAmount が 0 に戻り、外から書き換えられない。
      await vi.waitFor(() => expect(local.bufferedAmount).toBe(0));
      expect(() => {
        (local as { bufferedAmount: number }).bufferedAmount = 1;
      }).toThrow(TypeError);
    } finally {
      await close();
    }
  });

  test("2.2章: pc.close() で送れなかった分は bufferedAmount に残り、bufferedamountlow で送れたと通知しない", async () => {
    const { pc1, local, close } = await openChannelPair();
    try {
      injectDataLoss(pc1, () => true);
      const lows = recordBufferedAmountLow(local);
      for (let i = 0; i < 200; i++) local.send(Buffer.alloc(1_000));
      await settleSctpDeliveries(100);
      const unsent = local.bufferedAmount;

      // Act: 未送信分が残ったまま PeerConnection を閉じる。
      await pc1.close();
      await settleSctpDeliveries(300);

      // Assert: 未送信分が残っていた (前提) うえで、閉じた後も bufferedAmount は減らない。
      expect(unsent).toBeGreaterThan(0);
      expect(local.bufferedAmount).toBe(unsent);
      // Assert: bufferedamountlow は一度も来ない (送れたと誤認させない)。
      expect(lows.event + lows.handler + lows.listener).toBe(0);
    } finally {
      await close();
    }
  });
});
