import {
  type RTCDtlsTransport,
  RTCPeerConnection,
  RTCSctpTransport,
} from "../../src";
import { createDtlsTransport } from "../fixture";
import {
  closeAll,
  createPeers,
  negotiate,
  nextMessage,
  waitOpen,
  waitRemoteChannel,
} from "./815.helpers";

/**
 * Issue #815: in-band DataChannel の stream ID は DTLS role で決まる (RFC 8832
 * section 6: client 偶数、server 奇数)。ICE role ではない。role を確定させる
 * description の適用時に採番する (W3C webrtc-pc 4.4.1.6 step 2.2.6)。
 */
describe("issue 815: data channel stream IDs follow the DTLS role", () => {
  test.each([
    {
      name: "passive answer (offerer = DTLS client)",
      answerSetup: "passive" as const,
      offerer: [0, 2],
      answerer: [1, 3],
    },
    {
      name: "active answer (answerer = DTLS client)",
      answerSetup: "active" as const,
      offerer: [1, 3],
      answerer: [0, 2],
    },
    {
      name: "default actpass / active (offerer = DTLS server)",
      offerer: [1, 3],
      answerer: [0, 2],
    },
  ])("$name", async ({ answerSetup, offerer, answerer }) => {
    // Arrange: 両 peer に交渉前の in-band channel を 2 つずつ作る。
    const peers = createPeers();
    const offererChannels = [0, 1].map((i) =>
      peers.offerer.createDataChannel(`o${i}`),
    );
    peers.answerer.createDataChannel("trigger-answerer-sctp");
    const ids: Record<string, (number | undefined)[]> = {};
    let answererChannels: ReturnType<RTCPeerConnection["createDataChannel"]>[] =
      [];

    try {
      // Act: offer / answer を適用し、answer 適用の直後 (SCTP 接続前) に ID を読む。
      await negotiate(peers.offerer, peers.answerer, {
        answerSetup,
        onAnswered: (side) => {
          if (side === "offerer") {
            ids.offerer = offererChannels.map((c) => c.id);
          } else {
            // role 確定後の createDataChannel は即時に採番される。
            answererChannels = [0, 1].map((i) =>
              peers.answerer.createDataChannel(`a${i}`),
            );
            ids.answerer = answererChannels.map((c) => c.id);
          }
        },
      });

      // Assert: SCTP 接続前でも DTLS role の偶奇で ID が見える。
      expect(peers.offerer.sctpTransport!.state).not.toBe("connected");
      expect(ids.offerer).toEqual(offerer);
      // answerer は交渉前の channel が最小 ID を取り、その後の 2 つが続く。
      expect(ids.answerer).toEqual(answerer.map((id) => id + 2));

      // Assert: 接続後も ID は変わらず、すべて open になる。
      await Promise.all(
        [...offererChannels, ...answererChannels].map(waitOpen),
      );
      expect(offererChannels.map((c) => c.id)).toEqual(offerer);
    } finally {
      await closeAll(peers.offerer, peers.answerer);
    }
  });

  test("#815 report: reversed ICE / DTLS roles with channels from both ends do not collide", async () => {
    // Arrange: 両端が交渉前に channel を作り、answer を passive にして
    // ICE controlling (offerer) を DTLS client にする。
    const { offerer, answerer } = createPeers();
    const fromOfferer = offerer.createDataChannel("from-offerer");
    const fromAnswerer = answerer.createDataChannel("from-answerer");
    const remoteAtAnswerer = waitRemoteChannel(answerer, "from-offerer");
    const remoteAtOfferer = waitRemoteChannel(offerer, "from-answerer");

    try {
      // Act: 交渉して両端の OPEN を同時に送らせる。
      await negotiate(offerer, answerer, { answerSetup: "passive" });
      await Promise.all([waitOpen(fromOfferer), waitOpen(fromAnswerer)]);
      const [atAnswerer, atOfferer] = await Promise.all([
        remoteAtAnswerer,
        remoteAtOfferer,
      ]);

      // Assert: DTLS client (offerer) は偶数、server (answerer) は奇数で衝突しない。
      expect(fromOfferer.id).toBe(0);
      expect(fromAnswerer.id).toBe(1);
      expect(atAnswerer.id).toBe(0);
      expect(atOfferer.id).toBe(1);

      // Act: 双方向にメッセージを送る。
      const received = Promise.all([
        nextMessage(atAnswerer),
        nextMessage(atOfferer),
      ]);
      fromOfferer.send("hello answerer");
      fromAnswerer.send("hello offerer");

      // Assert: それぞれの相手に届く。
      expect(await received).toEqual(["hello answerer", "hello offerer"]);
    } finally {
      await closeAll(offerer, answerer);
    }
  });

  test("an id given to an in-band channel is ignored", async () => {
    // Arrange: 両端が同じ id: 42 を in-band channel に指定する。
    const { offerer, answerer } = createPeers();
    const a = offerer.createDataChannel("a", { id: 42 });
    const b = answerer.createDataChannel("b", { id: 42 });
    const atAnswerer = waitRemoteChannel(answerer, "a");
    const atOfferer = waitRemoteChannel(offerer, "b");

    try {
      // Assert: 指定 id は無視され、role 確定前は未採番。
      expect(a.id).toBeUndefined();
      expect(b.id).toBeUndefined();
      // Assert: 範囲外の id も in-band なら throw しない。
      expect(() =>
        offerer.createDataChannel("max", { id: 65535 }),
      ).not.toThrow();
      expect(() => offerer.createDataChannel("neg", { id: -1 })).not.toThrow();

      // Act: 交渉して接続する。
      await negotiate(offerer, answerer);
      await Promise.all([waitOpen(a), waitOpen(b)]);

      // Assert: 自分の DTLS role の偶奇で採番され、両方が 42 になることはない。
      expect(a.id % 2).toBe(1);
      expect(b.id % 2).toBe(0);
      expect(a.id === 42 && b.id === 42).toBe(false);

      // Act: 双方向にメッセージを送る。
      const remote = await Promise.all([atAnswerer, atOfferer]);
      const received = Promise.all(remote.map(nextMessage));
      a.send("to answerer");
      b.send("to offerer");

      // Assert: それぞれの相手に届く。
      expect(await received).toEqual(["to answerer", "to offerer"]);
    } finally {
      await closeAll(offerer, answerer);
    }
  });

  test("auto IDs skip negotiated channels of either parity and reuse closed IDs", async () => {
    // Arrange: DTLS client になる offerer に偶奇両方の negotiated channel を作る。
    const { offerer, answerer } = createPeers();
    offerer.createDataChannel("n0", { negotiated: true, id: 0 });
    offerer.createDataChannel("n1", { negotiated: true, id: 1 });
    answerer.createDataChannel("n0", { negotiated: true, id: 0 });
    answerer.createDataChannel("n1", { negotiated: true, id: 1 });
    const first = offerer.createDataChannel("first");

    try {
      // Act: passive answer で offerer を DTLS client にする。
      await negotiate(offerer, answerer, { answerSetup: "passive" });

      // Assert: 自動採番は偶数を守り、negotiated の 0 を避ける。
      expect(first.id).toBe(2);
      const second = offerer.createDataChannel("second");
      expect(second.id).toBe(4);
      await Promise.all([waitOpen(first), waitOpen(second)]);

      // Act: first を閉じ、close イベントの後に作り直す。
      const closed = new Promise<void>((r) => (first.onclose = r));
      first.close();
      await closed;
      const reused = offerer.createDataChannel("reused");

      // Assert: 閉じた channel の ID が再利用され、使用中の 4 は避ける
      // (WPT「ids are reusable after close event」相当)。
      expect(reused.id).toBe(2);
      expect(second.readyState).toBe("open");
    } finally {
      await closeAll(offerer, answerer);
    }
  });

  test("renegotiation and an ICE restart keep IDs and parity", async () => {
    // Arrange: passive answer で offerer を DTLS client にして接続する。
    const { offerer, answerer } = createPeers();
    const first = offerer.createDataChannel("first");
    try {
      await negotiate(offerer, answerer, { answerSetup: "passive" });
      await waitOpen(first);

      // Act: ICE restart を含む再交渉をし、その後に channel を作る。
      offerer.restartIce();
      await negotiate(offerer, answerer);
      const later = offerer.createDataChannel("later");

      // Assert: 既存 ID は変わらず、DTLS role (client) の偶数が続く。
      expect(first.id).toBe(0);
      expect(later.id).toBe(2);
      await waitOpen(later);
    } finally {
      await closeAll(offerer, answerer);
    }
  });

  test("a rollback gives back the IDs a pranswer reserved", async () => {
    // Arrange: offerer が channel を作り、passive の pranswer を受ける準備をする。
    const { offerer, answerer } = createPeers();
    const channel = offerer.createDataChannel("rollback");
    try {
      const offer = await offerer.createOffer();
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offer);
      const answer = await answerer.createAnswer();
      const pranswer = {
        type: "pranswer" as const,
        sdp: answer.sdp.replace(/a=setup:\w+/g, "a=setup:passive"),
      };

      // Act: pranswer を適用して DTLS role (client) を確定させる。
      await offerer.setRemoteDescription(pranswer);

      // Assert: pranswer の role で偶数 ID が予約される。
      expect(channel.id).toBe(0);

      // Act: rollback する。
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: 未送信の予約は解放される。
      expect(channel.id).toBeUndefined();
      expect(channel.readyState).toBe("connecting");
    } finally {
      await closeAll(offerer, answerer);
    }
  });
});

