import { vi } from "vitest";

import { WEBRTC_BINARY_EMPTY, WEBRTC_STRING_EMPTY } from "../../src/const";
import { captureSctpSendOptions, collectChannelMessages } from "../utils";
import {
  closed,
  holdLowerSends,
  injectDataLoss,
  negotiatedChannelsBeforeConnect,
  nextBufferedAmountLow,
  openChannelPair,
  recordBufferedAmountLow,
  recordMessagesUntilClose,
  settleSctpDeliveries,
} from "./dataChannelFlowUtils";

const hello = "hello";

describe.each([{}, { negotiated: true, id: 0 }])(
  "datachannel/bufferedAmount (%o)",
  (options) => {
    test("is read-only", async () => {
      // Arrange
      const pair = await openChannelPair(options);
      try {
        // Act / Assert: 代入は strict mode で TypeError になり、値は変わらない
        expect(() => {
          (pair.local as { bufferedAmount: number }).bufferedAmount = 10;
        }).toThrow(TypeError);
        expect(pair.local.bufferedAmount).toBe(0);
      } finally {
        await pair.close();
      }
    });

    test("send() adds the UTF-8 byte length synchronously", async () => {
      // Arrange
      const pair = await openChannelPair(options);
      try {
        // Act: 3 バイトの文字を含む文字列と Buffer を送る
        pair.local.send("aあ");
        pair.local.send(Buffer.alloc(3));

        // Assert: send() から戻った時点で UTF-8 / バイト長の合計だけ増えている
        expect(pair.local.bufferedAmount).toBe(4 + 3);
      } finally {
        await pair.close();
      }
    });

    test("send() on a closing or closed channel is ignored", async () => {
      // Arrange
      const pair = await openChannelPair(options);
      try {
        const remote = recordMessagesUntilClose(pair.remote);
        pair.local.close();

        // Act: closing 中に送る
        pair.local.send(hello);
        // Assert: 数えられない
        expect(pair.local.readyState).toBe("closing");
        expect(pair.local.bufferedAmount).toBe(0);

        // Act: closed 後に送る
        await closed(pair.local);
        pair.local.send(hello);
        await settleSctpDeliveries(50);

        // Assert: どちらも数えられず、相手にも届かない
        expect(pair.local.bufferedAmount).toBe(0);
        expect(pair.local.messagesSent).toBe(0);
        expect(pair.local.bytesSent).toBe(0);
        expect(remote.messages).toEqual([]);
      } finally {
        await pair.close();
      }
    });

    test("bufferedamountlow fires once per downward crossing, through every notification", async () => {
      // Arrange: 閾値 0 (既定)
      const pair = await openChannelPair(options);
      try {
        const record = recordBufferedAmountLow(pair.local);

        // Act: 2 通続けて送る
        pair.local.send(hello);
        pair.local.send(hello);
        // Assert: 送信直後はまだ減っておらず、通知もない
        expect(pair.local.bufferedAmount).toBe(2 * hello.length);
        expect(record.event).toBe(0);

        await nextBufferedAmountLow(pair.local);
        await settleSctpDeliveries(50);

        // Assert: 0 に落ちたとき 1 回だけ、3 種類の通知がそれぞれ届く
        expect(record).toEqual({
          event: 1,
          handler: 1,
          listener: 1,
          amounts: [0],
        });

        // Act: もう 1 通送る
        pair.local.send(hello);
        await nextBufferedAmountLow(pair.local);

        // Assert: メッセージごとに上から跨げば再び通知される
        expect(record.event).toBe(2);
        expect(record.handler).toBe(2);
        expect(record.listener).toBe(2);
      } finally {
        await pair.close();
      }
    });

    test("a message handed to SCTP is subtracted even while a later message's lower transport send is held", async () => {
      // Arrange: 1 通目を送った直後から、下位 transport の送信を保留させる
      const pair = await openChannelPair(options);
      pair.local.send(hello);
      const hold = holdLowerSends(pair.pc1);
      try {
        const record = recordBufferedAmountLow(pair.local);

        // Act: 2 通目を送り、保留中の送信を残したまま処理を進める
        pair.local.send(hello);
        await settleSctpDeliveries(50);

        // Assert: 2 通目の下位送信が終わっていなくても、両方とも SCTP に渡った分が減算され通知される
        expect(hold.held.packets).toBeGreaterThan(0);
        expect(pair.local.bufferedAmount).toBe(0);
        expect(record.event).toBe(1);
      } finally {
        hold.release();
        await pair.close();
      }
    });

    test("onbufferedamountlow receives the same Event object as the bufferedamountlow listeners", async () => {
      // Arrange: ハンドラとリスナーの両方で受け取ったイベントを記録する
      const pair = await openChannelPair(options);
      try {
        const received: { handler?: Event; listener?: Event } = {};
        pair.local.onbufferedamountlow = (event) => {
          received.handler = event;
        };
        pair.local.addEventListener("bufferedamountlow", (event: Event) => {
          received.listener = event;
        });

        // Act: 送って bufferedAmount を閾値 0 まで下げる
        pair.local.send(hello);
        await nextBufferedAmountLow(pair.local);

        // Assert: ハンドラは type が bufferedamountlow の Event を受け取り、リスナーと同じオブジェクトである
        expect(received.handler).toBeInstanceOf(globalThis.Event);
        expect(received.handler?.type).toBe("bufferedamountlow");
        expect(received.handler).toBe(received.listener);
      } finally {
        await pair.close();
      }
    });

    test("every event handler receives the same Event object as the listeners", async () => {
      // Arrange: open 前のチャネルで、各イベントのハンドラとリスナーの受け取ったイベントを記録する
      const peers = negotiatedChannelsBeforeConnect(options.id ?? 1);
      const channel = peers.local;
      const types = ["open", "bufferedamountlow", "close"] as const;
      const received = Object.fromEntries(
        types.map((type) => [
          type,
          { handler: [] as Event[], listener: [] as Event[] },
        ]),
      ) as Record<
        (typeof types)[number],
        { handler: Event[]; listener: Event[] }
      >;
      for (const type of types) {
        channel[`on${type}`] = (event) => {
          received[type].handler.push(event);
        };
        channel.addEventListener(type, (event: Event) => {
          received[type].listener.push(event);
        });
      }
      const remoteClosing: { handler: Event[]; listener: Event[] } = {
        handler: [],
        listener: [],
      };
      peers.remote.onclosing = (event) => {
        remoteClosing.handler.push(event);
      };
      peers.remote.addEventListener("closing", (event: Event) => {
        remoteClosing.listener.push(event);
      });
      try {
        // Act: 接続して open、送信して bufferedamountlow、close して両端の close / closing を起こす
        await peers.connect();
        if (channel.readyState !== "open") {
          await new Promise((resolve) =>
            channel.addEventListener("open", resolve, { once: true }),
          );
        }
        channel.send(hello);
        await nextBufferedAmountLow(channel);
        channel.close();
        await closed(channel);
        await closed(peers.remote);

        // Assert: どのハンドラも type 付きの Event を 1 回受け取り、リスナーと同じオブジェクトである
        for (const [type, record] of [
          ...Object.entries(received),
          ["closing", remoteClosing] as const,
        ]) {
          expect(record.handler).toHaveLength(1);
          expect(record.handler[0]).toBeInstanceOf(globalThis.Event);
          expect(record.handler[0]!.type).toBe(type);
          expect(record.handler[0]).toBe(record.listener[0]);
        }
      } finally {
        await peers.close();
      }
    });

    test("a threshold reached exactly notifies once; a threshold raised above the amount does not notify", async () => {
      // Arrange: 閾値 = 1 通分
      const pair = await openChannelPair(options);
      try {
        const record = recordBufferedAmountLow(pair.local);
        pair.local.bufferedAmountLowThreshold = hello.length;

        // Act: 2 通送ると 10 -> 5 (閾値ちょうど) -> 0 と減る
        pair.local.send(hello);
        pair.local.send(hello);
        await nextBufferedAmountLow(pair.local);
        await settleSctpDeliveries(50);

        // Assert: 閾値ちょうどに達したときの 1 回だけで、0 に落ちても再通知しない
        expect(record.amounts).toEqual([hello.length]);
        expect(pair.local.bufferedAmount).toBe(0);

        // Act: 送信後、残量より上に閾値を変えてから送信完了を待つ
        pair.local.send(hello);
        pair.local.bufferedAmountLowThreshold = 1_000;
        await settleSctpDeliveries(100);

        // Assert: 上から跨いでいないので通知されない
        expect(pair.local.bufferedAmount).toBe(0);
        expect(record.event).toBe(1);
      } finally {
        await pair.close();
      }
    });

    test("empty string and empty Buffer arrive in order, bufferedAmount stays 0, stats count them", async () => {
      // Arrange
      const pair = await openChannelPair(options);
      try {
        const calls = captureSctpSendOptions(pair.pc1.sctpTransport!);
        const receiving = collectChannelMessages(pair.remote, 4);

        // Act: 空メッセージを通常のメッセージの間に送る
        pair.local.send("a");
        pair.local.send("");
        pair.local.send(Buffer.alloc(0));
        pair.local.send("b");

        // Assert: 空メッセージは bufferedAmount を増やさない
        expect(pair.local.bufferedAmount).toBe(2);
        const received = await receiving;

        // Assert: 空文字列 / 空 Buffer として順番どおりに届く
        expect(received).toEqual(["a", "", Buffer.alloc(0), "b"]);
        expect(typeof received[1]).toBe("string");
        expect(Buffer.isBuffer(received[2])).toBe(true);
        // Assert: PPID 56 / 57 (RFC 8831 6.6) で送られる
        expect(calls.map((c) => c.ppId)).toEqual([
          51,
          WEBRTC_STRING_EMPTY,
          WEBRTC_BINARY_EMPTY,
          51,
        ]);
        // Assert: 統計はメッセージ数を数え、空メッセージのバイトは数えない
        await settleSctpDeliveries(50);
        expect(pair.local.bufferedAmount).toBe(0);
        expect(pair.local.messagesSent).toBe(4);
        expect(pair.local.bytesSent).toBe(2);
        expect(pair.remote.messagesReceived).toBe(4);
        expect(pair.remote.bytesReceived).toBe(2);
      } finally {
        await pair.close();
      }
    });

    test("an empty message sent while connecting arrives once connected", async () => {
      // Arrange: 未接続の negotiated channel
      const pending = negotiatedChannelsBeforeConnect();
      try {
        const receiving = collectChannelMessages(pending.remote, 2);

        // Act: 接続前に空メッセージを送り、接続する
        pending.local.send("");
        pending.local.send(Buffer.alloc(0));
        await pending.connect();

        // Assert: 接続後に届き、bufferedAmount は 0 のまま
        expect(await receiving).toEqual(["", Buffer.alloc(0)]);
        expect(pending.local.bufferedAmount).toBe(0);
      } finally {
        await pending.close();
      }
    });

    test("pc.close() keeps bufferedAmount and fires no bufferedamountlow", async () => {
      // Arrange: DATA を全て落として SACK が返らないようにし、輻輳ウィンドウを
      // 超える量を積む。最初のウィンドウ分が送られた後は残りが送られずに残る。
      const pair = await openChannelPair(options);
      injectDataLoss(pair.pc1, () => true);
      const record = recordBufferedAmountLow(pair.local);
      for (let i = 0; i < 200; i++) pair.local.send(Buffer.alloc(1_000));
      await settleSctpDeliveries(100);
      const before = pair.local.bufferedAmount;
      expect(before).toBeGreaterThan(0);

      // Act: PeerConnection を閉じる
      const closing = pair.pc1.close();
      // Assert: 閉じた直後に減らない
      expect(pair.local.bufferedAmount).toBe(before);
      await closing;
      await settleSctpDeliveries(300);

      // Assert: 送られずに捨てた分は減らず、閉じた後に通知もない
      expect(pair.local.readyState).toBe("closed");
      expect(pair.local.bufferedAmount).toBe(before);
      expect(record.event + record.handler + record.listener).toBe(0);
      await pair.pc2.close();
    });

    test("close() does not decrease bufferedAmount immediately; it drains while closing", async () => {
      // Arrange
      const pair = await openChannelPair(options);
      try {
        pair.local.send(Buffer.from(hello));

        // Act: 送信直後に閉じる
        pair.local.close();

        // Assert: close() の時点では減らない (W3C)
        expect(pair.local.bufferedAmount).toBe(hello.length);
        // Assert: closing 中に実際に送られた分は減る
        await nextBufferedAmountLow(pair.local);
        expect(pair.local.bufferedAmount).toBe(0);
      } finally {
        await pair.close();
      }
    });

    test("with loss every message arrives and bufferedAmount reaches 0 before the ACK", async () => {
      // Arrange: pc1 の DATA を全て落とす
      const pair = await openChannelPair(options);
      try {
        const loss = injectDataLoss(pair.pc1, () => true);
        const received: (string | Buffer)[] = [];
        pair.remote.onMessage.subscribe((m) => received.push(m));

        // Act: 送信し、ネットワークに渡るまで待つ
        pair.local.send(hello);
        await nextBufferedAmountLow(pair.local);

        // Assert: 相手に届く (ACK される) 前に bufferedAmount は 0 になっている
        expect(pair.local.bufferedAmount).toBe(0);
        expect(received).toEqual([]);
        expect(loss.dropped).toBeGreaterThan(0);

        // Act: 一部だけ落とすように変え、続けて送る
        loss.enabled = false;
        const rest = Array.from({ length: 50 }, (_, i) => `m${i}`);
        injectDataLoss(pair.pc1, (index) => index % 4 === 1);
        rest.forEach((m) => pair.local.send(m));
        await vi.waitFor(() => expect(received).toHaveLength(51), {
          timeout: 20_000,
          interval: 50,
        });

        // Assert: 再送で全メッセージが順番どおりに届き、bufferedAmount は 0 に戻る
        expect(received).toEqual([hello, ...rest]);
        expect(pair.local.bufferedAmount).toBe(0);
      } finally {
        await pair.close();
      }
    }, 30_000);

    test("a legacy 3-element queue entry is still sent (v0.29.0 compatibility)", async () => {
      // Arrange: werift <= 0.28 で空メッセージを送るための回避策 (v0.30.0 で削除するテスト)
      const pair = await openChannelPair(options);
      try {
        const transport = pair.pc1.sctpTransport! as any;
        const receiving = collectChannelMessages(pair.remote, 1);

        // Act: 3 要素のタプルを積んで flush する
        transport.dataChannelQueue.push([
          pair.local,
          WEBRTC_STRING_EMPTY,
          Buffer.from([0]),
        ]);
        pair.local.addBufferedAmount(1);
        pair.local.messagesSent += 1;
        transport.dataChannelFlush();

        // Assert: 今までどおり空文字列として届き、足した 1 バイトは送信で戻る
        expect(await receiving).toEqual([""]);
        await settleSctpDeliveries(50);
        expect(pair.local.bufferedAmount).toBe(0);
      } finally {
        await pair.close();
      }
    });
  },
);

