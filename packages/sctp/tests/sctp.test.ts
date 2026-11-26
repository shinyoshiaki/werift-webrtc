import { createSocket } from "dgram";
import { setTimeout } from "timers/promises";
import { vi } from "vitest";

import {
  dataChunkBookSize as book,
  SCTP,
  SCTP_STATE,
  SCTPSendPermissionRevokedError,
  type Transport,
} from "../src";
import {
  AbortChunk,
  CookieAckChunk,
  CookieEchoChunk,
  DataChunk,
  ForwardTsnChunk,
  HeartbeatChunk,
  InitChunk,
  SackChunk,
  SCTP_COMMON_HEADER_SIZE,
  serializePacket,
} from "../src/chunk";
import { StreamAddOutgoingParam } from "../src/param";
import { createUdpTransport } from "../src/transport";
import {
  buildSack,
  createChunkQueue,
  createControlledTransport,
  createMockSctp,
  disposeMockSctp,
  expectFlightSizeInvariant,
  flightSizeOf,
  holdTransport,
  outboundQueueOf,
  receiveCookieEcho,
  receiveInitAck,
  receiveInitAndTakeCookie,
  receiveSack,
  sentChunks,
  sentChunkTypes,
  sentDataTsns,
  sentQueueOf,
  settle,
  tsnBefore,
} from "./utils";

describe("sctp", () => {
  test("test_connect_client_limits_streams", async () => {
    const port = 8799;

    const socket = createSocket("udp4");
    socket.bind(port);
    const server = SCTP.server(createUdpTransport(socket));

    const client = SCTP.client(
      createUdpTransport(createSocket("udp4"), {
        port,
        address: "127.0.0.1",
      }),
    );

    client._inboundStreamsMax = 2048;
    client._outboundStreamsCount = 256;

    await Promise.all([client.start(5000), server.start(5000)]);
    await Promise.all([
      client.stateChanged.connected.asPromise(),
      server.stateChanged.connected.asPromise(),
    ]);

    expect(client.maxChannels).toBe(256);
    expect(client.associationState).toBe(SCTP_STATE.ESTABLISHED);
    expect(client._inboundStreamsCount).toBe(2048);
    expect(client._outboundStreamsCount).toBe(256);
    expect(client.remoteExtensions).toEqual([192, 130]);
    expect(server.associationState).toBe(SCTP_STATE.ESTABLISHED);
    expect(server._inboundStreamsCount).toBe(256);
    expect(server._outboundStreamsCount).toBe(2048);
    expect(server.remoteExtensions).toEqual([192, 130]);

    const param = new StreamAddOutgoingParam(client.reconfigRequestSeq, 16);
    await client.sendReconfigParam(param);
    await setTimeout(100);

    expect(server.maxChannels).toBe(272);
    expect(server._inboundStreamsCount).toBe(272);
    expect(server._outboundStreamsCount).toBe(2048);

    client.stop();

    await server.stateChanged.closed.asPromise();
    expect(client.associationState).toBe(SCTP_STATE.CLOSED);
    expect(server.associationState).toBe(SCTP_STATE.CLOSED);

    socket.close();
  });
});

