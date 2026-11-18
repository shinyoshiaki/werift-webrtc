import { vi } from "vitest";

import { type RTCDataChannel, RTCPeerConnection } from "../../src";
import { rejectApplicationSection } from "../negotiation/harness/negotiationTransactionUtils";
import {
  attachLimitedTransport,
  channelSetsOf,
  closeAll,
  createPeers,
  type NotificationObservation,
  negotiate,
  observeAt,
  openChannelPair,
  openProvisionalChannel,
  throwing,
  tryCreateDataChannel,
  waitOpen,
  waitRemoteChannel,
} from "./815.helpers";

/**
 * Issue #815 で追加・変更した DataChannel の通知経路に共通の不変条件。
 * 1. 通知はリスナー単位で隔離する: 例外を投げるリスナーがあっても、後続の
 *    リスナー・他の channel・呼び出し元 (SCTP 受信、close()、rollback) は止まらない。
 * 2. 通知は状態が確定してから出す: close 通知の時点で見える PeerConnection /
 *    SCTP / DTLS / channel の状態は develop と同じ。
 * 3. close / error コールバックからの再入で、登録表・OPEN 未送信の集合・送信待ち
 *    キューに閉じた channel が残らない。
 */

/** close 通知時に見える状態 (develop 7a1cb6f6c で同じ操作をして得た値)。 */
const atClose = (
  connectionState: string,
  sctpState: string,
  dtlsState: string,
): NotificationObservation => ({
  connectionState,
  sctpState,
  dtlsState,
  id: 1,
  readyState: "closed",
});

describe("issue 815: state visible at the close notification", () => {
  test.each([
    {
      path: "local pc.close()",
      expected: atClose("closed", "closed", "closed"),
      act: async ({ offerer }: Pair) => offerer.close(),
    },
    {
      path: "remote pc.close() (SCTP ABORT)",
      expected: atClose("connected", "closed", "connected"),
      act: async ({ answerer }: Pair) => answerer.close(),
    },
    {
      path: "remote stream reset",
      expected: atClose("connected", "connected", "connected"),
      act: async ({ remote }: Pair) => remote.close(),
    },
    {
      path: "DTLS close_notify received",
      expected: atClose("connected", "closed", "closed"),
      act: async ({ offerer }: Pair) => dtlsOf(offerer).dtls.onClose.execute(),
    },
    {
      path: "DTLS fatal alert",
      expected: atClose("failed", "closed", "failed"),
      act: async ({ offerer }: Pair) =>
        dtlsOf(offerer).dtls.onError.execute(new Error("fatal alert")),
    },
  ])("$path", async ({ expected, act }) => {
    // Arrange: 両端で open の channel と、close 通知時の状態の記録。
    const pair = await openChannelPair();
    const observed = observeAt(pair.offerer, pair.local);

    try {
      // Act: 経路ごとの操作で channel を閉じる。
      await act(pair);
      await vi.waitFor(() => expect(observed).toHaveLength(1));

      // Assert: 通知時点の状態は develop と同じで、登録表に閉じた channel が残らない。
      expect(observed).toEqual([expected]);
      expect(channelSetsOf(pair.offerer).registered).toEqual([]);
    } finally {
      await closeAll(pair.offerer, pair.answerer);
    }
  });

  test.each([
    {
      path: "rollback after a pranswer (resetAssociation)",
      act: async ({ offerer }: Provisional) =>
        offerer.setLocalDescription({ type: "rollback" }),
    },
    {
      path: "final answer rejecting m=application (rejectApplication)",
      act: async ({ offerer, answer }: Provisional) =>
        offerer.setRemoteDescription({
          type: "answer",
          sdp: rejectApplicationSection(answer),
        }),
    },
  ])(
    "$path",
    async ({ act }) => {
      // Arrange: pranswer で open にした後付け channel と、close 通知時の状態の記録。
      const provisional = await openProvisionalChannel();
      const observed = observeAt(provisional.offerer, provisional.local);

      try {
        // Act: pending-only の association を破棄する。
        await act(provisional);

        // Assert: description の Promise が resolve する前に、develop と同じ状態で通知される。
        expect(observed).toEqual([atClose("connected", "closed", "connected")]);
        expect(channelSetsOf(provisional.offerer)).toEqual({
          registered: [],
          unannounced: [],
          queued: [],
        });
      } finally {
        await closeAll(provisional.offerer, provisional.answerer);
      }
    },
    15000,
  );
});