describe("datachannel/bufferedAmount partial reliability", () => {
  test("messages abandoned by maxPacketLifeTime before they were sent are subtracted and notified", async () => {
    // Arrange: 寿命 100ms の channel で、pc1 の DATA を全て落とす
    const pair = await openChannelPair({ maxPacketLifeTime: 100 });
    try {
      injectDataLoss(pair.pc1, () => true);
      const record = recordBufferedAmountLow(pair.local);
      pair.local.bufferedAmountLowThreshold = 1_000;

      // Act: 輻輳ウィンドウに収まらない量を送り、寿命が過ぎるのを待つ
      for (let i = 0; i < 200; i++) pair.local.send(Buffer.alloc(1_000));
      const sent = pair.local.bufferedAmount;
      await vi.waitFor(() => expect(pair.local.bufferedAmount).toBe(0), {
        timeout: 10_000,
        interval: 50,
      });

      // Assert: 届かなくても abandon した分は減り、閾値を跨いだ通知が 1 回来る
      expect(sent).toBe(200_000);
      expect(record.event).toBe(1);
      expect(record.handler).toBe(1);
      expect(record.listener).toBe(1);
    } finally {
      await pair.close();
    }
  }, 20_000);

  test("maxRetransmits: 0 with loss drains bufferedAmount and notifies", async () => {
    // Arrange: 再送しない channel で、DATA パケットの 1/3 を落とす
    const pair = await openChannelPair({ maxRetransmits: 0 });
    try {
      injectDataLoss(pair.pc1, (index) => index % 3 === 0);
      const record = recordBufferedAmountLow(pair.local);

      // Act: 送って送信完了を待つ
      for (let i = 0; i < 50; i++) pair.local.send(Buffer.alloc(1_000));
      await vi.waitFor(() => expect(record.event).toBe(1), {
        timeout: 15_000,
        interval: 50,
      });

      // Assert: bufferedAmount は 0 になり、通知は 1 回
      expect(pair.local.bufferedAmount).toBe(0);
      expect(record.listener).toBe(1);
    } finally {
      await pair.close();
    }
  }, 20_000);
});

