import { describe, expect, test } from "vitest";

import {
  captureSentDcep,
  channelSetsOf,
  closeAll,
  closingStreamsOf,
  createNegotiatedPair,
  dcepOpen,
  deliver,
  emulateLegacyResetHandling,
  openChannelPair,
  openNegotiatedPair,
  receiveOn,
  sendStreamReset,
  setReverseResetTimeout,
  waitClosed,
  waitOpen,
  waitRemoteChannel,
} from "./815.helpers";

/**
 * RFC 8831 section 6.7: a data channel closes when both directions of its
 * stream are reset. Whatever data went over the stream (none, unordered or
 * ordered, from either end) and whichever end closes, `close` fires on both
 * ends only after both resets, so the stream ID is free at `close` and a
 * channel re-created on it is neither closed by a late reset of the old
 * channel nor left open when the peer closes it.
 */
type Closer = "local" | "remote" | "both";
type Traffic = "none" | "local" | "remote" | "both";

const closers: Closer[] = ["local", "remote", "both"];
const traffics: Traffic[] = ["none", "local", "remote", "both"];
const matrix = [true, false].flatMap((ordered) =>
  traffics.flatMap((traffic) =>
    closers.map((firstClose) => ({ ordered, traffic, firstClose })),
  ),
);

async function send(
  pair: Awaited<ReturnType<typeof openNegotiatedPair>>,
  traffic: Traffic,
) {
  if (traffic === "local" || traffic === "both") {
    await deliver(pair.local, pair.remote, "to-remote");
  }
  if (traffic === "remote" || traffic === "both") {
    await deliver(pair.remote, pair.local, "to-local");
  }
}

function close(
  channels: { local: { close(): void }; remote: { close(): void } },
  closer: Closer,
) {
  if (closer !== "remote") channels.local.close();
  if (closer !== "local") channels.remote.close();
}

describe("issue 815: a stream ID reused after a close (RFC 8831 section 6.7 reset in both directions)", () => {
  test.each(matrix)(
    "ordered=$ordered, data from $traffic, closed by $firstClose: the reused channel opens, carries data and closes from either end",
    async ({ ordered, traffic, firstClose }) => {
      // Arrange: 両端で open の negotiated channel (ID 4) に traffic どおり送信しておく。
      const pair = await openNegotiatedPair({ id: 4, ordered });
      try {
        await send(pair, traffic);

        // Act: firstClose の側から閉じる。
        close(pair, firstClose);
        await Promise.all([waitClosed(pair.local), waitClosed(pair.remote)]);

        // Assert: 両端とも閉じた channel を登録表に残さない。
        expect(channelSetsOf(pair.offerer).registered).toEqual([]);
        // Assert: ACK が送信待ちキューに残ることもない。
        expect(channelSetsOf(pair.answerer)).toEqual({
          registered: [],
          unannounced: [],
          queued: [],
        });

        // Act: 同じ ID 4 で作り直し、双方向に送る。
        const reused = createNegotiatedPair(pair.offerer, pair.answerer, {
          label: "reused",
          id: 4,
          ordered,
        });
        await Promise.all([waitOpen(reused.local), waitOpen(reused.remote)]);
        await deliver(reused.local, reused.remote, "reused-to-remote");
        await deliver(reused.remote, reused.local, "reused-to-local");

        // Assert: 古い channel の残りの reset は作り直した channel を閉じない。
        expect([reused.local.readyState, reused.remote.readyState]).toEqual([
          "open",
          "open",
        ]);

        // Act / Assert: 作り直した channel を local / remote のどちらから閉じても両端で閉じる。
        close(reused, firstClose === "local" ? "remote" : "local");
        await Promise.all([
          waitClosed(reused.local),
          waitClosed(reused.remote),
        ]);
      } finally {
        await closeAll(pair.offerer, pair.answerer);
      }
    },
  );
});