describe("issue 815: a throwing listener stops no later listener or caller", () => {
  test("datachannel: later listeners run and the channel opens on both ends", async () => {
    // Arrange: answerer の datachannel 通知の先頭 3 つが例外を投げる。
    const { offerer, answerer } = createPeers();
    const local = offerer.createDataChannel("dc");
    answerer.onDataChannel.subscribe(throwing("onDataChannel"));
    answerer.ondatachannel = throwing("ondatachannel");
    answerer.addEventListener("datachannel", throwing("datachannel"));
    const received = waitRemoteChannel(answerer, "dc");
    const events: string[] = [];
    answerer.addEventListener("datachannel", () => events.push("datachannel"));

    try {
      // Act: 交渉して channel を開く。
      await negotiate(offerer, answerer);
      const remote = await received;

      // Assert: 後続リスナーに届き、両端が open になる (ACK も送られる)。
      await waitOpen(local);
      await waitOpen(remote);
      expect(events).toEqual(["datachannel"]);
    } finally {
      await closeAll(offerer, answerer);
    }
  });

  test("message: later listeners and later messages are delivered", async () => {
    // Arrange: 受信側 channel の message 通知の先頭 2 つが例外を投げる。
    const pair = await openChannelPair();
    pair.remote.onMessage.subscribe(throwing("onMessage"));
    pair.remote.addEventListener("message", throwing("message"));
    const viaEvent: string[] = [];
    const viaHandler: string[] = [];
    pair.remote.onMessage.subscribe((data) => viaEvent.push(data.toString()));
    pair.remote.onmessage = ({ data }) => viaHandler.push(data.toString());

    try {
      // Act: 2 通送る。
      pair.local.send("first");
      pair.local.send("second");

      // Assert: 例外は受信処理を止めず、後続リスナーに両方が順に届く。
      await vi.waitFor(() => expect(viaHandler).toHaveLength(2));
      expect(viaEvent).toEqual(["first", "second"]);
      expect(viaHandler).toEqual(["first", "second"]);
    } finally {
      await closeAll(pair.offerer, pair.answerer);
    }
  });

  test("bufferedamountlow: later listeners run and sending continues", async () => {
    // Arrange: bufferedamountlow 通知の先頭 2 つが例外を投げる。
    const pair = await openChannelPair();
    pair.local.bufferedAmountLow.subscribe(throwing("bufferedAmountLow"));
    pair.local.addEventListener(
      "bufferedamountlow",
      throwing("bufferedamountlow"),
    );
    let lows = 0;
    pair.local.addEventListener("bufferedamountlow", () => lows++);
    const received: string[] = [];
    pair.remote.onMessage.subscribe((data) => received.push(data.toString()));

    try {
      // Act: 1 通送って buffer が 0 に戻るのを待ち、もう 1 通送る。
      pair.local.send("first");
      await vi.waitFor(() => expect(lows).toBe(1));
      pair.local.send("second");

      // Assert: 後続リスナーに届き、buffer は 0 に戻り、次の送信も届く。
      await vi.waitFor(() => expect(received).toEqual(["first", "second"]));
      await vi.waitFor(() => expect(pair.local.bufferedAmount).toBe(0));
      expect(lows).toBe(2);
    } finally {
      await closeAll(pair.offerer, pair.answerer);
    }
  });

  test("the receive callback ignores an ACK of an unknown stream and an unknown PPID", async () => {
    // Arrange: open の channel と、受信側の内部受信コールバック。
    const pair = await openChannelPair();
    const receive = (pair.remote as any).sctp.datachannelReceive as (
      streamId: number,
      ppId: number,
      data: Buffer,
    ) => Promise<void>;
    const received: unknown[] = [];
    pair.remote.onMessage.subscribe((data) => received.push(data));

    try {
      // Act / Assert: 未知の stream の DCEP ACK と未知の PPID は reject せず無視される。
      await expect(receive(99, 50, Buffer.from([2]))).resolves.toBeUndefined();
      await expect(
        receive(pair.remote.id, 9999, Buffer.from("x")),
      ).resolves.toBeUndefined();
      expect(received).toEqual([]);

      // Assert: その後の受信は通常どおり届く。
      pair.local.send("after");
      await vi.waitFor(() => expect(received.map(String)).toEqual(["after"]));
    } finally {
      await closeAll(pair.offerer, pair.answerer);
    }
  });
});

