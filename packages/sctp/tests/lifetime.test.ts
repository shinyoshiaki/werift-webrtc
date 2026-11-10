import { afterEach, describe, expect, test, vi } from "vitest";

import { SCTP_STATE } from "../src";
import {
  AbortChunk,
  DataChunk,
  ForwardTsnChunk,
  SackChunk,
} from "../src/chunk";
import {
  advancePastT3,
  buildSack,
  createLossyPrSctpPair,
  createSeededRandom,
  createZeroWindowMockSctp,
  disposeMockSctp,
  findFlightSizeViolation,
  flushImmediates,
  propertySeeds,
  receiveSack,
  recordedData,
  recordedForwardTsns,
  sentChunks,
  sentDataTsns,
  tsnBefore,
} from "./utils";

describe("PR-SCTP lifetime (expiry) abandonment", () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  test("abandons an undelivered chunk after its lifetime, sends FORWARD-TSN, and the next message is delivered", async () => {
    // Arrange: クライアントの DATA を破棄し、寿命 100ms のメッセージを送る準備
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    pair.recorder.dropData = true;
    const received: Buffer[] = [];
    pair.server.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data);
    });

    // Act: 寿命付きメッセージを送信し (破棄される)、寿命と T3-rtx を超えて時間を進める
    await pair.client.send(0, 53, Buffer.from("expired"), {
      expiry: Date.now() + 100,
      ordered: true,
    });
    await flushImmediates();
    const abandoned = recordedData(pair.recorder)[0]!;
    await advancePastT3();

    // Assert: FORWARD-TSN が破棄チャンクの TSN を累積 TSN として送られ、送信キューから外れる
    const forwardTsn = recordedForwardTsns(pair.recorder)[0];
    expect(forwardTsn?.cumulativeTsn).toBe(abandoned.tsn);
    expect(forwardTsn?.streams).toEqual([[0, abandoned.streamSeqNum]]);
    expect((pair.client as any).sentQueue.length).toBe(0);
    // Assert: 受信側の累積 TSN が破棄チャンクまで進む
    expect((pair.server as any).lastReceivedTsn).toBe(abandoned.tsn);

    // Act: 同じストリームで次のメッセージを (破棄なしで) 送る
    pair.recorder.dropData = false;
    await pair.client.send(0, 53, Buffer.from("next"), { ordered: true });
    await flushImmediates();

    // Assert: 順序付き配送が止まらず、次のメッセージだけが届く
    expect(received.map((d) => d.toString())).toEqual(["next"]);
  });

  test("retransmits instead of abandoning a chunk whose lifetime has not expired", async () => {
    // Arrange: クライアントの DATA を破棄し、寿命 10s のメッセージを送る準備
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    pair.recorder.dropData = true;

    // Act: 寿命付きメッセージを送信し、T3-rtx だけを超えて時間を進める
    await pair.client.send(0, 53, Buffer.from("alive"), {
      expiry: Date.now() + 10_000,
      ordered: true,
    });
    await flushImmediates();
    await advancePastT3();

    // Assert: 同じ TSN の DATA が再送され、FORWARD-TSN は送られず、チャンクは破棄されていない
    const dataTsns = recordedData(pair.recorder).map((c) => c.tsn);
    expect(dataTsns.length).toBe(2);
    expect(dataTsns[1]).toBe(dataTsns[0]);
    expect(recordedForwardTsns(pair.recorder).length > 0).toBe(false);
    const sentQueue: DataChunk[] = [...(pair.client as any).sentQueue];
    expect(sentQueue.map((c) => c.abandoned)).toEqual([false]);
  });

  test("abandons all fragments of the expired message and only those", async () => {
    // Arrange: クライアントの DATA を破棄し、未失効メッセージの後ろに失効する断片化メッセージを置く
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    pair.recorder.dropData = true;

    // Act: 寿命 10s の単一チャンクと、寿命 100ms の断片化メッセージを送り、T3-rtx を超えて時間を進める
    await pair.client.send(0, 53, Buffer.from("alive"), {
      expiry: Date.now() + 10_000,
      ordered: true,
    });
    await pair.client.send(0, 53, Buffer.alloc(3_000, 1), {
      expiry: Date.now() + 100,
      ordered: true,
    });
    await flushImmediates();
    await advancePastT3();

    // Assert: 先頭の未失効チャンクは再送対象のまま、失効メッセージの全断片だけが破棄される
    const sentQueue: DataChunk[] = [...(pair.client as any).sentQueue];
    expect(sentQueue.length).toBe(4);
    expect(sentQueue.map((c) => c.abandoned)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    // Assert: 先頭が未確認のため累積 TSN は進められず FORWARD-TSN は送られない
    expect(recordedForwardTsns(pair.recorder).length > 0).toBe(false);
  });

  test("abandons fragments still waiting in outboundQueue so the next ordered message is delivered", async () => {
    // Arrange: クライアントの DATA を破棄し、輻輳ウィンドウに収まらない大きな失効メッセージを送る準備
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    pair.recorder.dropData = true;
    const received: Buffer[] = [];
    pair.server.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data);
    });
    const sending = pair.client.send(0, 53, Buffer.alloc(20_000, 1), {
      expiry: Date.now() + 100,
      ordered: true,
    });
    await flushImmediates();
    const client = pair.client as any;
    const queuedBefore = client.outboundQueue.length;
    const lastTsn = (client.localTsn + 0xffffffff) % 0x100000000;

    // Act: 寿命と T3-rtx を超えて時間を進める
    await advancePastT3();
    await sending;

    // Assert: 一部の断片が未送信だったことを前提に、未送信断片も含めて全て破棄され送信キューが空になる
    expect(queuedBefore).toBeGreaterThan(0);
    expect(client.outboundQueue.length).toBe(0);
    expect(client.sentQueue.length).toBe(0);
    // Assert: FORWARD-TSN がメッセージ最終断片の TSN まで累積 TSN を進める
    const forwardTsn = recordedForwardTsns(pair.recorder)[0];
    expect(forwardTsn?.cumulativeTsn).toBe(lastTsn);

    // Act: 同じストリームで次のメッセージを送る
    pair.recorder.dropData = false;
    await pair.client.send(0, 53, Buffer.from("next"), { ordered: true });
    await flushImmediates();

    // Assert: 未送信断片は送られず、後続の順序付きメッセージが届く
    expect(received.map((d) => d.toString())).toEqual(["next"]);
  });
  test("resends a lost FORWARD-TSN until the peer acknowledges it", async () => {
    // Arrange: クライアントの DATA と最初の FORWARD-TSN を破棄する準備
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    pair.recorder.dropData = true;
    pair.recorder.dropForwardTsnCount = 1;
    const received: Buffer[] = [];
    pair.server.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data);
    });

    // Act: 寿命付きメッセージを送り、失効 (FORWARD-TSN 送信と損失) → 再送タイマーまで時間を進める
    await pair.client.send(0, 53, Buffer.from("expired"), {
      expiry: Date.now() + 100,
      ordered: true,
    });
    await flushImmediates();
    const abandoned = recordedData(pair.recorder)[0]!;
    await advancePastT3();
    // Assert: 1 回目の FORWARD-TSN は失われ、受信側の累積 TSN はまだ進んでいない
    expect((pair.server as any).lastReceivedTsn).not.toBe(abandoned.tsn);
    await advancePastT3();

    // Assert: FORWARD-TSN が再送され、受信側が進み、送信側の保持も解除される
    const forwardCount = recordedForwardTsns(pair.recorder).length;
    expect(forwardCount).toBe(2);
    expect((pair.server as any).lastReceivedTsn).toBe(abandoned.tsn);
    expect((pair.client as any).forwardTsnChunk).toBeUndefined();

    // Act: 同じストリームで次のメッセージを送る
    pair.recorder.dropData = false;
    await pair.client.send(0, 53, Buffer.from("next"), { ordered: true });
    await flushImmediates();

    // Assert: 後続の順序付きメッセージが届く
    expect(received.map((d) => d.toString())).toEqual(["next"]);
  });

  test("delivers a complete message received before the FORWARD-TSN that skips a broken one", async () => {
    // Arrange: 断片 A1(first) A3(last) と完全な B を受信済みにする (A2 は欠落)
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    const server = pair.server as any;
    const received: Buffer[] = [];
    pair.server.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data);
    });
    const base: number = server.lastReceivedTsn;
    const make = (offset: number, ssn: number, flags: number, data: string) => {
      const chunk = new DataChunk(0, undefined);
      chunk.tsn = (base + offset) % 0x100000000;
      chunk.streamId = 0;
      chunk.streamSeqNum = ssn;
      chunk.protocol = 53;
      chunk.flags = flags;
      chunk.userData = Buffer.from(data);
      return chunk;
    };
    server.receiveDataChunk(make(1, 0, 0x02, "A1"));
    server.receiveDataChunk(make(3, 0, 0x01, "A3"));
    server.receiveDataChunk(make(4, 1, 0x03, "B"));
    expect(received).toEqual([]);

    // Act: A を飛ばす FORWARD-TSN (累積 TSN = A3) を受信する
    const forward = new ForwardTsnChunk(0, undefined);
    forward.cumulativeTsn = (base + 3) % 0x100000000;
    forward.streams = [[0, 0]];
    server.receiveForwardTsnChunk(forward);

    // Assert: A は破棄され、先に受信していた B だけが配送される
    expect(received.map((d) => d.toString())).toEqual(["B"]);
    expect(server.lastReceivedTsn).toBe((base + 4) % 0x100000000);
  });
  test("does not move the expected SSN backwards on a stale stream entry in a FORWARD-TSN", async () => {
    // Arrange: ストリーム 0 は SSN 0,1 を配送済み (期待 SSN = 2)。ストリーム 1 は未着
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    const server = pair.server as any;
    const received: Buffer[] = [];
    pair.server.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data);
    });
    const base: number = server.lastReceivedTsn;
    const make = (
      offset: number,
      streamId: number,
      ssn: number,
      data: string,
    ) => {
      const chunk = new DataChunk(0, undefined);
      chunk.tsn = (base + offset) % 0x100000000;
      chunk.streamId = streamId;
      chunk.streamSeqNum = ssn;
      chunk.protocol = 53;
      chunk.flags = 0x03;
      chunk.userData = Buffer.from(data);
      return chunk;
    };
    server.receiveDataChunk(make(1, 0, 0, "a0"));
    server.receiveDataChunk(make(2, 0, 1, "a1"));
    expect(server.getInboundStream(0).streamSequenceNumber).toBe(2);

    // Act: ストリーム 0 の古いエントリ (SSN 0) を引き継いだ FORWARD-TSN を受信し、続けてストリーム 0 の次のメッセージを受信する
    const forward = new ForwardTsnChunk(0, undefined);
    forward.cumulativeTsn = (base + 4) % 0x100000000;
    forward.streams = [
      [0, 0],
      [1, 0],
    ];
    server.receiveForwardTsnChunk(forward);
    server.receiveDataChunk(make(5, 0, 2, "a2"));

    // Assert: ストリーム 0 の期待 SSN は後退せず、後続メッセージが配送される
    expect(received.map((d) => d.toString())).toEqual(["a0", "a1", "a2"]);
    expect(server.getInboundStream(1).streamSequenceNumber).toBe(1);

    // Act: SSN の折り返し (期待 SSN 0 に対し古いエントリ 65535) を受信する
    server.getInboundStream(2).streamSequenceNumber = 0;
    const wrap = new ForwardTsnChunk(0, undefined);
    wrap.cumulativeTsn = (base + 6) % 0x100000000;
    wrap.streams = [[2, 0xffff]];
    server.receiveForwardTsnChunk(wrap);

    // Assert: 折り返しでも期待 SSN は 0 のまま進まない/戻らない
    expect(server.getInboundStream(2).streamSequenceNumber).toBe(0);
  });
  test("delivers a following message that was received and acked while the expired message is skipped", async () => {
    // Arrange: 失効する A の DATA だけを破棄し、後続の B は正常に届く状態にする
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    const received: Buffer[] = [];
    pair.server.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data);
    });
    pair.recorder.dropData = true;
    await pair.client.send(0, 53, Buffer.from("A"), {
      expiry: Date.now() + 100,
      ordered: true,
    });
    pair.recorder.dropData = false;

    // Act: B を送信し (ギャップ SACK で確認済みになる)、A の失効と T3-rtx まで時間を進める
    await pair.client.send(0, 53, Buffer.from("B"), { ordered: true });
    await flushImmediates();
    const sentQueue: DataChunk[] = [...(pair.client as any).sentQueue];
    const b = sentQueue.find((c) => c.userData.toString() === "B")!;
    // Assert: B は確認済みで、順序待ちのため未配送
    expect(b.acked).toBe(true);
    expect(received).toEqual([]);
    await advancePastT3();

    // Assert: B は失効扱いにならず、FORWARD-TSN で A だけが飛ばされ B が配送される
    expect(b.abandoned).toBe(false);
    expect(received.map((d) => d.toString())).toEqual(["B"]);
  });

  test("keeps a complete ordered message whose TSN is inside the FORWARD-TSN range", async () => {
    // Arrange: A1 A3(A2 欠落) と完全な B を受信済みにする
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    const server = pair.server as any;
    const received: Buffer[] = [];
    pair.server.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data);
    });
    const base: number = server.lastReceivedTsn;
    const make = (offset: number, ssn: number, flags: number, data: string) => {
      const chunk = new DataChunk(0, undefined);
      chunk.tsn = (base + offset) % 0x100000000;
      chunk.streamId = 0;
      chunk.streamSeqNum = ssn;
      chunk.protocol = 53;
      chunk.flags = flags;
      chunk.userData = Buffer.from(data);
      return chunk;
    };
    server.receiveDataChunk(make(1, 0, 0x02, "A1"));
    server.receiveDataChunk(make(3, 0, 0x01, "A3"));
    server.receiveDataChunk(make(4, 1, 0x03, "B"));

    // Act: B の TSN まで含む累積 TSN で A のみを飛ばす FORWARD-TSN を受信する
    const forward = new ForwardTsnChunk(0, undefined);
    forward.cumulativeTsn = (base + 4) % 0x100000000;
    forward.streams = [[0, 0]];
    server.receiveForwardTsnChunk(forward);

    // Assert: B が破棄されず配送される
    expect(received.map((d) => d.toString())).toEqual(["B"]);
  });

  test("delivers a complete message the sender abandoned because its SACK was lost", async () => {
    // Arrange: 失効する A の DATA を破棄し、同じく寿命付きの B は届くが B を確認する SACK を失う
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    const received: Buffer[] = [];
    pair.server.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data);
    });
    pair.recorder.dropData = true;
    await pair.client.send(0, 53, Buffer.from("A"), {
      expiry: Date.now() + 100,
      ordered: true,
    });
    pair.recorder.dropData = false;
    pair.serverRecorder.dropSack = true;
    await pair.client.send(0, 53, Buffer.from("B"), {
      expiry: Date.now() + 100,
      ordered: true,
    });
    await flushImmediates();
    pair.serverRecorder.dropSack = false;
    const sentQueue: DataChunk[] = [...(pair.client as any).sentQueue];
    const b = sentQueue.find((c) => c.userData.toString() === "B")!;
    // Assert: 送信側は B の受信を知らず、受信側は A 待ちで B を保持している
    expect(b.acked).toBe(false);
    expect(received).toEqual([]);

    // Act: 寿命と T3-rtx を超えて時間を進め、A と B を飛ばす FORWARD-TSN を送らせる
    await advancePastT3();

    // Assert: FORWARD-TSN は B まで含むが、受信済みで完全な B は破棄されず配送される
    const forwardTsn = recordedForwardTsns(pair.recorder)[0];
    expect(forwardTsn?.cumulativeTsn).toBe(b.tsn);
    expect(received.map((d) => d.toString())).toEqual(["B"]);
    // Assert: 受信ウィンドウが初期値 (1MiB) に戻り、受信バッファの勘定がずれない
    expect((pair.server as any).advertisedRwnd).toBe(1024 * 1024);
  });

  test("does not retransmit a gap-acked chunk on T3-rtx and keeps flightSize consistent", async () => {
    // Arrange: 寿命なしの A を失い、最大ペイロードの B は届いてギャップ SACK で確認済みにする
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    const client = pair.client as any;
    const received: Buffer[] = [];
    pair.server.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data);
    });
    pair.recorder.dropData = true;
    await pair.client.send(0, 53, Buffer.from("A"), { ordered: true });
    pair.recorder.dropData = false;
    await pair.client.send(0, 53, Buffer.alloc(client.maxPayloadSize, 2), {
      ordered: true,
    });
    await flushImmediates();
    const b: DataChunk = [...client.sentQueue][1];
    expect(b.acked).toBe(true);

    // Act: T3-rtx を満了させて A を再送させ、累積 SACK を受け取る
    await advancePastT3();

    // Assert: 確認済みの B は再送されず、全確認後の flightSize が 0 に戻る
    const bSends = recordedData(pair.recorder).filter(
      (c) => c.tsn === b.tsn,
    ).length;
    expect(bSends).toBe(1);
    expect(received.length).toBe(2);
    expect(client.sentQueue.length).toBe(0);
    expect(client.flightSize).toBe(0);
  });

  /**
   * 大きな寿命なしメッセージ A の DATA を落として輻輳ウィンドウを埋め、
   * その後ろで寿命 lifetimeMs のメッセージ B を送信待ちにする。
   */
  const queueBehindCongestedMessage = async (lifetimeMs: number) => {
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    const client = pair.client as any;
    const received: string[] = [];
    pair.server.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data.length > 100 ? "A" : data.toString());
    });
    pair.recorder.dropData = true;
    const sends = [
      pair.client.send(0, 53, Buffer.alloc(20_000, 1), { ordered: true }),
      pair.client.send(0, 53, Buffer.from("B"), {
        expiry: Date.now() + lifetimeMs,
        ordered: true,
      }),
    ];
    await flushImmediates();
    const queued: DataChunk[] = [...client.outboundQueue];
    const b = queued[queued.length - 1];
    return { pair, client, received, sends, b };
  };

  /** 損失を止め、送信側のキューが空になるまで T3-rtx を繰り返し進める。 */
  const drainClient = async (pair: { client: unknown }) => {
    const client = pair.client as any;
    for (
      let i = 0;
      i < 20 &&
      (client.outboundQueue.length > 0 ||
        client.sentQueue.length > 0 ||
        client.forwardTsnChunk);
      i++
    ) {
      await advancePastT3();
    }
  };

  test("abandons a message that expires before its first transmission", async () => {
    // Arrange: 寿命 100ms の B が輻輳ウィンドウ待ちで未送信のまま残る
    const { pair, client, received, sends, b } =
      await queueBehindCongestedMessage(100);
    expect(b.userData.toString()).toBe("B");
    expect(b.sentCount).toBe(0);

    // Act: 損失を止め、B の寿命を過ぎてから A の再送で送信可能にする
    pair.recorder.dropData = false;
    await drainClient(pair);
    await Promise.all(sends);

    // Assert: B は一度も送られず破棄され、FORWARD-TSN が B の TSN まで進める
    const bSends = recordedData(pair.recorder).filter(
      (c) => c.tsn === b.tsn,
    ).length;
    expect(bSends).toBe(0);
    expect(b.abandoned).toBe(true);
    expect((pair.server as any).lastReceivedTsn).toBe(b.tsn);
    expect(client.outboundQueue.length).toBe(0);
    expect(client.sentQueue.length).toBe(0);
    expect(client.flightSize).toBe(0);

    // Act: 同じストリームで次のメッセージを送る
    await pair.client.send(0, 53, Buffer.from("next"), { ordered: true });
    await flushImmediates();

    // Assert: A と後続メッセージだけが順に届き、B は配送されない
    expect(received).toEqual(["A", "next"]);
  });

  test("sends a queued message that becomes sendable within its lifetime", async () => {
    // Arrange: 寿命 60s の B が輻輳ウィンドウ待ちで未送信のまま残る
    const { pair, client, received, sends, b } =
      await queueBehindCongestedMessage(60_000);
    expect(b.sentCount).toBe(0);

    // Act: 損失を止め、寿命内に A の再送で送信可能にする
    pair.recorder.dropData = false;
    await drainClient(pair);
    await Promise.all(sends);

    // Assert: B は破棄されずに送られ、A に続いて配送される
    expect(b.abandoned).toBe(false);
    expect(b.sentCount).toBe(1);
    expect(client.sentQueue.length).toBe(0);
    expect(recordedForwardTsns(pair.recorder).length > 0).toBe(false);
    expect(received).toEqual(["A", "B"]);
  });

  /**
   * 寿命なしで最大ペイロードの A と寿命 lifetimeMs の B を失い、T3-rtx で両方を
   * 再送対象にする。cwnd が 1 MTU に絞られるため A だけが再送され、B は再送待ちに
   * なる。A を確認する SACK は保留し、後から届けられるようにする。
   */
  const holdRetransmissionBehindCwnd = async (lifetimeMs: number) => {
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    const client = pair.client as any;
    const received: string[] = [];
    pair.server.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data.length > 100 ? "A" : data.toString());
    });
    pair.recorder.dropData = true;
    await pair.client.send(0, 53, Buffer.alloc(client.maxPayloadSize, 1), {
      ordered: true,
    });
    await pair.client.send(0, 53, Buffer.from("B"), {
      expiry: Date.now() + lifetimeMs,
      ordered: true,
    });
    await flushImmediates();
    const b: DataChunk = [...client.sentQueue][1];
    pair.recorder.dropData = false;
    pair.serverRecorder.dropSack = true;
    await advancePastT3();
    pair.serverRecorder.dropSack = false;
    /** 保留していた SACK を送信側へ届ける。 */
    const deliverHeldSacks = async () => {
      for (const buf of pair.serverRecorder.heldSacks.splice(0)) {
        pair.transports.client.onData?.(buf);
      }
      await flushImmediates();
    };
    return { pair, client, received, b, deliverHeldSacks };
  };

  test("abandons a chunk whose lifetime expires while it waits for retransmission", async () => {
    // Arrange: 寿命 3.5s の B が T3-rtx 時点 (寿命内) で再送対象になり、cwnd 待ちで残る
    const { pair, client, received, b, deliverHeldSacks } =
      await holdRetransmissionBehindCwnd(3_500);
    expect(b.retransmit).toBe(true);
    expect(b.abandoned).toBe(false);
    expect(pair.serverRecorder.heldSacks.length).toBeGreaterThan(0);

    // Act: B の寿命を過ぎてから、A を確認する SACK を届けて送信枠を空ける
    await vi.advanceTimersByTimeAsync(500);
    await deliverHeldSacks();

    // Assert: B は再送されずに破棄され、FORWARD-TSN が B の TSN まで進める
    expect(
      recordedData(pair.recorder).filter((c) => c.tsn === b.tsn).length,
    ).toBe(1);
    expect(b.abandoned).toBe(true);
    const forwardTsn = recordedForwardTsns(pair.recorder)[0];
    expect(forwardTsn?.cumulativeTsn).toBe(b.tsn);
    expect((pair.server as any).lastReceivedTsn).toBe(b.tsn);
    expect(client.sentQueue.length).toBe(0);
    expect(client.flightSize).toBe(0);

    // Act: 同じストリームで次のメッセージを送る
    await pair.client.send(0, 53, Buffer.from("next"), { ordered: true });
    await flushImmediates();

    // Assert: A と後続メッセージだけが届き、B は配送されない
    expect(received).toEqual(["A", "next"]);
  });

  test("retransmits a chunk that is still alive when the window opens", async () => {
    // Arrange: 寿命 60s の B が T3-rtx で再送対象になり、cwnd 待ちで残る
    const { pair, client, received, b, deliverHeldSacks } =
      await holdRetransmissionBehindCwnd(60_000);
    expect(b.retransmit).toBe(true);

    // Act: 寿命内に、A を確認する SACK を届けて送信枠を空ける
    await vi.advanceTimersByTimeAsync(500);
    await deliverHeldSacks();

    // Assert: B は破棄されずに再送され、A に続いて配送される
    expect(
      recordedData(pair.recorder).filter((c) => c.tsn === b.tsn).length,
    ).toBe(2);
    expect(b.abandoned).toBe(false);
    expect(recordedForwardTsns(pair.recorder).length > 0).toBe(false);
    expect(client.sentQueue.length).toBe(0);
    expect(received).toEqual(["A", "B"]);
  });

  test("retransmits a gap-acked chunk after the receiver reneges on it", async () => {
    // Arrange: 寿命なしの A を失い、後続の B は届いてギャップ ACK 済みになる
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    const client = pair.client as any;
    const server = pair.server as any;
    const received: string[] = [];
    pair.server.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data.toString());
    });
    pair.recorder.dropData = true;
    await pair.client.send(0, 53, Buffer.from("A"), { ordered: true });
    pair.recorder.dropData = false;
    await pair.client.send(0, 53, Buffer.from("B"), { ordered: true });
    await flushImmediates();
    const b: DataChunk = [...client.sentQueue][1];
    expect(b.acked).toBe(true);
    // Arrange: 受信側がバッファ逼迫で、順序待ちの B を破棄したことを模擬する
    const stream = server.getInboundStream(0);
    server.advertisedRwnd += stream.reassembly.length;
    stream.reassembly = [];
    server.sackMisOrdered.delete(b.tsn);

    // Act: T3-rtx で A を再送させ、B を含まない SACK を受け取った後も時間を進める
    await advancePastT3();
    // Assert: B のギャップ ACK 撤回を検出し、未確認に戻す
    expect(received).toEqual(["A"]);
    expect(b.acked).toBe(false);
    await advancePastT3();

    // Assert: B が再送されて配送が回復し、送信側の状態も片付く
    const bSends = recordedData(pair.recorder).filter(
      (c) => c.tsn === b.tsn,
    ).length;
    expect(bSends).toBe(2);
    expect(received).toEqual(["A", "B"]);
    expect(client.sentQueue.length).toBe(0);
    expect(client.flightSize).toBe(0);
  });

  test("fast-retransmits a reneged chunk after three SACKs keep missing it", async () => {
    // Arrange: A を失い、後続の B はギャップ ACK 済み。受信側は B を破棄 (撤回) する
    const pair = await createLossyPrSctpPair();
    stop = pair.stop;
    const client = pair.client as any;
    const server = pair.server as any;
    const received: string[] = [];
    pair.server.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data.toString());
    });
    pair.recorder.dropData = true;
    await pair.client.send(0, 53, Buffer.from("A"), { ordered: true });
    pair.recorder.dropData = false;
    await pair.client.send(0, 53, Buffer.from("B"), { ordered: true });
    await flushImmediates();
    const [a, b]: DataChunk[] = [...client.sentQueue];
    expect(b.acked).toBe(true);
    const stream = server.getInboundStream(0);
    server.advertisedRwnd += stream.reassembly.length;
    stream.reassembly = [];
    server.sackMisOrdered.delete(b.tsn);
    /** 受信側が B を報告しなくなった SACK (ギャップなし) を送信側に届ける。 */
    const receiveSackWithoutB = async () => {
      const sack = new SackChunk(0, undefined);
      sack.cumulativeTsn = (a.tsn + 0xffffffff) % 0x100000000;
      sack.advertisedRwnd = server.advertisedRwnd;
      await client.receiveSackChunk(sack);
      await flushImmediates();
    };
    const bSends = () =>
      recordedData(pair.recorder).filter((c) => c.tsn === b.tsn).length;

    // Act: B を含まない SACK を 2 回受け取る (時間は進めない)
    await receiveSackWithoutB();
    await receiveSackWithoutB();

    // Assert: 撤回を検出して未確認に戻し、ミス指示を 1 回ずつ数えるがまだ再送しない
    expect(b.acked).toBe(false);
    expect(b.misses).toBe(2);
    expect(bSends()).toBe(1);

    // Act: 3 回目の SACK を受け取る
    await receiveSackWithoutB();

    // Assert: T3-rtx を待たずに Fast Retransmit で B が再送され、受信側が B を再び保持する
    expect(bSends()).toBe(2);
    expect(b.reneged).toBe(false);
    expect(b.acked).toBe(true);
    expect(server.sackMisOrdered.has(b.tsn)).toBe(true);

    // Act: T3-rtx で A を再送させる
    await advancePastT3();

    // Assert: 順序付き配送が回復し、送信側の状態も片付く
    expect(received).toEqual(["A", "B"]);
    expect(client.sentQueue.length).toBe(0);
    expect(client.flightSize).toBe(0);
  });
});