describe("issue 815: closing waits for the peer's reset", () => {
  test("close fires on neither end before both directions of the stream are reset", async () => {
    // Arrange: unordered の negotiated channel で、相手だけが送信している。
    const pair = await openNegotiatedPair({ id: 4, ordered: false });
    try {
      await deliver(pair.remote, pair.local, "to-local");
      const order: string[] = [];
      for (const [name, channel] of [
        ["local", pair.local],
        ["remote", pair.remote],
      ] as const) {
        channel.addEventListener("close", () => {
          // close 通知の時点で、その stream は close 中として追跡されていない。
          order.push(
            `${name}:${closingStreamsOf(name === "local" ? pair.offerer : pair.answerer).length}`,
          );
        });
      }

      // Act: こちらから閉じる。
      pair.local.close();
      await Promise.all([waitClosed(pair.local), waitClosed(pair.remote)]);

      // Assert: 両端とも両方向の reset 後に close を通知し、追跡を残さない。
      expect(order.sort()).toEqual(["local:0", "remote:0"]);
    } finally {
      await closeAll(pair.offerer, pair.answerer);
    }
  });

  test.each([true, false])(
    "a legacy peer that does not reset its side (ordered=%s, no data from it): close fires after reverseResetTimeout and the ID stays in use",
    async (ordered) => {
      // Arrange: 相手は develop の reset 処理で、こちらの待ち時間は 200ms。
      const pair = await openNegotiatedPair({ id: 4, ordered });
      emulateLegacyResetHandling(pair.answerer);
      setReverseResetTimeout(pair.offerer, 200);
      try {
        await deliver(pair.local, pair.remote, "to-remote");

        // Act: こちらから閉じる (相手は送信していないので reset を返さない)。
        pair.local.close();

        // Assert: 相手は即座に、こちらは待ち時間の後に閉じる。
        await waitClosed(pair.remote);
        await waitClosed(pair.local);
        expect(closingStreamsOf(pair.offerer)).toEqual([]);

        // Act / Assert: 相手の reset が届くまで stream 4 は再利用できない (後から届く reset が
        // 作り直した channel を閉じないように)。
        expect(() =>
          createNegotiatedPair(pair.offerer, pair.answerer, {
            label: "reused",
            id: 4,
            ordered,
          }),
        ).toThrow(expect.objectContaining({ name: "OperationError" }));

        // Act / Assert: 別の ID の channel は作れて、相手から閉じると両端で閉じる。
        const other = createNegotiatedPair(pair.offerer, pair.answerer, {
          label: "other",
          id: 6,
          ordered,
        });
        await Promise.all([waitOpen(other.local), waitOpen(other.remote)]);
        await deliver(other.remote, other.local, "other-to-local");
        other.remote.close();
        await Promise.all([waitClosed(other.local), waitClosed(other.remote)]);
      } finally {
        await closeAll(pair.offerer, pair.answerer);
      }
    },
  );

  test("a peer reset arriving after reverseResetTimeout closes nothing and frees the ID", async () => {
    // Arrange: 相手は reset を返さずに閉じ、こちらは待ち時間 (200ms) の後に閉じた。
    // 別の ID の channel が open のまま残っている。
    const pair = await openNegotiatedPair({ id: 4, ordered: false });
    emulateLegacyResetHandling(pair.answerer);
    setReverseResetTimeout(pair.offerer, 200);
    const bystander = createNegotiatedPair(pair.offerer, pair.answerer, {
      label: "bystander",
      id: 6,
      ordered: true,
    });
    try {
      await Promise.all([
        waitOpen(bystander.local),
        waitOpen(bystander.remote),
      ]);
      pair.local.close();
      await Promise.all([waitClosed(pair.remote), waitClosed(pair.local)]);

      // Act: 相手の stream 4 の reset が、待ち時間を過ぎてから届く。
      await sendStreamReset(pair.answerer, 4);
      // 相手の reset 要求に、こちらの応答が届くまで待つ。
      await expect
        .poll(
          () =>
            (pair.answerer as any).sctpManager.sctpTransport.sctp
              .reconfigRequest,
        )
        .toBeUndefined();

      // Assert: 遅れた reset はどの channel も閉じず、こちらから reset を返し直すこともない。
      expect(bystander.local.readyState).toBe("open");
      expect(
        (pair.offerer as any).sctpManager.sctpTransport.sctp.reconfigQueue,
      ).toEqual([]);

      // Act: 両方向の reset が揃ったので、同じ ID で作り直す。
      const reused = createNegotiatedPair(pair.offerer, pair.answerer, {
        label: "reused",
        id: 4,
        ordered: false,
      });
      await Promise.all([waitOpen(reused.local), waitOpen(reused.remote)]);

      // Assert: 作り直した channel は双方向に送受信でき、相手から閉じると両端で閉じる。
      await deliver(reused.local, reused.remote, "reused-to-remote");
      await deliver(reused.remote, reused.local, "reused-to-local");
      reused.remote.close();
      await Promise.all([waitClosed(reused.local), waitClosed(reused.remote)]);
      expect(bystander.local.readyState).toBe("open");
    } finally {
      await closeAll(pair.offerer, pair.answerer);
    }
  });

  test("pc.close() while waiting for the peer's reset closes the channel once and leaves no timer", async () => {
    // Arrange: 相手が reset を返さず、こちらが待っている channel。
    const pair = await openNegotiatedPair({ id: 4, ordered: false });
    emulateLegacyResetHandling(pair.answerer);
    setReverseResetTimeout(pair.offerer, 60_000);
    let closeEvents = 0;
    pair.local.addEventListener("close", () => closeEvents++);
    try {
      pair.local.close();
      await waitClosed(pair.remote);
      await expect.poll(() => closingStreamsOf(pair.offerer)).toEqual([4]);
      expect(pair.local.readyState).toBe("closing");

      // Act: 待っている間に PeerConnection を閉じる。
      await pair.offerer.close();

      // Assert: channel は 1 回だけ closed になり、追跡も残らない。
      expect(pair.local.readyState).toBe("closed");
      expect(closeEvents).toBe(1);
      expect(closingStreamsOf(pair.offerer)).toEqual([]);
    } finally {
      await closeAll(pair.offerer, pair.answerer);
    }
  });

  test.each(["local", "remote"] as const)(
    "in-band channel closed by %s: an unordered channel created on the freed ID opens and closes from the peer",
    async (closer) => {
      // Arrange: offerer が作った in-band channel "dc" (ID 1)。
      const pair = await openChannelPair();
      try {
        await deliver(pair.remote, pair.local, "to-local");

        // Act: 閉じて、空いた ID で unordered の channel を作る。
        (closer === "local" ? pair.local : pair.remote).close();
        await Promise.all([waitClosed(pair.local), waitClosed(pair.remote)]);
        const remoteAgain = waitRemoteChannel(pair.answerer, "again");
        const again = pair.offerer.createDataChannel("again", {
          ordered: false,
        });
        expect(again.id).toBe(1);
        await waitOpen(again);
        const received = await remoteAgain;
        await deliver(received, again, "again-to-local");

        // Assert: 相手から閉じると両端で閉じる。
        received.close();
        await Promise.all([waitClosed(again), waitClosed(received)]);
      } finally {
        await closeAll(pair.offerer, pair.answerer);
      }
    },
  );
});