describe("issue 815: stream ID exhaustion", () => {
  /** maxChannels を 2 に絞った SCTP transport (DTLS role は未確定)。 */
  function createLimitedTransport() {
    const dtls: RTCDtlsTransport = createDtlsTransport();
    const transport = new RTCSctpTransport();
    transport.setDtlsTransport(dtls);
    transport.sctp._inboundStreamsCount = 2;
    transport.sctp._outboundStreamsCount = 2;
    return { dtls, transport };
  }

  test("a channel waiting for an ID closes with OperationError when none is left", async () => {
    // Arrange: role 確定前に 2 つの in-band channel を作る (client の偶数は 0 だけ)。
    const { dtls, transport } = createLimitedTransport();
    const pc = new RTCPeerConnection();
    const manager = (pc as any).sctpManager;
    manager.sctpTransport = transport;
    const ok = manager.createDataChannel("ok");
    const failed = manager.createDataChannel("failed");
    const events: string[] = [];
    let error: Error | undefined;
    failed.addEventListener("error", (e: { error: Error }) => {
      events.push(`error:${failed.readyState}`);
      error = e.error;
    });
    failed.addEventListener("close", () => events.push("close"));

    try {
      // Act: DTLS role を client に確定させる。
      dtls.role = "client";

      // Assert: 1 つ目は 0、2 つ目は closed になり error → close の順で通知される。
      expect(ok.id).toBe(0);
      expect(failed.id).toBeUndefined();
      expect(failed.readyState).toBe("closed");
      expect(events).toEqual(["error:closed", "close"]);
      expect(error?.name).toBe("OperationError");

      // Act / Assert: role 確定後の作成で ID が無ければ OperationError を throw する。
      expect(() => manager.createDataChannel("throws")).toThrow(
        expect.objectContaining({ name: "OperationError" }),
      );
    } finally {
      await transport.stop();
      await pc.close();
    }
  });
  test("a reservation beyond the negotiated stream limit is given back and fails", async () => {
    // Arrange: 上限未確定の role 確定で client の偶数 ID 0 と 2 を予約する。
    const dtls: RTCDtlsTransport = createDtlsTransport();
    const transport = new RTCSctpTransport();
    transport.setDtlsTransport(dtls);
    const pc = new RTCPeerConnection();
    const manager = (pc as any).sctpManager;
    manager.sctpTransport = transport;
    const first = manager.createDataChannel("first");
    const second = manager.createDataChannel("second");
    dtls.role = "client";
    expect([first.id, second.id]).toEqual([0, 2]);

    try {
      // Act: SCTP 交渉で stream 数が 2 に決まった後に採番し直す。
      transport.sctp._inboundStreamsCount = 2;
      transport.sctp._outboundStreamsCount = 2;
      transport.assignPendingStreamIds();

      // Assert: 範囲内の 0 は維持され、範囲外の 2 は解放されて OperationError で閉じる。
      expect(first.id).toBe(0);
      expect(second.id).toBeUndefined();
      expect(second.readyState).toBe("closed");
      expect(transport.dataChannels[2]).toBeUndefined();
    } finally {
      await transport.stop();
      await pc.close();
    }
  });

  test("a channel closed by an error handler is not given an ID", async () => {
    // Arrange: ID が 1 つしかない状況で 3 つの channel を待機させる。
    const { dtls, transport } = createLimitedTransport();
    const pc = new RTCPeerConnection();
    const manager = (pc as any).sctpManager;
    manager.sctpTransport = transport;
    const ok = manager.createDataChannel("ok");
    const failed = manager.createDataChannel("failed");
    const closedByHandler = manager.createDataChannel("closed-by-handler");
    failed.addEventListener("error", () => {
      // 失敗通知の中で使用中 channel と後続の待機 channel を閉じる。
      ok.close();
      closedByHandler.close();
    });

    try {
      // Act: DTLS role を client に確定させる。
      dtls.role = "client";

      // Assert: 閉じられた待機 channel には ID が割り当てられず、登録表にも残らない。
      expect(closedByHandler.id).toBeUndefined();
      expect(Object.values(transport.dataChannels)).not.toContain(
        closedByHandler,
      );
    } finally {
      await transport.stop();
      await pc.close();
    }
  });

  test("close still fires when error listeners throw", async () => {
    // Arrange: error 購読者と onerror が例外を投げる待機 channel を作る。
    const { dtls, transport } = createLimitedTransport();
    const pc = new RTCPeerConnection();
    const manager = (pc as any).sctpManager;
    manager.sctpTransport = transport;
    manager.createDataChannel("ok");
    const failed = manager.createDataChannel("failed");
    const events: string[] = [];
    failed.onerror = () => {
      events.push("onerror");
      throw new Error("onerror failed");
    };
    failed.addEventListener("error", () => {
      events.push("error");
      throw new Error("listener failed");
    });
    failed.onclose = () => events.push("onclose");
    failed.addEventListener("close", () => events.push("close"));

    try {
      // Act: DTLS role を client に確定させ、ID 枯渇で失敗させる。
      dtls.role = "client";

      // Assert: 例外が出ても error の後に close 通知まで完了する。
      expect(failed.readyState).toBe("closed");
      expect(events).toEqual(["onerror", "error", "onclose", "close"]);
    } finally {
      await transport.stop();
      await pc.close();
    }
  });

  test("every error subscriber is notified even if one throws", async () => {
    // Arrange: 最初の購読者が例外を投げ、後続に 2 つ目の購読者を置く。
    const { dtls, transport } = createLimitedTransport();
    const pc = new RTCPeerConnection();
    const manager = (pc as any).sctpManager;
    manager.sctpTransport = transport;
    manager.createDataChannel("ok");
    const failed = manager.createDataChannel("failed");
    const received: Error[] = [];
    failed.error.subscribe(() => {
      throw new Error("first subscriber failed");
    });
    failed.error.subscribe((e: Error) => received.push(e));

    try {
      // Act: DTLS role を client に確定させ、ID 枯渇で失敗させる。
      dtls.role = "client";

      // Assert: 後続の購読者も OperationError を受け取る。
      expect(received.map((e) => e.name)).toEqual(["OperationError"]);
    } finally {
      await transport.stop();
      await pc.close();
    }
  });

  test("pc.close() closes a channel that has no stream ID yet", async () => {
    // Arrange: role 確定前に in-band channel を作る (id 指定は無視され未採番)。
    const pc = new RTCPeerConnection();
    const channel = pc.createDataChannel("test", { id: 42 });
    const events: string[] = [];
    channel.addEventListener("close", () => events.push("close"));
    expect(channel.id).toBeUndefined();
    expect(channel.readyState).toBe("connecting");

    // Act: PeerConnection を閉じる。
    await pc.close();

    // Assert: 未採番の channel も closed になり close が通知される。
    expect(channel.readyState).toBe("closed");
    expect(events).toEqual(["close"]);
  });

  test("pc.close() closes every pending channel even if a close listener throws", async () => {
    // Arrange: 先頭 channel の close リスナーが例外を投げる 2 つの未採番 channel。
    const pc = new RTCPeerConnection();
    const first = pc.createDataChannel("first");
    const second = pc.createDataChannel("second");
    first.addEventListener("close", () => {
      throw new Error("close listener failed");
    });
    const events: string[] = [];
    second.addEventListener("close", () => events.push("close"));

    // Act: PeerConnection を閉じる。
    await pc.close();

    // Assert: reject せず、後続 channel も closed になり close が通知される。
    expect(first.readyState).toBe("closed");
    expect(second.readyState).toBe("closed");
    expect(events).toEqual(["close"]);
    expect(pc.connectionState).toBe("closed");
  });
});
