import { describe, expect, test, vi } from "vitest";

import { RTCPeerConnection } from "../../src";
import {
  LOW_NOTIFICATIONS,
  openDataChannelPair,
  recordBufferedAmountLow,
} from "./dataChannelTestUtils";

describe("datachannel/bufferedAmountLow", () => {
  test("every surface is notified once per crossing, in the order of the other channel events", async () => {
    // Arrange: open の channel と、3 つの通知面の記録
    const pair = await openDataChannelPair();
    const calls = recordBufferedAmountLow(pair.local);

    try {
      // Act: 1 通送り、送信完了で buffer が 0 (閾値 0) に戻るのを待つ
      pair.local.send("hello");
      await vi.waitFor(() => expect(calls.length).toBe(3));

      // Assert: bufferedAmountLow → onbufferedamountlow → "bufferedamountlow" の順に各 1 回
      expect(calls).toEqual([...LOW_NOTIFICATIONS]);
      expect(pair.local.bufferedAmount).toBe(0);
    } finally {
      await pair.close();
    }
  });

  test.each([
    {
      name: "a decrease that stays above the threshold does not fire",
      threshold: 10,
      start: 30,
      decrease: 15,
      fires: false,
    },
    {
      name: "a decrease to exactly the threshold fires",
      threshold: 10,
      start: 30,
      decrease: 20,
      fires: true,
    },
    {
      name: "a decrease from the threshold (not above it) does not fire",
      threshold: 10,
      start: 10,
      decrease: 10,
      fires: false,
    },
    {
      name: "threshold 0: draining to 0 fires",
      threshold: 0,
      start: 5,
      decrease: 5,
      fires: true,
    },
  ])("$name", async ({ threshold, start, decrease, fires }) => {
    // Arrange: bufferedAmount を start にした open の channel
    const pair = await openDataChannelPair();
    pair.local.bufferedAmountLowThreshold = threshold;
    pair.local.addBufferedAmount(start);
    const calls = recordBufferedAmountLow(pair.local);

    try {
      // Act: 送信完了として decrease だけ減らす
      pair.local.addBufferedAmount(-decrease);

      // Assert: 閾値を上から跨いだときだけ 3 面へ通知される
      expect(calls).toEqual(fires ? [...LOW_NOTIFICATIONS] : []);
      expect(pair.local.bufferedAmount).toBe(start - decrease);
    } finally {
      pair.local.addBufferedAmount(-pair.local.bufferedAmount, { sent: false });
      await pair.close();
    }
  });

  test("several sends fire once; a send after each drain fires again (WPT RTCDataChannel-bufferedAmount)", async () => {
    // Arrange: open の channel
    const pair = await openDataChannelPair();
    let lows = 0;
    pair.local.onbufferedamountlow = () => lows++;

    try {
      // Act: 3 通をまとめて送って buffer が空になるのを待つ
      pair.local.send("a");
      pair.local.send("bb");
      pair.local.send(Buffer.from([1, 2, 3]));
      await vi.waitFor(() => expect(pair.local.bufferedAmount).toBe(0));
      await new Promise((r) => setTimeout(r, 50));

      // Assert: まとめた送信では 1 回だけ
      expect(lows).toBe(1);

      // Act: 空になってから 1 通ずつ 2 回送る
      pair.local.send("c");
      await vi.waitFor(() => expect(lows).toBe(2));
      pair.local.send("d");

      // Assert: 送信ごとに閾値を跨ぐので毎回発火する
      await vi.waitFor(() => expect(lows).toBe(3));
    } finally {
      await pair.close();
    }
  });

  test("onbufferedamountlow receives the same bufferedamountlow Event as the listeners", async () => {
    // Arrange: ハンドラと addEventListener がそれぞれ受け取る event を記録する
    const pair = await openDataChannelPair();
    const seen: Event[] = [];
    pair.local.onbufferedamountlow = (event) => {
      // ブラウザ向けコードは event.type を参照する
      seen.push(event);
      targets.push([event.target, event.currentTarget]);
    };
    const targets: unknown[][] = [];
    pair.local.addEventListener("bufferedamountlow", (event: Event) => {
      seen.push(event);
      targets.push([event.target, event.currentTarget]);
    });

    try {
      // Act: 1 通送り、閾値を跨ぐのを待つ
      pair.local.send("hello");
      await vi.waitFor(() => expect(seen.length).toBe(2));

      // Assert: 両方に type "bufferedamountlow" の同一 Event が渡る
      expect(seen[0].type).toBe("bufferedamountlow");
      expect(seen[1]).toBe(seen[0]);
      // target / currentTarget はどちらの面でも対象チャネルを指す
      expect(targets).toEqual([
        [pair.local, pair.local],
        [pair.local, pair.local],
      ]);
    } finally {
      await pair.close();
    }
  });

  test("a throwing onbufferedamountlow skips no other surface and sending continues", async () => {
    // Arrange: 先に呼ばれる 2 面が例外を投げる
    const pair = await openDataChannelPair();
    pair.local.bufferedAmountLow.subscribe(() => {
      throw new Error("bufferedAmountLow");
    });
    pair.local.onbufferedamountlow = () => {
      throw new Error("onbufferedamountlow");
    };
    let events = 0;
    pair.local.addEventListener("bufferedamountlow", () => events++);
    const received: string[] = [];
    pair.remote.onMessage.subscribe((data) => received.push(data.toString()));

    try {
      // Act: 2 通を 1 通ずつ送る
      pair.local.send("first");
      await vi.waitFor(() => expect(events).toBe(1));
      pair.local.send("second");

      // Assert: 後続の通知面に届き、送信も buffer の減算も続く
      await vi.waitFor(() => expect(received).toEqual(["first", "second"]));
      await vi.waitFor(() => expect(events).toBe(2));
      expect(pair.local.bufferedAmount).toBe(0);
    } finally {
      await pair.close();
    }
  });

  test("a close before the association is established discards the buffer without bufferedamountlow", async () => {
    // Arrange: 交渉前の channel に 2 通積む (SCTP 未確立なのでキューに残る)
    const pc = new RTCPeerConnection();
    const channel = pc.createDataChannel("unsent");
    channel.send("abc");
    channel.send(Buffer.from([1, 2]));
    const calls = recordBufferedAmountLow(channel);
    const bufferedBeforeClose = channel.bufferedAmount;

    try {
      // Act: 未確立のまま close する
      channel.close();

      // Assert: 未送信分は bufferedAmount から除かれ 0 になるが、送信していないので low は発火しない
      expect(bufferedBeforeClose).toBe(5);
      expect(channel.readyState).toBe("closed");
      expect(channel.bufferedAmount).toBe(0);
      expect(calls).toEqual([]);
    } finally {
      await pc.close();
    }
  });

  test("pc.close() discards unsent messages without bufferedamountlow", async () => {
    // Arrange: 交渉前の channel にメッセージを積む
    const pc = new RTCPeerConnection();
    const channel = pc.createDataChannel("unsent");
    channel.send("abcdef");
    const calls = recordBufferedAmountLow(channel);

    // Act: PeerConnection を閉じる (transport stop の破棄経路)
    await pc.close();

    // Assert: buffer は 0 に戻り、low は発火しない
    expect(channel.bufferedAmount).toBe(0);
    expect(calls).toEqual([]);
  });

  test("a low listener sending on the channel it closed does not loop", async () => {
    // Arrange: low ハンドラで close し、その後も send し続ける channel
    const pair = await openDataChannelPair();
    let lows = 0;
    pair.local.onbufferedamountlow = () => {
      lows++;
      if (lows > 100) return; // 回帰時にテストを止めるための上限
      pair.local.close();
      pair.local.send("again");
    };

    try {
      // Act: 1 通送って low を発火させる
      pair.local.send("first");
      await vi.waitFor(() => expect(lows).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 50));

      // Assert: closing channel への再送は破棄経路で減算され、low は再発火しない
      expect(lows).toBe(1);
      expect(pair.local.bufferedAmount).toBe(0);
    } finally {
      await pair.close();
    }
  });
});
