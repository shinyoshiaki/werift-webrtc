import { describe, expect, test } from "vitest";

import { SctpSendResult, WEBRTC_PPID } from "../src";
import { DataChunk } from "../src/chunk";
import {
  createConnectedSctpPair,
  createMockSctp,
  createZeroWindowMockSctp,
  disposeMockSctp,
  flushImmediates,
  holdTransport,
  outboundQueueOf,
  sentChunks,
  settle,
} from "./utils";

describe("SCTP.send() resolves with SctpSendResult", () => {
  test("sent: the message's last chunk was handed to the network", async () => {
    // Arrange: 確立済みの association
    const pair = await createConnectedSctpPair();
    try {
      // Act: 複数断片になるメッセージを送る
      const result = await pair.client.send(
        0,
        WEBRTC_PPID.BINARY,
        Buffer.alloc(5_000, 1),
      );

      // Assert: ネットワークに渡った時点で sent で解決する
      expect(result).toBe(SctpSendResult.sent);
    } finally {
      await pair.stop();
    }
  });

  test("a send() resolves when its own message is handed over, not when a later message's transport send completes", async () => {
    // Arrange: 確立済みの association で 1 件目を送り、2 件目以降の transport.send を保留させる
    const { sctp, transport } = createMockSctp({ established: true });
    const settled: string[] = [];
    const first = sctp.send(0, WEBRTC_PPID.BINARY, Buffer.from("A"));
    void first.then((result) => settled.push(`A:${result}`));
    const hold = holdTransport(transport);
    try {
      // Act: 2 件目を送り、保留中の transport.send を残したまま処理を進める
      const second = sctp.send(0, WEBRTC_PPID.BINARY, Buffer.from("B"));
      void second.then((result) => settled.push(`B:${result}`));
      await settle();

      // Assert: 2 件目の transport.send が保留中でも、両方の send() が sent で解決している
      expect(transport.send).toHaveBeenCalledTimes(2);
      expect([...settled].sort()).toEqual(["A:sent", "B:sent"]);
    } finally {
      hold.release();
      await disposeMockSctp(sctp);
    }
  });

  test("TSNs are assigned synchronously, before send() first awaits", async () => {
    // Arrange: 相手の受信ウィンドウが 0 で DATA を送れない association
    const { sctp } = createZeroWindowMockSctp();
    const internals = sctp as unknown as {
      localTsn: number;
      maxPayloadSize: number;
    };
    const tsnBefore = internals.localTsn;

    // Act: 3 断片になるメッセージを await せずに送る
    const sending = sctp.send(
      0,
      WEBRTC_PPID.BINARY,
      Buffer.alloc(internals.maxPayloadSize * 3, 1),
    );

    // Assert: send() から戻った時点で全断片が TSN 付きでキューにある
    expect(outboundQueueOf(sctp).length).toBe(3);
    expect(internals.localTsn).toBe((tsnBefore + 3) % 0x100000000);
    await disposeMockSctp(sctp);
    await sending;
  });

  test("an empty message creates no chunk, resolves sent and keeps the stream sequence number", async () => {
    // Arrange: 確立済みの association
    const pair = await createConnectedSctpPair();
    try {
      const received: Buffer[] = [];
      pair.server.onReceive.subscribe((_id, _ppId, data) =>
        received.push(data),
      );

      // Act: 空メッセージ、続けて通常のメッセージを同じストリームに順序付きで送る
      const empty = await pair.client.send(
        0,
        WEBRTC_PPID.BINARY,
        Buffer.alloc(0),
      );
      const next = await pair.client.send(
        0,
        WEBRTC_PPID.BINARY,
        Buffer.from("x"),
      );
      await flushImmediates();

      // Assert: 空メッセージはチャンクを作らず sent で解決し、SSN を消費しないので後続が届く
      expect(empty).toBe(SctpSendResult.sent);
      expect(next).toBe(SctpSendResult.sent);
      expect(received.map((d) => d.toString())).toEqual(["x"]);
    } finally {
      await pair.stop();
    }
  });

  test("abandoned: a message that expired before it was handed to the network", async () => {
    // Arrange: 相手の受信ウィンドウが 0 で DATA を送れない association
    const { sctp, transport } = createZeroWindowMockSctp();
    try {
      // Act: 寿命 50ms のメッセージを積み、寿命を過ぎるまで待つ
      const sending = sctp.send(0, WEBRTC_PPID.BINARY, Buffer.from("A"), {
        expiry: Date.now() + 50,
      });
      await new Promise((r) => setTimeout(r, 120));
      await flushImmediates();

      // Assert: 一度も送られずに破棄され、abandoned で解決する
      expect(await sending).toBe(SctpSendResult.abandoned);
      expect(sentChunks(transport).some((c) => c instanceof DataChunk)).toBe(
        false,
      );
    } finally {
      await disposeMockSctp(sctp);
    }
  });

  test("discarded: the association closed before the message was handed to the network", async () => {
    // Arrange: 相手の受信ウィンドウが 0 で、メッセージが送信キューに残る association
    const { sctp } = createZeroWindowMockSctp();
    const sending = sctp.send(0, WEBRTC_PPID.BINARY, Buffer.from("A"));
    await flushImmediates();
    expect(outboundQueueOf(sctp).length).toBe(1);

    // Act: 送信前に association を停止する
    await disposeMockSctp(sctp);

    // Assert: 送られなかったメッセージは discarded で解決する
    expect(await sending).toBe(SctpSendResult.discarded);
  });

  test("discarded: a send() on a stopped association", async () => {
    // Arrange: 停止済みの association
    const { sctp } = createZeroWindowMockSctp();
    await disposeMockSctp(sctp);
    const queueBefore = outboundQueueOf(sctp).length;
    const internals = sctp as unknown as {
      localTsn: number;
      outboundStreamSeq: Record<number, number>;
    };
    const tsnBefore = internals.localTsn;
    const seqBefore = { ...internals.outboundStreamSeq };

    // Act: 停止後に送る
    const result = await sctp.send(0, WEBRTC_PPID.BINARY, Buffer.from("A"));

    // Assert: discarded で解決し、キュー・TSN・ストリームシーケンスは変化しない
    expect(result).toBe(SctpSendResult.discarded);
    expect(outboundQueueOf(sctp).length).toBe(queueBefore);
    expect(internals.localTsn).toBe(tsnBefore);
    expect({ ...internals.outboundStreamSeq }).toEqual(seqBefore);
  });

  test("discarded: an empty send() on a stopped association", async () => {
    // Arrange: 停止済みの association
    const { sctp } = createZeroWindowMockSctp();
    await disposeMockSctp(sctp);
    const queueBefore = outboundQueueOf(sctp).length;

    // Act: 停止後に空メッセージを送る
    const result = await sctp.send(0, WEBRTC_PPID.BINARY, Buffer.alloc(0));

    // Assert: 空でも sent ではなく discarded で解決し、キューは変化しない
    expect(result).toBe(SctpSendResult.discarded);
    expect(outboundQueueOf(sctp).length).toBe(queueBefore);
  });
});