describe("datachannel/bufferedAmount API", () => {
  test("bufferedAmountLowThreshold defaults to 0 and accepts only 0..2^32-1", async () => {
    // Arrange
    const pair = await openChannelPair();
    try {
      // Assert: 既定値は 0
      expect(pair.local.bufferedAmountLowThreshold).toBe(0);

      // Act / Assert: 上限ちょうどは設定でき、範囲外は例外で値を変えない
      pair.local.bufferedAmountLowThreshold = 4294967295;
      expect(pair.local.bufferedAmountLowThreshold).toBe(4294967295);
      expect(() => {
        pair.local.bufferedAmountLowThreshold = 4294967296;
      }).toThrow();
      expect(() => {
        pair.local.bufferedAmountLowThreshold = -1;
      }).toThrow();
      expect(pair.local.bufferedAmountLowThreshold).toBe(4294967295);
    } finally {
      await pair.close();
    }
  });

  test("the deprecated addBufferedAmount() still notifies on a closed channel", async () => {
    // Arrange: closed になった channel
    const pair = await openChannelPair();
    await pair.close();
    expect(pair.local.readyState).toBe("closed");
    const record = recordBufferedAmountLow(pair.local);

    // Act: 旧 API で増やしてから閾値 0 まで減らす
    pair.local.addBufferedAmount(10);
    pair.local.addBufferedAmount(-10);

    // Assert: v0.28 までと同じく closed でも通知される
    expect(pair.local.bufferedAmount).toBe(0);
    expect(record.event).toBe(1);
    expect(record.handler).toBe(1);
    expect(record.listener).toBe(1);
  });
});