describe("sctp timers and ack policy", () => {
  const createDataChunk = (tsn: number) => {
    const chunk = new DataChunk(0, undefined);
    chunk.flags = 0x03;
    chunk.tsn = tsn;
    chunk.streamId = 1;
    chunk.streamSeqNum = 0;
    chunk.protocol = 51;
    chunk.userData = Buffer.from("x");
    return chunk;
  };

  const receiveDataPacket = async (
    sctp: SCTP,
    tsn: number,
    flags = 0x03,
    verificationTag?: number,
  ) => {
    const chunk = createDataChunk(tsn);
    chunk.flags = flags;
    const packet = serializePacket(
      5001,
      5000,
      verificationTag ?? (sctp as any).localVerificationTag,
      chunk,
    );
    await (sctp as any).handleData(packet);
  };

  test("timer3Restart converts rto seconds to milliseconds", () => {
    const { sctp } = createMockSctp();
    const spy = vi.spyOn(global, "setTimeout");

    (sctp as any).rto = 5;
    (sctp as any).timer3Restart();

    expect(spy).toHaveBeenCalledWith(expect.any(Function), 5000);
    (sctp as any).timer3Cancel();
    spy.mockRestore();
  });

  test("INIT send permission revocation closes and rejects the association", async () => {
    // Arrange: INIT を送信する transport が送信許可の取消しで失敗する。
    // (単なる送信失敗は損失として T1 に任せる: 下の INIT 送信失敗のテスト)
    const transport: Transport = {
      send: vi.fn(async () => {
        throw new SCTPSendPermissionRevokedError("transport unavailable");
      }),
      close: vi.fn(),
    };
    const sctp = SCTP.client(transport, 5000);
    sctp.setRemotePort(5001);

    // Act: association start を実行する。
    await expect(sctp.start(5001)).rejects.toThrow("transport unavailable");

    // Assert: INIT failure が CLOSED 通知まで到達する。
    expect(sctp.state).toBe("closed");
    expect(sctp.associationState).toBe(SCTP_STATE.CLOSED);
  });

  test("T1 timeout publishes closed instead of leaving the waiter pending", async () => {
    // Arrange: 応答を返さない transport と短い RTO を用意する。
    vi.useFakeTimers();
    const transport: Transport = {
      send: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const sctp = SCTP.client(transport, 5000);
    sctp.setRemotePort(5001);
    (sctp as any).rto = 0.001;
    const closed = sctp.stateChanged.closed.asPromise();

    try {
      // Act: INIT を送信し、T1 再送上限を超えるまで時間を進める。
      await sctp.start(5001);
      await vi.advanceTimersByTimeAsync(20);

      // Assert: close event が発火し、接続待ちが終端状態になる。
      await expect(closed).resolves.toEqual([]);
      expect(sctp.state).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("peer rwnd is derived from latest advertised rwnd and flight size", async () => {
    const { sctp } = createMockSctp();
    (sctp as any).lastSackedTsn = 0;
    const sent = createDataChunk(1);
    sent.bookSize = 100;
    sent.inFlight = true;
    (sctp as any).sentQueue = createChunkQueue([sent]);
    (sctp as any).flightSize = 100;

    const sack = new SackChunk(0, undefined);
    sack.cumulativeTsn = 0;
    sack.advertisedRwnd = 150;

    await (sctp as any).receiveSackChunk(sack);
    expect((sctp as any).peerAdvertisedRwnd).toBe(150);
    expect((sctp as any).peerRwnd).toBe(50);
  });

  test("single-packet DATA is acked immediately and delayed fallback stays within 200ms", async () => {
    vi.useFakeTimers();
    const { sctp, transport } = createMockSctp();
    (sctp as any).lastReceivedTsn = 0;

    await receiveDataPacket(sctp, 1);
    expect((transport.send as any).mock.calls.length).toBe(1);

    (sctp as any).sackNeeded = true;
    (sctp as any).sackImmediate = false;
    await (sctp as any).scheduleSack();
    expect((transport.send as any).mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect((transport.send as any).mock.calls.length).toBe(2);
    vi.useRealTimers();
  });

  test("fragmented data chunk triggers immediate sack", async () => {
    const { sctp, transport } = createMockSctp();
    (sctp as any).lastReceivedTsn = 0;
    const fragment = createDataChunk(1);
    fragment.flags = 0x02;

    (sctp as any).receiveDataChunk(fragment);
    await (sctp as any).scheduleSack();
    expect((transport.send as any).mock.calls.length).toBe(1);
  });

  test("gap/loss-signaled data triggers immediate sack", async () => {
    const { sctp, transport } = createMockSctp();
    (sctp as any).lastReceivedTsn = 0;

    (sctp as any).receiveDataChunk(createDataChunk(2));
    await (sctp as any).scheduleSack();

    expect((transport.send as any).mock.calls.length).toBe(1);
  });

  test("duplicate tsn triggers immediate sack", async () => {
    const { sctp, transport } = createMockSctp();
    (sctp as any).lastReceivedTsn = 1;

    (sctp as any).receiveDataChunk(createDataChunk(1));
    expect((sctp as any).sackImmediate).toBe(true);
    expect((sctp as any).sackDuplicates).toEqual([1]);

    await (sctp as any).scheduleSack();
    expect((transport.send as any).mock.calls.length).toBe(1);
  });

  test("heartbeat timer uses rto + heartbeat interval", () => {
    const { sctp } = createMockSctp();
    const spy = vi.spyOn(global, "setTimeout");
    (sctp as any).associationState = SCTP_STATE.ESTABLISHED;
    (sctp as any).rto = 2;

    sctp.setHeartbeatInterval(30);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 32000);

    sctp.setHeartbeatInterval(5);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 7000);

    (sctp as any).heartbeatCancel();
    spy.mockRestore();
  });

  test("larger heartbeat interval delays no-response probe timing", async () => {
    vi.useFakeTimers();
    try {
      const fast = createMockSctp().sctp;
      const slow = createMockSctp().sctp;
      (fast as any).associationState = SCTP_STATE.ESTABLISHED;
      (slow as any).associationState = SCTP_STATE.ESTABLISHED;
      (fast as any).rto = 1;
      (slow as any).rto = 1;
      fast.setHeartbeatInterval(1);
      slow.setHeartbeatInterval(5);

      await vi.advanceTimersByTimeAsync(1999);
      expect(((fast as any).transport.send as any).mock.calls.length).toBe(0);
      expect(((slow as any).transport.send as any).mock.calls.length).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(((fast as any).transport.send as any).mock.calls.length).toBe(1);
      expect(((slow as any).transport.send as any).mock.calls.length).toBe(0);

      await vi.advanceTimersByTimeAsync(3999);
      expect(((fast as any).transport.send as any).mock.calls.length).toBe(2);
      expect(((slow as any).transport.send as any).mock.calls.length).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(((fast as any).transport.send as any).mock.calls.length).toBe(3);
      expect(((slow as any).transport.send as any).mock.calls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("larger heartbeat interval increases no-response detection cadence and abort is handled", async () => {
    vi.useFakeTimers();
    try {
      const fast = createMockSctp().sctp;
      const slow = createMockSctp().sctp;
      (fast as any).associationState = SCTP_STATE.ESTABLISHED;
      (slow as any).associationState = SCTP_STATE.ESTABLISHED;
      (fast as any).rto = 1;
      (slow as any).rto = 1;
      fast.setHeartbeatInterval(1);
      slow.setHeartbeatInterval(5);

      await vi.advanceTimersByTimeAsync(6000);

      const fastHeartbeats = ((fast as any).transport.send as any).mock.calls
        .length;
      const slowHeartbeats = ((slow as any).transport.send as any).mock.calls
        .length;
      expect(fastHeartbeats).toBeGreaterThanOrEqual(3);
      expect(slowHeartbeats).toBe(1);

      await (fast as any).receiveChunk(new AbortChunk());
      await (slow as any).receiveChunk(new AbortChunk());
      expect(fast.associationState).toBe(SCTP_STATE.CLOSED);
      expect(slow.associationState).toBe(SCTP_STATE.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sctp start commit boundary", () => {
  test("開始側は COOKIE_ECHO を送信処理へ渡す前に COOKIE_ECHOED へ進み、送信中の取消し・重複 INIT_ACK を受け付けない", async () => {
    // Arrange: INIT 送信済みの開始側で、以降の送信を保留できる transport。
    const control = createControlledTransport();
    const sctp = SCTP.client(control.transport, 5000);
    await sctp.start(5001);
    expect(sctp.startCommitted).toBe(false);
    control.holdSends();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      // Act: INIT_ACK を受信し、COOKIE_ECHO の送信完了待ちに入る。
      const handling = receiveInitAck(sctp);
      await setTimeout(0);

      // Assert: 送信完了前に状態遷移と確定が済んでいる。
      expect(sentChunkTypes(control.sent)).toEqual([
        InitChunk.type,
        CookieEchoChunk.type,
      ]);
      expect(sctp.associationState).toBe(SCTP_STATE.COOKIE_ECHOED);
      expect(sctp.startCommitted).toBe(true);

      // Act: 送信中に取消しを要求し、重複した INIT_ACK も受信する。
      const cancelled = sctp.cancelStart();
      await receiveInitAck(sctp);

      // Assert: 取消しは拒否され、重複 INIT_ACK は状態確認で無視される。
      expect(cancelled).toBe(false);
      expect(sctp.state).not.toBe("closed");
      expect(sctp.startCancellationError).toBeUndefined();
      expect(sentChunkTypes(control.sent)).toHaveLength(2);

      // Act: 送信を完了させる。
      control.release();
      await handling;
      await setTimeout(0);

      // Assert: COOKIE_ECHOED を保ち、未処理 rejection も出ない。
      expect(sctp.associationState).toBe(SCTP_STATE.COOKIE_ECHOED);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      control.release();
      await sctp.stop();
    }
  });

  test("開始側は INIT の送信完了前に届いた INIT_ACK も処理する", async () => {
    // Arrange: INIT の送信完了を保留する開始側。
    const control = createControlledTransport();
    const sctp = SCTP.client(control.transport, 5000);
    control.holdSends();
    const starting = sctp.start(5001);
    await setTimeout(0);

    try {
      // Assert: 送信完了前に COOKIE_WAIT へ進んでいる。
      expect(sctp.associationState).toBe(SCTP_STATE.COOKIE_WAIT);

      // Act: INIT の送信完了前に INIT_ACK を受信し、その後で送信を完了させる。
      const handling = receiveInitAck(sctp);
      await setTimeout(0);
      control.release();
      await Promise.all([starting, handling]);

      // Assert: INIT_ACK は捨てられず、COOKIE_ECHO を送って COOKIE_ECHOED へ進む。
      expect(sentChunkTypes(control.sent)).toEqual([
        InitChunk.type,
        CookieEchoChunk.type,
      ]);
      expect(sctp.associationState).toBe(SCTP_STATE.COOKIE_ECHOED);
    } finally {
      control.release();
      await sctp.stop();
    }
  });

  test("開始側の COOKIE_ECHO 送信中に stop しても、送信完了で状態は戻らない", async () => {
    // Arrange: COOKIE_ECHO の送信完了待ちの開始側。
    const control = createControlledTransport();
    const sctp = SCTP.client(control.transport, 5000);
    await sctp.start(5001);
    control.holdSends();
    const handling = receiveInitAck(sctp);
    await setTimeout(0);

    // Act: 送信中に stop し、その後で送信を完了させる。
    const stopping = sctp.stop();
    control.release();
    await Promise.all([handling, stopping]);

    // Assert: 遅れて完了した送信処理が CLOSED を上書きしない。
    expect(sctp.associationState).toBe(SCTP_STATE.CLOSED);
    expect(sctp.state).toBe("closed");
  });

  test("応答側の COOKIE_ACK 送信失敗は損失として扱い、再送された COOKIE_ECHO に同じ association で応答する", async () => {
    // Arrange: INIT を受けて state cookie を発行した応答側。
    const control = createControlledTransport();
    const sctp = SCTP.server(control.transport, 5000);
    sctp.setRemotePort(5001);
    const cookie = await receiveInitAndTakeCookie(sctp, control.sent);

    try {
      // Act: COOKIE_ACK の送信が失敗する状態で COOKIE_ECHO を受信する。
      control.failSends();
      await receiveCookieEcho(sctp, cookie);

      // Assert: RFC 4960 5.1 (D) どおり確立し、取消しは起きない。
      expect(sctp.associationState).toBe(SCTP_STATE.ESTABLISHED);
      expect(sctp.startCommitted).toBe(true);
      expect(sctp.startCancellationError).toBeUndefined();

      // Act: 開始側が COOKIE_ECHO を再送し、今度は送信が成功する。
      control.restoreSends();
      await receiveCookieEcho(sctp, cookie);

      // Assert: 同じ cookie 鍵の association が COOKIE_ACK を返す。
      expect(sentChunkTypes(control.sent).at(-1)).toBe(CookieAckChunk.type);
      expect(sctp.associationState).toBe(SCTP_STATE.ESTABLISHED);
    } finally {
      await sctp.stop();
    }
  });

  test.each([
    {
      phase: "COOKIE_WAIT",
      kind: "revoked",
      afterInitAck: false,
      cancelled: true,
    },
    {
      phase: "COOKIE_WAIT",
      kind: "loss",
      afterInitAck: false,
      cancelled: false,
    },
    {
      phase: "COOKIE_ECHOED",
      kind: "revoked",
      afterInitAck: true,
      cancelled: false,
    },
    {
      phase: "COOKIE_ECHOED",
      kind: "loss",
      afterInitAck: true,
      cancelled: false,
    },
  ] as const)(
    "T1 再送の送信失敗は確定前かつ送信許可の取消しのときだけ start を取り消す ($phase, $kind)",
    async ({ kind, afterInitAck, cancelled }) => {
      // Arrange: 短い RTO の開始側を、指定のフェーズまで進める。
      vi.useFakeTimers();
      const control = createControlledTransport();
      const sctp = SCTP.client(control.transport, 5000);
      (sctp as unknown as { rto: number }).rto = 0.001;
      try {
        await sctp.start(5001);
        if (afterInitAck) await receiveInitAck(sctp);
        const phase = sctp.associationState;

        // Act: 以降の送信を指定の種類で失敗させ、T1 再送を1回発生させる。
        control.failSends(kind);
        await vi.advanceTimersByTimeAsync(2);

        // Assert: 送信許可の取消しは確定前だけ即時取消し。単なる送信失敗
        // (損失) は確定前でも association を維持し、T1 再送に任せる。
        if (cancelled) {
          expect(sctp.state).toBe("closed");
          expect(sctp.startCancellationError?.message).toBe(
            "transport rejected",
          );
        } else {
          expect(sctp.state).not.toBe("closed");
          expect(sctp.associationState).toBe(phase);
          expect(sctp.startCancellationError).toBeUndefined();
        }

        if (!cancelled) {
          // Act: 送信を回復させ、次の T1 再送を発生させる。
          const before = control.sent.length;
          control.restoreSends();
          await vi.advanceTimersByTimeAsync(5);

          // Assert: 同じ association が開始 chunk を再送している。
          expect(control.sent.length).toBeGreaterThan(before);
        }
      } finally {
        await sctp.stop();
        vi.useRealTimers();
      }
    },
  );

  test.each(["loss", "revoked"] as const)(
    "INIT 送信失敗 (%s) は送信許可の取消しのときだけ association を閉じる",
    async (kind) => {
      // Arrange: 送信が失敗する transport の開始側。
      vi.useFakeTimers();
      const control = createControlledTransport();
      const sctp = SCTP.client(control.transport, 5000);
      (sctp as unknown as { rto: number }).rto = 0.001;
      control.failSends(kind);

      try {
        // Act: INIT を送信する。
        const starting = sctp.start(5001);

        // Assert: 取消しは CLOSED + reject、損失は COOKIE_WAIT で T1 に任せる。
        if (kind === "revoked") {
          await expect(starting).rejects.toThrow("transport rejected");
          expect(sctp.state).toBe("closed");
          return;
        }
        await starting;
        expect(sctp.associationState).toBe(SCTP_STATE.COOKIE_WAIT);

        // Act: 送信を回復させ、T1 を満了させる。
        control.restoreSends();
        await vi.advanceTimersByTimeAsync(5);

        // Assert: T1 が INIT を再送している。
        expect(sentChunkTypes(control.sent)).toContain(InitChunk.type);
      } finally {
        await sctp.stop();
        vi.useRealTimers();
      }
    },
  );
});

describe("sctp flight size accounting", () => {
  /** Sends one single-chunk message per size and returns their TSNs. */
  const sendMessages = async (sctp: SCTP, sizes: number[]) => {
    for (const size of sizes) {
      await sctp.send(0, 51, Buffer.alloc(size));
    }
    await settle();
    return sentQueueOf(sctp)
      .slice(-sizes.length)
      .map((c) => c.tsn);
  };

  const fireT3 = async (sctp: SCTP) => {
    (sctp as any).timer3Cancel();
    (sctp as any).timer3Expired();
    await settle();
  };

  test("T3 after gap ACK retransmits only the missing chunk and send keeps working (#806)", async () => {
    const { sctp, transport } = createMockSctp({ established: true });
    try {
      const [t0, t1, t2] = await sendMessages(sctp, [36, 652, 652]);
      expect(flightSizeOf(sctp)).toBe(book(36) + 2 * book(652));

      // 先頭 TSN を失い、後ろの 2 件を Gap ACK する
      await receiveSack(sctp, buildSack(tsnBefore(t0), [[2, 3]]));
      // Gap ACK 分だけ flightSize が減る
      expect(flightSizeOf(sctp)).toBe(book(36));
      expectFlightSizeInvariant(sctp);

      // T3 を発火させる
      const beforeT3 = transport.send.mock.calls.length;
      await fireT3(sctp);
      // 欠落した先頭 TSN だけが再送される
      expect(sentDataTsns(transport, beforeT3)).toEqual([t0]);
      expect(flightSizeOf(sctp)).toBe(book(36));
      expectFlightSizeInvariant(sctp);

      // 全件を累積 ACK する
      await receiveSack(sctp, buildSack(t2));
      // sentQueue が空になり flightSize も 0 に戻る
      expect(sentQueueOf(sctp)).toHaveLength(0);
      expect(flightSizeOf(sctp)).toBe(0);
      expect(t1).toBe((t0 + 1) % 0x100000000);

      // 新しいメッセージを送る
      const beforeSend = transport.send.mock.calls.length;
      await sctp.send(0, 51, Buffer.alloc(100));
      await settle();
      // outboundQueue から送出され、send() が resolve している
      expect(outboundQueueOf(sctp).length).toBe(0);
      expect(sentDataTsns(transport, beforeSend)).toHaveLength(1);
      expectFlightSizeInvariant(sctp);
    } finally {
      await disposeMockSctp(sctp);
    }
  });

  test("heartbeat is sent again once everything is acked after T3", async () => {
    const { sctp, transport } = createMockSctp({ established: true });
    try {
      const [t0, , t2] = await sendMessages(sctp, [36, 652, 652]);
      await receiveSack(sctp, buildSack(tsnBefore(t0), [[2, 3]]));
      await fireT3(sctp);
      await receiveSack(sctp, buildSack(t2));

      // heartbeat タイマーを発火させる
      const before = transport.send.mock.calls.length;
      await (sctp as any).timerHeartbeatExpired();
      // HEARTBEAT チャンクが送られる
      expect(sentChunks(transport, before).map((c) => c.type)).toEqual([
        HeartbeatChunk.type,
      ]);
    } finally {
      await disposeMockSctp(sctp);
    }
  });

  test("chunk gap-acked while its T3 retransmission is pending is not resent", async () => {
    const { sctp, transport } = createMockSctp({ established: true });
    try {
      const [t0, t1, t2] = await sendMessages(sctp, [100, 100, 100]);
      const hold = holdTransport(transport);

      // T3 で全件を再送予約し、先頭の再送送出で止める
      const beforeT3 = transport.send.mock.calls.length;
      (sctp as any).timer3Cancel();
      (sctp as any).timer3Expired();
      await settle();
      // 再送前に 2 件目が Gap ACK される
      await receiveSack(sctp, buildSack(tsnBefore(t0), [[2, 2]]));
      // 二重計上せず、2 件目の再送予約が取り消される
      expectFlightSizeInvariant(sctp);
      expect(sentQueueOf(sctp)[1].retransmit).toBe(false);

      // 送信を再開する
      hold.release();
      await settle();
      // Gap ACK 済みの 2 件目は再送されない
      expect(sentDataTsns(transport, beforeT3)).toEqual([t0, t2]);
      expect(flightSizeOf(sctp)).toBe(2 * book(100));
      expectFlightSizeInvariant(sctp);
      expect(t1).not.toBe(t0);
    } finally {
      await disposeMockSctp(sctp);
    }
  });

  test("a chunk is fast-retransmitted only once until the T3-rtx timer resends it (RFC 9260 §7.2.4)", async () => {
    const { sctp, transport } = createMockSctp({ established: true });
    try {
      const tsns = await sendMessages(sctp, Array(14).fill(100));
      const [t0] = tsns;
      const before = transport.send.mock.calls.length;
      const resentT0 = () =>
        sentDataTsns(transport, before).filter((tsn) => tsn === t0).length;

      // Act: 先頭 TSN が欠けたまま、後ろを 1 件ずつ Gap ACK する SACK を 9 回受ける (miss 9 回)。
      for (let end = 2; end <= 10; end++) {
        await receiveSack(sctp, buildSack(tsnBefore(t0), [[2, end]]));
      }
      await settle();

      // Assert: 3 回目の miss で 1 回だけ Fast Retransmit し、その後の miss では再送しない。
      expect(resentT0()).toBe(1);

      // Act: 再送も失われたとして T3 が発火し、さらに新しい Gap ACK で miss が 3 回続く。
      await fireT3(sctp);
      for (let end = 11; end <= 13; end++) {
        await receiveSack(sctp, buildSack(tsnBefore(t0), [[2, end]]));
      }
      await settle();

      // Assert: T3 が再送し、その後は再び 1 回だけ Fast Retransmit できる。
      expect(resentT0()).toBe(3);
      expectFlightSizeInvariant(sctp);
    } finally {
      await disposeMockSctp(sctp);
    }
  });

  test("chunk gap-acked while its fast retransmission is pending is not resent", async () => {
    const { sctp, transport } = createMockSctp({ established: true });
    try {
      const [t0, t1] = await sendMessages(sctp, [100, 100, 100, 100, 100]);
      await receiveSack(sctp, buildSack(t0, [[2, 2]]));
      await receiveSack(sctp, buildSack(t0, [[2, 3]]));
      const hold = holdTransport(transport);
      const beforeLoss = transport.send.mock.calls.length;
      // 送出中の新規メッセージで送信を止める
      const pendingSend = sctp.send(0, 51, Buffer.alloc(100));
      await settle();

      // 3 回目の miss で 2 件目が Fast Retransmit 予約される
      await receiveSack(sctp, buildSack(t0, [[2, 4]]));
      // 再送予約されたチャンクは計上から外れる
      expect(sentQueueOf(sctp)[0].retransmit).toBe(true);
      expect(sentQueueOf(sctp)[0].inFlight).toBe(false);
      expectFlightSizeInvariant(sctp);

      // 再送前に 2 件目が Gap ACK される
      await receiveSack(sctp, buildSack(t0, [[1, 4]]));
      // 二重減算せず不変条件が保たれる
      expectFlightSizeInvariant(sctp);

      // 送信を再開する
      hold.release();
      await pendingSend;
      await settle();
      // 2 件目は再送されない
      expect(sentDataTsns(transport, beforeLoss)).not.toContain(t1);
      expectFlightSizeInvariant(sctp);
    } finally {
      await disposeMockSctp(sctp);
    }
  });

  test("duplicate acks and consecutive T3 keep the invariant", async () => {
    const { sctp, transport } = createMockSctp({ established: true });
    try {
      const [t0, , t2] = await sendMessages(sctp, [100, 200, 300]);

      // 同じチャンクへの Gap ACK を重複して受ける
      await receiveSack(sctp, buildSack(tsnBefore(t0), [[2, 2]]));
      await receiveSack(sctp, buildSack(tsnBefore(t0), [[2, 2]]));
      // Gap ACK 済みの分は一度だけ減算される
      expect(flightSizeOf(sctp)).toBe(book(100) + book(300));
      expectFlightSizeInvariant(sctp);

      // 再送を止めたまま T3 を 2 回連続で発火させる
      const hold = holdTransport(transport);
      (sctp as any).timer3Cancel();
      (sctp as any).timer3Expired();
      await settle();
      (sctp as any).timer3Cancel();
      (sctp as any).timer3Expired();
      await settle();
      // 2 回目の T3 で送出中の先頭も再送予約に戻り、計上は 0 になる
      expect(flightSizeOf(sctp)).toBe(0);
      expect(sentQueueOf(sctp)[0].retransmit).toBe(true);
      expectFlightSizeInvariant(sctp);

      // 再送前に全件を累積 ACK する
      await receiveSack(sctp, buildSack(t2));
      // 過少計上も残存もなく 0 になる
      expect(sentQueueOf(sctp)).toHaveLength(0);
      expect(flightSizeOf(sctp)).toBe(0);

      // 送信を再開する
      hold.release();
      await settle();
      // 計上は 0 のまま
      expect(flightSizeOf(sctp)).toBe(0);
      expectFlightSizeInvariant(sctp);
    } finally {
      await disposeMockSctp(sctp);
    }
  });

  test("gap ACK after cumulative ACK of a gap-acked chunk keeps the invariant", async () => {
    const { sctp } = createMockSctp({ established: true });
    try {
      const [t0, t1] = await sendMessages(sctp, [100, 200, 300]);

      // 2 件目を Gap ACK した後、2 件目まで累積 ACK する
      await receiveSack(sctp, buildSack(tsnBefore(t0), [[2, 2]]));
      await receiveSack(sctp, buildSack(t1));
      // 残る 3 件目だけが計上されている
      expect(flightSizeOf(sctp)).toBe(book(300));
      expectFlightSizeInvariant(sctp);
    } finally {
      await disposeMockSctp(sctp);
    }
  });

  test("abandoned chunks of the expired message are not counted after FORWARD TSN", async () => {
    const { sctp, transport } = createMockSctp({ established: true });
    try {
      const maxPayloadSize: number = (sctp as any).maxPayloadSize;
      await sctp.send(0, 51, Buffer.alloc(100));
      await sctp.send(0, 51, Buffer.alloc(maxPayloadSize * 2 + 10), {
        expiry: Date.now() + 60_000,
      });
      await settle();
      const [head, ...fragments] = sentQueueOf(sctp);
      expect(fragments).toHaveLength(3);
      for (const fragment of fragments) {
        fragment.expiry = Date.now() - 1000;
      }

      // T3 で期限切れの複数フラグメントメッセージを破棄判定する
      const beforeT3 = transport.send.mock.calls.length;
      await fireT3(sctp);
      // 対象メッセージのフラグメントだけが破棄され、先頭は再送される
      expect(head.abandoned).toBe(false);
      expect(fragments.every((c) => c.abandoned)).toBe(true);
      expect(sentDataTsns(transport, beforeT3)).toEqual([head.tsn]);
      expect(flightSizeOf(sctp)).toBe(book(100));
      expectFlightSizeInvariant(sctp);

      // 先頭を累積 ACK する
      const beforeAck = transport.send.mock.calls.length;
      await receiveSack(sctp, buildSack(head.tsn));
      await settle();
      // 破棄分が FORWARD TSN で進められ、計上が残らない
      const forwardTsn = sentChunks(transport, beforeAck).find(
        (c): c is ForwardTsnChunk => c instanceof ForwardTsnChunk,
      );
      expect(forwardTsn?.cumulativeTsn).toBe(fragments[2].tsn);
      expect(sentQueueOf(sctp)).toHaveLength(0);
      expect(flightSizeOf(sctp)).toBe(0);
    } finally {
      await disposeMockSctp(sctp);
    }
  });

  test("maxRetransmits abandonment releases the flight size", async () => {
    const { sctp, transport } = createMockSctp({ established: true });
    try {
      await sctp.send(0, 51, Buffer.alloc(100), { maxRetransmits: 1 });
      await settle();

      // T3 を 2 回発火させ、再送上限を超えさせる
      await fireT3(sctp);
      const before = transport.send.mock.calls.length;
      await fireT3(sctp);
      // DATA は再送されず FORWARD TSN が送られ、計上が残らない
      expect(sentDataTsns(transport, before)).toEqual([]);
      expect(
        sentChunks(transport, before).some((c) => c instanceof ForwardTsnChunk),
      ).toBe(true);
      expect(sentQueueOf(sctp)).toHaveLength(0);
      expect(flightSizeOf(sctp)).toBe(0);
    } finally {
      await disposeMockSctp(sctp);
    }
  });

  test("reneged gap-acked chunk is retransmitted after three misses", async () => {
    const { sctp, transport } = createMockSctp({ established: true });
    try {
      const [t0, t1, , , t4] = await sendMessages(
        sctp,
        [100, 100, 100, 100, 100],
      );
      await receiveSack(sctp, buildSack(tsnBefore(t0), [[2, 2]]));
      const reneged = sentQueueOf(sctp)[1];
      expect(reneged.acked).toBe(true);

      // Gap ACK した 2 件目を含まない SACK を 3 回受ける
      const before = transport.send.mock.calls.length;
      await receiveSack(sctp, buildSack(tsnBefore(t0), [[3, 3]]));
      await receiveSack(sctp, buildSack(tsnBefore(t0), [[3, 4]]));
      await receiveSack(sctp, buildSack(tsnBefore(t0), [[3, 5]]));
      await settle();
      // 2 件目は acked が外れて再送され、一度だけ計上される
      expect(reneged.acked).toBe(false);
      expect(sentDataTsns(transport, before)).toContain(t1);
      expect(reneged.inFlight).toBe(true);
      expectFlightSizeInvariant(sctp);

      // 全件を累積 ACK する
      await receiveSack(sctp, buildSack(t4));
      // 計上が残らない
      expect(sentQueueOf(sctp)).toHaveLength(0);
      expect(flightSizeOf(sctp)).toBe(0);
    } finally {
      await disposeMockSctp(sctp);
    }
  });
  test("gap ACK の取り消し後に新規 ACK がなくても T3 で再送される", async () => {
    // Arrange: 3 件送信し、2 件目(B)だけ Gap ACK される
    const { sctp, transport } = createMockSctp({ established: true });
    try {
      const [t0, t1] = await sendMessages(sctp, [100, 100, 100]);
      await receiveSack(sctp, buildSack(tsnBefore(t0), [[2, 2]]));
      expect(sentQueueOf(sctp)[1].acked).toBe(true);

      // Act: B を含まず、A(t0)までの累積 ACK のみの SACK を受ける
      await receiveSack(sctp, buildSack(t0));

      // Assert: 取り消された B は未確認に戻り、未確認の C とともに送信中として flightSize に再計上される
      const [renegedB, pendingC] = sentQueueOf(sctp);
      expect(renegedB.acked).toBe(false);
      expect(renegedB.inFlight).toBe(true);
      expect(pendingC.inFlight).toBe(true);
      expect(flightSizeOf(sctp)).toBe(renegedB.bookSize + pendingC.bookSize);
      expectFlightSizeInvariant(sctp);

      // Act: T3 が発火する
      const before = transport.send.mock.calls.length;
      (sctp as any).timer3Expired();
      await settle();

      // Assert: B の acked が外れ、T3 で再送され、計上が整合している
      const reneged = sentQueueOf(sctp)[0];
      expect(reneged.tsn).toBe(t1);
      expect(reneged.acked).toBe(false);
      expect(sentDataTsns(transport, before)).toContain(t1);
      expectFlightSizeInvariant(sctp);
      // 再送後も T3 が動作している
      expect((sctp as any).timer3Handle).toBeDefined();
    } finally {
      await disposeMockSctp(sctp);
    }
  });
  test("破棄済みの Gap ACK 断片は取り消されても再計上されない", async () => {
    // Arrange: 先頭の信頼性ありチャンク A と、3 断片のメッセージを送る
    const { sctp, transport } = createMockSctp({ established: true });
    try {
      const maxPayloadSize: number = (sctp as any).maxPayloadSize;
      await sctp.send(0, 51, Buffer.alloc(100));
      await sctp.send(0, 51, Buffer.alloc(maxPayloadSize * 2 + 10), {
        expiry: Date.now() + 60_000,
      });
      await settle();
      const [head, f1, f2, f3] = sentQueueOf(sctp);
      // 2 番目の断片だけ Gap ACK され、その後メッセージが期限切れになる
      await receiveSack(sctp, buildSack(tsnBefore(head.tsn), [[3, 3]]));
      expect(f2.acked).toBe(true);
      for (const f of [f1, f2, f3]) f.expiry = Date.now() - 1000;
      await fireT3(sctp);
      expect(f2.abandoned).toBe(true);

      // Act: 断片を含まない SACK を受け、再度 T3 が発火する
      await receiveSack(sctp, buildSack(tsnBefore(head.tsn)));
      const before = transport.send.mock.calls.length;
      await fireT3(sctp);

      // Assert: 破棄済み断片は再計上されず、A だけが再送される
      expect(sentDataTsns(transport, before)).toEqual([head.tsn]);
      expect(flightSizeOf(sctp)).toBe(book(100));
      expectFlightSizeInvariant(sctp);
      expect((sctp as any).timer3Handle).toBeDefined();

      // Act: A を累積 ACK する
      const beforeAck = transport.send.mock.calls.length;
      await receiveSack(sctp, buildSack(head.tsn));
      await settle();

      // Assert: FORWARD TSN で破棄分が進められ、計上が残らない
      const forwardTsn = sentChunks(transport, beforeAck).find(
        (c): c is ForwardTsnChunk => c instanceof ForwardTsnChunk,
      );
      expect(forwardTsn?.cumulativeTsn).toBe(f3.tsn);
      expect(sentQueueOf(sctp)).toHaveLength(0);
      expect(flightSizeOf(sctp)).toBe(0);
    } finally {
      await disposeMockSctp(sctp);
    }
  });
});