describe("issue 815: what a closing channel accepts while its stream reset runs", () => {
  /** WEBRTC_STRING (RFC 8831 section 8)。 */
  const WEBRTC_STRING = 51;
  const WEBRTC_DCEP = 50;

  test("a message arriving while closing is discarded (W3C: not open discards it)", async () => {
    // Arrange: 両端で open の channel。open の間に届いたメッセージは配送される。
    const pair = await openChannelPair();
    const delivered: string[] = [];
    pair.local.onMessage.subscribe((data) => delivered.push(data.toString()));
    await receiveOn(
      pair.local,
      pair.local.id,
      WEBRTC_STRING,
      Buffer.from("while-open"),
    );

    try {
      // Act: 自分から閉じ (closing)、reset が終わる前にメッセージが届く。
      pair.local.close();
      expect(pair.local.readyState).toBe("closing");
      await receiveOn(
        pair.local,
        pair.local.id,
        WEBRTC_STRING,
        Buffer.from("while-closing"),
      );

      // Assert: closing 中のメッセージは配送も受信統計への加算もされない。
      expect(delivered).toEqual(["while-open"]);
      expect(pair.local.messagesReceived).toBe(1);
      // Assert: close はそのまま両端で完了する。
      await waitClosed(pair.local);
      await waitClosed(pair.remote);
    } finally {
      await closeAll(pair.offerer, pair.answerer);
    }
  });

  test("a DATA_CHANNEL_OPEN on the stream of a closing remote channel is not acknowledged", async () => {
    // Arrange: 相手が作った channel (answerer 側) を閉じ始め、answerer の DCEP 送信を記録する。
    const pair = await openChannelPair();
    const sent = captureSentDcep(pair.answerer);
    const announced: string[] = [];
    pair.answerer.onDataChannel.subscribe((c) => announced.push(c.label));
    pair.remote.close();
    expect(pair.remote.readyState).toBe("closing");

    try {
      // Act: reset が終わる前に、同じ stream で OPEN が届く。
      await receiveOn(
        pair.remote,
        pair.remote.id,
        WEBRTC_DCEP,
        dcepOpen("late-open"),
      );

      // Assert: ACK も新しい channel の通知もなく、元の close は両端で完了する。
      expect(sent.filter((m) => m.startsWith("ACK"))).toEqual([]);
      expect(announced).toEqual([]);
      await waitClosed(pair.remote);
      await waitClosed(pair.local);
      expect(channelSetsOf(pair.answerer).registered).toEqual([]);
    } finally {
      await closeAll(pair.offerer, pair.answerer);
    }
  });
});