describe("PR-SCTP lifetime of DATA queued behind a zero receive window", () => {
  test("expires a queued message without any SACK, window update or other send", async () => {
    // Arrange: 相手の受信ウィンドウが 0 で、未確認 DATA がない association
    const { sctp, transport } = createZeroWindowMockSctp();
    const internal = sctp as any;
    try {
      let settled = false;

      // Act: 寿命 50ms のメッセージを投入する
      const sending = sctp
        .send(0, 51, Buffer.from("A"), { expiry: Date.now() + 50 })
        .then(() => {
          settled = true;
        });
      await flushImmediates();

      // Assert: ウィンドウ不足で送信されずキューに残り、T3 は動いていない
      expect(sctp.outboundQueue.length).toBe(1);
      expect(internal.timer3Handle).toBeUndefined();
      expect(settled).toBe(false);

      // Act: 他のイベントを起こさずに寿命を過ぎるまで待つ
      await new Promise((r) => setTimeout(r, 120));
      await flushImmediates();

      // Assert: 期限切れで破棄され、send() は解決し、FORWARD-TSN で相手に飛ばすことを伝える
      await sending;
      expect(settled).toBe(true);
      expect(sctp.outboundQueue.length).toBe(0);
      expect(internal.sentQueue.length).toBe(0);
      const forwardTsn = sentChunks(transport).find(
        (c): c is ForwardTsnChunk => c instanceof ForwardTsnChunk,
      );
      expect(forwardTsn).toBeDefined();
      expect(sentChunks(transport).some((c) => c instanceof DataChunk)).toBe(
        false,
      );
    } finally {
      await disposeMockSctp(sctp);
    }
  });

  test("expires a queued message behind a message without lifetime and keeps TSN order", async () => {
    // Arrange: 相手の受信ウィンドウが 0 の association に、寿命なしの A を先に積む
    const { sctp, transport } = createZeroWindowMockSctp();
    try {
      let aSettled = false;
      let bSettled = false;
      const sendingA = sctp.send(0, 51, Buffer.from("A")).then(() => {
        aSettled = true;
      });
      await flushImmediates();
      const [a] = [...sctp.outboundQueue];

      // Act: A の後ろに寿命 50ms の B を積み、他のイベントを起こさずに寿命を過ぎるまで待つ
      const sendingB = sctp
        .send(0, 51, Buffer.from("B"), { expiry: Date.now() + 50 })
        .then(() => {
          bSettled = true;
        });
      await new Promise((r) => setTimeout(r, 120));
      await flushImmediates();

      // Assert: B は TSN 順を保ったままキュー内で破棄済みになり、B の send() だけが先に解決する
      await sendingB;
      expect(bSettled).toBe(true);
      expect(aSettled).toBe(false);
      const [, b] = [...sctp.outboundQueue];
      expect(sctp.outboundQueue.length).toBe(2);
      expect(b.abandoned).toBe(true);
      expect(sentDataTsns(transport)).toEqual([]);

      // Act: 相手のウィンドウが開く
      await receiveSack(sctp, buildSack(tsnBefore(a.tsn)));
      await flushImmediates();

      // Assert: A だけが送られ、B は送られずに FORWARD-TSN で飛ばされる
      await sendingA;
      expect(aSettled).toBe(true);
      expect(sentDataTsns(transport)).toEqual([a.tsn]);
      expect(sctp.outboundQueue.length).toBe(0);
      await receiveSack(sctp, buildSack(a.tsn));
      await flushImmediates();
      const forwardTsn = sentChunks(transport)
        .filter((c): c is ForwardTsnChunk => c instanceof ForwardTsnChunk)
        .at(-1);
      expect(forwardTsn?.cumulativeTsn).toBe(b.tsn);
    } finally {
      await disposeMockSctp(sctp);
    }
  });

  test("releases the payload of queued messages that expire behind a pending message", async () => {
    // Arrange: 相手の受信ウィンドウが 0 の association に、寿命なしの A を先に積む
    const { sctp } = createZeroWindowMockSctp();
    try {
      void sctp.send(0, 51, Buffer.alloc(1024, 1));
      await flushImmediates();

      // Act: A の後ろに寿命 50ms の 1 KiB メッセージを 3 つ積み、寿命を過ぎるまで待つ
      const sends = [2, 3, 4].map((fill) =>
        sctp.send(0, 51, Buffer.alloc(1024, fill), {
          expiry: Date.now() + 50,
        }),
      );
      await new Promise((r) => setTimeout(r, 120));
      await flushImmediates();
      await Promise.all(sends);

      // Assert: 期限切れの 3 つは send() が解決し、TSN 順の計上に必要な bookSize だけ残してペイロードを手放す
      const [a, ...expired] = [...sctp.outboundQueue];
      expect(expired).toHaveLength(3);
      for (const chunk of expired) {
        expect(chunk.abandoned).toBe(true);
        expect(chunk.userData.length).toBe(0);
        expect(chunk.bookSize).toBe(1024);
      }
      // Assert: 送信待ちの A のペイロードは保持される
      expect(a.abandoned).toBe(false);
      expect(a.userData.length).toBe(1024);
    } finally {
      await disposeMockSctp(sctp);
    }
  });

  test.each([
    [
      "the peer's ABORT",
      (internal: any) => internal.receiveChunk(new AbortChunk()),
    ],
    [
      "a closing timeout (setState CLOSED)",
      (internal: any) => internal.setState(SCTP_STATE.CLOSED),
    ],
  ])(
    "does not keep an expiry timer after %s and a later stop()",
    async (_, close) => {
      // Arrange: 相手の受信ウィンドウが 0 の association に寿命付きメッセージを積む
      const { sctp } = createZeroWindowMockSctp();
      const internal = sctp as any;
      void sctp.send(0, 51, Buffer.from("A"), { expiry: Date.now() + 60_000 });
      await flushImmediates();
      expect(internal.outboundExpiryHandle).toBeDefined();

      // Act: stop() 以外の経路で association が閉じ、その後 stop() を呼ぶ
      await close(internal);
      await disposeMockSctp(sctp);

      // Assert: 閉じた association に期限タイマーは残らない
      expect(sctp.associationState).toBe(SCTP_STATE.CLOSED);
      expect(internal.outboundExpiryHandle).toBeUndefined();
    },
  );

  test("does not keep an expiry timer once the queue is empty or stopped", async () => {
    // Arrange: 相手の受信ウィンドウが 0 の association に寿命付きメッセージを積む
    const { sctp } = createZeroWindowMockSctp();
    const internal = sctp as any;
    void sctp.send(0, 51, Buffer.from("A"), { expiry: Date.now() + 60_000 });
    await flushImmediates();
    expect(internal.outboundExpiryHandle).toBeDefined();

    // Act: association を止める
    await disposeMockSctp(sctp);

    // Assert: 期限タイマーは残らない
    expect(internal.outboundExpiryHandle).toBeUndefined();
  });
});