describe("issue 815: re-entrance from close / error callbacks leaves no stale entry", () => {
  test("pc.close(): createDataChannel throws, channel.close() and pc.close() complete", async () => {
    // Arrange: open の in-band channel と negotiated channel。前者の close コールバックで再入する。
    const pair = await openChannelPair();
    const other = pair.offerer.createDataChannel("other", {
      negotiated: true,
      id: 8,
    });
    const results: string[] = [];
    let closeAgain: Promise<void> | undefined;
    pair.local.addEventListener("close", () => {
      results.push(tryCreateDataChannel(pair.offerer));
      other.close();
      closeAgain = pair.offerer.close();
    });

    try {
      // Act: PeerConnection を閉じる。
      await pair.offerer.close();

      // Assert: close 中の createDataChannel は InvalidStateError。再入した close() も resolve する。
      expect(results).toEqual(["throws:InvalidStateError"]);
      await expect(closeAgain).resolves.toBeUndefined();
      expect(other.readyState).toBe("closed");
      expect(channelSetsOf(pair.offerer)).toEqual({
        registered: [],
        unannounced: [],
        queued: [],
      });
    } finally {
      await closeAll(pair.answerer);
    }
  });

  test("pc.close() before negotiation: a channel closed or created in a close callback does not stay", async () => {
    // Arrange: 交渉前の 2 つの in-band channel。先頭の close コールバックで再入する。
    const pc = new RTCPeerConnection();
    const a = pc.createDataChannel("a");
    const b = pc.createDataChannel("b");
    const results: string[] = [];
    a.addEventListener("close", () => {
      b.close();
      results.push(tryCreateDataChannel(pc));
    });

    // Act: PeerConnection を閉じる。
    await pc.close();

    // Assert: 新しい channel は作れず、どの集合にも channel が残らない。
    expect(results).toEqual(["throws:InvalidStateError"]);
    expect([a.readyState, b.readyState]).toEqual(["closed", "closed"]);
    expect(channelSetsOf(pc)).toEqual({
      registered: [],
      unannounced: [],
      queued: [],
    });
  });

  test("association closed by the peer: a channel created in a close callback stays registered until pc.close()", async () => {
    // Arrange: open の in-band channel と negotiated channel。前者の close コールバックで再入する。
    const pair = await openChannelPair();
    const other = pair.offerer.createDataChannel("other", {
      negotiated: true,
      id: 8,
    });
    let created: RTCDataChannel | undefined;
    pair.local.addEventListener("close", () => {
      other.close();
      created = pair.offerer.createDataChannel("in-callback");
    });

    try {
      // Act: 相手が PeerConnection を閉じ、association が閉じる。
      await pair.answerer.close();
      await vi.waitFor(() => expect(pair.local.readyState).toBe("closed"));

      // Assert: 閉じた channel は残らず、コールバックで作った channel だけが待機している。
      expect(other.readyState).toBe("closed");
      expect(channelSetsOf(pair.offerer)).toEqual({
        registered: ["in-callback:connecting"],
        unannounced: ["in-callback:connecting"],
        queued: ["in-callback"],
      });

      // Act: 自分の PeerConnection も閉じる。
      await pair.offerer.close();

      // Assert: 待機していた channel も閉じ、どの集合にも残らない。
      expect(created!.readyState).toBe("closed");
      expect(channelSetsOf(pair.offerer)).toEqual({
        registered: [],
        unannounced: [],
        queued: [],
      });
    } finally {
      await closeAll(pair.offerer);
    }
  });

  test("rollback: a channel created in a close callback opens at the next negotiation", async () => {
    // Arrange: pranswer で open にした channel の close コールバックで channel を作る。
    const { offerer, answerer, local } = await openProvisionalChannel();
    let created: RTCDataChannel | undefined;
    local.addEventListener("close", () => {
      created = offerer.createDataChannel("in-callback");
    });

    try {
      // Act: 両端を rollback する。
      await offerer.setLocalDescription({ type: "rollback" });
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: 破棄した channel は残らず、作った channel だけが待機している。
      expect(channelSetsOf(offerer).unannounced).toEqual([
        "in-callback:connecting",
      ]);
      expect(channelSetsOf(offerer).registered).not.toContain("late:closed");

      // Act: もう一度交渉する。
      await negotiate(offerer, answerer);

      // Assert: 作った channel が自分の DTLS role の偶奇 (server = 奇数) で open になる。
      await waitOpen(created!);
      expect(created!.id! % 2).toBe(1);
      expect(channelSetsOf(offerer)).toEqual({
        registered: ["in-callback:open"],
        unannounced: [],
        queued: [],
      });
    } finally {
      await closeAll(offerer, answerer);
    }
  }, 15000);

  test("ID exhaustion: pc.close() from an error callback closes every waiting channel", async () => {
    // Arrange: ID が 1 つしかない transport に 3 つの channel を待機させ、最初の
    // 失敗の error コールバックで PeerConnection を閉じる。
    const pc = new RTCPeerConnection();
    const { dtls, create } = attachLimitedTransport(pc);
    const channels = ["ok", "failed", "waiting"].map(create);
    let closing: Promise<void> | undefined;
    const errorStates = observeAt(pc, channels[1], "error");
    channels[1].addEventListener("error", () => {
      closing = pc.close();
    });

    // Act: DTLS role を確定させ、ID 枯渇で 2 つ目を失敗させる。
    dtls.role = "client";
    await closing;

    // Assert: error は closed の状態で通知され、close() は resolve し、残りの channel も閉じる。
    expect(errorStates.map((s) => s.readyState)).toEqual(["closed"]);
    expect(channels.map((c) => c.readyState)).toEqual([
      "closed",
      "closed",
      "closed",
    ]);
    expect(channelSetsOf(pc)).toEqual({
      registered: [],
      unannounced: [],
      queued: [],
    });
  });

  test("createDataChannel after pc.close() still throws InvalidStateError", async () => {
    // Arrange: 閉じた PeerConnection。
    const pc = new RTCPeerConnection();
    await pc.close();

    // Act / Assert: W3C webrtc-pc createDataChannel step 2 どおり throw する。
    expect(tryCreateDataChannel(pc)).toBe("throws:InvalidStateError");
  });
});

type Pair = Awaited<ReturnType<typeof openChannelPair>>;
type Provisional = Awaited<ReturnType<typeof openProvisionalChannel>>;

function dtlsOf(pc: RTCPeerConnection): any {
  return (pc as any).sctpManager.sctpTransport.dtlsTransport;
}
