import { createSocket } from "dgram";
import { setTimeout } from "timers/promises";
import { vi } from "vitest";

import { SCTP, SCTP_STATE } from "../src";
import {
  AbortChunk,
  CookieAckChunk,
  CookieEchoChunk,
  DataChunk,
  InitChunk,
  SackChunk,
} from "../src/chunk";
import { serializePacket } from "../src/chunk";
import { StreamAddOutgoingParam } from "../src/param";
import type { Transport } from "../src/transport";
import { createUdpTransport } from "../src/transport";
import {
  createControlledTransport,
  receiveCookieEcho,
  receiveInitAck,
  receiveInitAndTakeCookie,
  sentChunkTypes,
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
  const createMockSctp = () => {
    const transport: Transport = {
      send: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const sctp = SCTP.client(transport, 5000);
    sctp.setRemotePort(5001);
    return { sctp, transport };
  };

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

  test("INIT transport failure closes and rejects the association", async () => {
    // Arrange: INIT を送信する transport が失敗する。
    const transport: Transport = {
      send: vi.fn(async () => {
        throw new Error("transport unavailable");
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
    (sctp as any).sentQueue = [sent];
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
    { phase: "COOKIE_WAIT", afterInitAck: false, cancelled: true },
    { phase: "COOKIE_ECHOED", afterInitAck: true, cancelled: false },
  ])(
    "T1 再送の送信失敗は確定前だけ start を取り消す ($phase)",
    async ({ afterInitAck, cancelled }) => {
      // Arrange: 短い RTO の開始側を、指定のフェーズまで進める。
      vi.useFakeTimers();
      const control = createControlledTransport();
      const sctp = SCTP.client(control.transport, 5000);
      (sctp as unknown as { rto: number }).rto = 0.001;
      try {
        await sctp.start(5001);
        if (afterInitAck) await receiveInitAck(sctp);

        // Act: 以降の送信を失敗させ、T1 再送を1回発生させる。
        control.failSends();
        await vi.advanceTimersByTimeAsync(2);

        // Assert: 確定前は即時取消し、確定後は association を維持する。
        if (cancelled) {
          expect(sctp.state).toBe("closed");
          expect(sctp.startCancellationError?.message).toBe(
            "transport rejected",
          );
        } else {
          expect(sctp.state).not.toBe("closed");
          expect(sctp.associationState).toBe(SCTP_STATE.COOKIE_ECHOED);
          expect(sctp.startCancellationError).toBeUndefined();
        }
      } finally {
        await sctp.stop();
        vi.useRealTimers();
      }
    },
  );
});
