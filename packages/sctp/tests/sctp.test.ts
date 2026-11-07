import { createSocket } from "dgram";
import { setTimeout } from "timers/promises";
import { vi } from "vitest";

import { SCTP, SCTP_STATE } from "../src";
import {
  AbortChunk,
  DataChunk,
  ForwardTsnChunk,
  HeartbeatChunk,
  SackChunk,
  serializePacket,
} from "../src/chunk";
import { StreamAddOutgoingParam } from "../src/param";
import { createUdpTransport } from "../src/transport";
import {
  buildSack,
  createChunkQueue,
  createMockSctp,
  disposeMockSctp,
  expectFlightSizeInvariant,
  flightSizeOf,
  holdTransport,
  receiveSack,
  sentChunks,
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
      expect(flightSizeOf(sctp)).toBe(1340);

      // 先頭 TSN を失い、後ろの 2 件を Gap ACK する
      await receiveSack(sctp, buildSack(tsnBefore(t0), [[2, 3]]));
      // Gap ACK 分だけ flightSize が減る
      expect(flightSizeOf(sctp)).toBe(36);
      expectFlightSizeInvariant(sctp);

      // T3 を発火させる
      const beforeT3 = transport.send.mock.calls.length;
      await fireT3(sctp);
      // 欠落した先頭 TSN だけが再送される
      expect(sentDataTsns(transport, beforeT3)).toEqual([t0]);
      expect(flightSizeOf(sctp)).toBe(36);
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
      expect((sctp as any).outboundQueue.length).toBe(0);
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
      expect(flightSizeOf(sctp)).toBe(200);
      expectFlightSizeInvariant(sctp);
      expect(t1).not.toBe(t0);
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
      expect(flightSizeOf(sctp)).toBe(400);
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
      expect(flightSizeOf(sctp)).toBe(300);
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
        expiry: Date.now() / 1000 + 60,
      });
      await settle();
      const [head, ...fragments] = sentQueueOf(sctp);
      expect(fragments).toHaveLength(3);
      for (const fragment of fragments) {
        fragment.expiry = Date.now() / 1000 - 1;
      }

      // T3 で期限切れの複数フラグメントメッセージを破棄判定する
      const beforeT3 = transport.send.mock.calls.length;
      await fireT3(sctp);
      // 対象メッセージのフラグメントだけが破棄され、先頭は再送される
      expect(head.abandoned).toBe(false);
      expect(fragments.every((c) => c.abandoned)).toBe(true);
      expect(sentDataTsns(transport, beforeT3)).toEqual([head.tsn]);
      expect(flightSizeOf(sctp)).toBe(100);
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

      // Act: B を含まず、A(t0)までの累積 ACK のみの SACK を受け、T3 が発火する
      await receiveSack(sctp, buildSack(t0));
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
        expiry: Date.now() / 1000 + 60,
      });
      await settle();
      const [head, f1, f2, f3] = sentQueueOf(sctp);
      // 2 番目の断片だけ Gap ACK され、その後メッセージが期限切れになる
      await receiveSack(sctp, buildSack(tsnBefore(head.tsn), [[3, 3]]));
      expect(f2.acked).toBe(true);
      for (const f of [f1, f2, f3]) f.expiry = Date.now() / 1000 - 1;
      await fireT3(sctp);
      expect(f2.abandoned).toBe(true);

      // Act: 断片を含まない SACK を受け、再度 T3 が発火する
      await receiveSack(sctp, buildSack(tsnBefore(head.tsn)));
      const before = transport.send.mock.calls.length;
      await fireT3(sctp);

      // Assert: 破棄済み断片は再計上されず、A だけが再送される
      expect(sentDataTsns(transport, before)).toEqual([head.tsn]);
      expect(flightSizeOf(sctp)).toBe(100);
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
