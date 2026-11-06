import { afterEach, describe, expect, test, vi } from "vitest";

import { DataChunk, ForwardTsnChunk } from "../src/chunk";
import { createLossyPrSctpPair, flushImmediates } from "./utils";

// T3-rtx の初期値 (SCTP_RTO_INITIAL = 3s) を確実に超える時間
const PAST_T3_MS = 3_100;

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
    const abandoned = pair.recorder.sentChunks.find(
      (c): c is DataChunk => c instanceof DataChunk,
    )!;
    await vi.advanceTimersByTimeAsync(PAST_T3_MS);
    await flushImmediates();

    // Assert: FORWARD-TSN が破棄チャンクの TSN を累積 TSN として送られ、送信キューから外れる
    const forwardTsn = pair.recorder.sentChunks.find(
      (c): c is ForwardTsnChunk => c instanceof ForwardTsnChunk,
    );
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
    await vi.advanceTimersByTimeAsync(PAST_T3_MS);
    await flushImmediates();

    // Assert: 同じ TSN の DATA が再送され、FORWARD-TSN は送られず、チャンクは破棄されていない
    const dataTsns = pair.recorder.sentChunks
      .filter((c): c is DataChunk => c instanceof DataChunk)
      .map((c) => c.tsn);
    expect(dataTsns.length).toBe(2);
    expect(dataTsns[1]).toBe(dataTsns[0]);
    expect(
      pair.recorder.sentChunks.some((c) => c instanceof ForwardTsnChunk),
    ).toBe(false);
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
    await vi.advanceTimersByTimeAsync(PAST_T3_MS);
    await flushImmediates();

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
    expect(
      pair.recorder.sentChunks.some((c) => c instanceof ForwardTsnChunk),
    ).toBe(false);
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
    await vi.advanceTimersByTimeAsync(PAST_T3_MS);
    await flushImmediates();
    await sending;

    // Assert: 一部の断片が未送信だったことを前提に、未送信断片も含めて全て破棄され送信キューが空になる
    expect(queuedBefore).toBeGreaterThan(0);
    expect(client.outboundQueue.length).toBe(0);
    expect(client.sentQueue.length).toBe(0);
    // Assert: FORWARD-TSN がメッセージ最終断片の TSN まで累積 TSN を進める
    const forwardTsn = pair.recorder.sentChunks.find(
      (c): c is ForwardTsnChunk => c instanceof ForwardTsnChunk,
    );
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
    const abandoned = pair.recorder.sentChunks.find(
      (c): c is DataChunk => c instanceof DataChunk,
    )!;
    await vi.advanceTimersByTimeAsync(PAST_T3_MS);
    await flushImmediates();
    // Assert: 1 回目の FORWARD-TSN は失われ、受信側の累積 TSN はまだ進んでいない
    expect((pair.server as any).lastReceivedTsn).not.toBe(abandoned.tsn);
    await vi.advanceTimersByTimeAsync(PAST_T3_MS);
    await flushImmediates();

    // Assert: FORWARD-TSN が再送され、受信側が進み、送信側の保持も解除される
    const forwardCount = pair.recorder.sentChunks.filter(
      (c) => c instanceof ForwardTsnChunk,
    ).length;
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
    await vi.advanceTimersByTimeAsync(PAST_T3_MS);
    await flushImmediates();

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
});