describe("PR-SCTP under seeded random loss of DATA / SACK / FORWARD-TSN", () => {
  // Fixed seeds keep failures replayable; seeds 6, 37, 38 and 78 reproduced
  // reassembly / flightSize bugs before they were fixed.
  const { seeds, seedSelected, replay } = propertySeeds("WERIFT_SCTP_LOSS", {
    seeds: 100,
  });
  const LOSS_RATE = 0.2;
  const STREAMS = 3;
  const SIZES = [16, 1_500, 4_000];
  /** How often the seeds exercised abandonment; a property that never abandons proves nothing about lifetimes. */
  const coverage = { abandonedMessages: 0, forwardTsns: 0 };

  test.each(seeds.map((seed) => [seed, replay(seed)] as const))(
    `keeps delivery, lifetimes and flightSize consistent (seed %i, replay: %s)`,
    async (seed, _replay) => {
      // Arrange: シード付き乱数で両方向のパケットを落とすペアと、複数ストリーム・断片化・寿命有無を混ぜたメッセージ
      const pair = await createLossyPrSctpPair();
      try {
        const random = createSeededRandom(seed);
        pair.recorder.dropIf = () => random() < LOSS_RATE;
        pair.serverRecorder.dropIf = () => random() < LOSS_RATE;
        const messages = Array.from({ length: 12 }, (_, id) => {
          const data = Buffer.alloc(
            SIZES[Math.floor(random() * SIZES.length)],
            id,
          );
          data.writeUInt32BE(id, 0);
          return {
            id,
            streamId: Math.floor(random() * STREAMS),
            ordered: random() < 0.8,
            lifetime:
              random() < 0.5 ? 50 + Math.floor(random() * 2_000) : undefined,
            data,
            expiry: undefined as number | undefined,
            resolvedAt: undefined as number | undefined,
          };
        });
        const delivered: { streamId: number; data: Buffer }[] = [];
        pair.server.onReceive.subscribe((streamId, _ppId, data) => {
          delivered.push({ streamId, data });
        });
        const violations: string[] = [];
        const check = () => {
          const v = findFlightSizeViolation(pair.client);
          if (v) violations.push(v);
        };

        // Act: 損失ありで送信と時間経過を乱数で織り交ぜる
        for (const m of messages) {
          m.expiry =
            m.lifetime === undefined ? undefined : Date.now() + m.lifetime;
          void pair.client
            .send(m.streamId, 53, m.data, {
              ordered: m.ordered,
              expiry: m.expiry,
            })
            .then(() => {
              m.resolvedAt = Date.now();
            });
          await flushImmediates(3);
          check();
          await vi.advanceTimersByTimeAsync(Math.floor(random() * 800));
          await flushImmediates(3);
          check();
        }
        // Act: 損失を止め、送信側の全キューと FORWARD-TSN が片付くまで時間を進める
        pair.recorder.dropIf = undefined;
        pair.serverRecorder.dropIf = undefined;
        const client = pair.client as any;
        for (
          let i = 0;
          i < 60 &&
          (client.outboundQueue.length > 0 ||
            client.sentQueue.length > 0 ||
            client.forwardTsnChunk);
          i++
        ) {
          await vi.advanceTimersByTimeAsync(3_100);
          await flushImmediates();
          check();
        }

        // Assert: 送信側が停止せず全て片付き、flightSize の勘定が常に一致している
        expect(violations).toEqual([]);
        expect(messages.filter((m) => m.resolvedAt === undefined)).toEqual([]);
        expect(client.outboundQueue.length).toBe(0);
        expect(client.sentQueue.length).toBe(0);
        expect(client.forwardTsnChunk).toBeUndefined();
        expect(client.flightSize).toBe(0);
        // Assert: 寿命付きメッセージの send() は、ほかのイベントを待たずに遅くとも寿命の時刻までに解決する
        const lateSends = messages
          .filter((m) => m.expiry !== undefined && m.resolvedAt! > m.expiry)
          .map((m) => ({
            id: m.id,
            expiry: m.expiry,
            resolvedAt: m.resolvedAt,
          }));
        expect(lateSends).toEqual([]);
        // Assert: 受信側に取り残された断片がなく、受信ウィンドウが初期値に戻る
        const server = pair.server as any;
        for (const stream of Object.values(server.inboundStreams) as any[]) {
          expect(stream.reassembly).toEqual([]);
        }
        expect(server.advertisedRwnd).toBe(1024 * 1024);
        // Assert: 二重配送も内容破損もなく、寿命なしのメッセージは必ず届く
        const ids = delivered.map((d) => d.data.readUInt32BE(0));
        expect(new Set(ids).size).toBe(ids.length);
        for (const d of delivered) {
          const m = messages[d.data.readUInt32BE(0)];
          expect(d.streamId).toBe(m.streamId);
          expect(d.data.equals(m.data)).toBe(true);
        }
        for (const m of messages.filter((m) => m.lifetime === undefined)) {
          expect(ids).toContain(m.id);
        }
        // Assert: 各ストリームの順序付きメッセージは送信順に届く
        for (let streamId = 0; streamId < STREAMS; streamId++) {
          const orderedIds = ids.filter((id) => {
            const m = messages[id];
            return m.streamId === streamId && m.ordered;
          });
          expect(orderedIds).toEqual([...orderedIds].sort((a, b) => a - b));
        }
        coverage.abandonedMessages += messages.filter(
          (m) => !ids.includes(m.id),
        ).length;
        coverage.forwardTsns += recordedForwardTsns(pair.recorder).length;
      } finally {
        await pair.stop();
      }
    },
  );

  test.skipIf(seedSelected)(
    "the seeds above exercise lifetime abandonment and FORWARD-TSN",
    () => {
      // Assert: 寿命破棄の経路が一度も通らない (寿命が効かない) と、上のプロパティは空振りでも成功してしまう
      expect(coverage.abandonedMessages).toBeGreaterThan(0);
      expect(coverage.forwardTsns).toBeGreaterThan(0);
    },
  );
});
