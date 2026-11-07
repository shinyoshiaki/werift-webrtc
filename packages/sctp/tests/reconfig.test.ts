import { DEFAULT_SCTP_MTU, maxPayloadSizeForMtu, SCTP_STATE } from "../src";
import { reconfigResult } from "../src/param";
import {
  createConnectedSctpPair,
  createDataChunk,
  createEstablishedMockSctp,
  createForwardTsnChunk,
  createReconfigResponseChunk,
  createResetRequestChunk,
  dropDataPacketsAt,
  recordSctpEvents,
} from "./utils";

describe("incoming stream reset (RFC 6525 deferred reset)", () => {
  const mocks: ReturnType<typeof createEstablishedMockSctp>[] = [];
  const setup = (options?: Parameters<typeof createEstablishedMockSctp>[0]) => {
    const mock = createEstablishedMockSctp(options);
    mocks.push(mock);
    return mock;
  };
  afterEach(async () => {
    await Promise.all(mocks.splice(0).map((m) => m.sctp.stop()));
  });

  test("最後のフラグメントより先に reset が届くと保留し、メッセージ配信後に reset する", async () => {
    // Arrange
    const { inject, events, responses, resetRequests, internal } = setup();
    internal.outboundStreamSeq[1] = 1;
    await inject(
      createDataChunk({ tsn: 101, data: "a", fragment: "first" }),
      createDataChunk({ tsn: 102, data: "b", fragment: "middle" }),
    );

    // Act: 欠けている TSN 103 を lastTsn に持つ reset request を受け取る
    await inject(
      createResetRequestChunk({
        requestSequence: 1001,
        lastTsn: 103,
        streams: [1],
      }),
    );

    // Assert: In progress を返し、reset もメッセージ配信もまだ起きない
    expect(responses().map((r) => r.result)).toEqual([
      reconfigResult.InProgress,
    ]);
    expect(events).toEqual([]);
    expect(resetRequests()).toEqual([]);

    // Act: 欠けていた最後のフラグメントが再送で届く
    await inject(createDataChunk({ tsn: 103, data: "c", fragment: "last" }));

    // Assert: 保留解除時に Success - Performed が自発的に送られる
    expect(responses().map((r) => r.result)).toEqual([
      reconfigResult.InProgress,
      reconfigResult.ReconfigResultSuccessPerformed,
    ]);

    // Assert: 完全なメッセージが配信されてから reset が発火し、逆方向の reset も送られる
    expect(events).toEqual([
      { type: "message", streamId: 1, data: "abc" },
      { type: "reset", streamIds: [1] },
    ]);
    expect(resetRequests().map((r) => r.streams)).toEqual([[1]]);
    expect(internal.inboundStreams[1]).toBeUndefined();
  });

  test("lastTsn までの DATA が揃っていればすぐに reset する", async () => {
    // Arrange
    const { inject, events, responses } = setup();
    await inject(createDataChunk({ tsn: 101, data: "a" }));

    // Act: 受信済みの TSN を lastTsn に持つ reset request を受け取る
    await inject(
      createResetRequestChunk({
        requestSequence: 1001,
        lastTsn: 101,
        streams: [1],
      }),
    );

    // Assert: Success - Performed を返し、すぐに reset が発火する
    expect(responses().map((r) => r.result)).toEqual([
      reconfigResult.ReconfigResultSuccessPerformed,
    ]);
    expect(events).toEqual([
      { type: "message", streamId: 1, data: "a" },
      { type: "reset", streamIds: [1] },
    ]);
  });

  test("1 つの request に複数 stream が含まれていても境界到達時にまとめて reset する", async () => {
    // Arrange
    const { inject, events, responses } = setup();
    await inject(
      createDataChunk({ tsn: 101, streamId: 1, data: "s1" }),
      createDataChunk({ tsn: 103, streamId: 2, data: "s2-b", fragment: "last" }),
    );

    // Act: stream 2 の TSN 102 が欠けたまま 2 stream の reset request を受け取る
    await inject(
      createResetRequestChunk({
        requestSequence: 1001,
        lastTsn: 103,
        streams: [1, 2],
      }),
    );

    // Assert: 保留され、stream 1 の配信済みメッセージだけが見える
    expect(responses().map((r) => r.result)).toEqual([
      reconfigResult.InProgress,
    ]);
    expect(events).toEqual([{ type: "message", streamId: 1, data: "s1" }]);

    // Act: 欠けていた stream 2 のフラグメントが届く
    await inject(
      createDataChunk({
        tsn: 102,
        streamId: 2,
        data: "s2-a/",
        fragment: "first",
      }),
    );

    // Assert: stream 2 のメッセージ配信後に両 stream が 1 回で reset される
    expect(events).toEqual([
      { type: "message", streamId: 1, data: "s1" },
      { type: "message", streamId: 2, data: "s2-a/s2-b" },
      { type: "reset", streamIds: [1, 2] },
    ]);
  });

  test("TSN が 0xffffffff をまたいでも境界を正しく判定する", async () => {
    // Arrange
    const { inject, events, responses } = setup({
      lastReceivedTsn: 0xfffffffd,
    });
    await inject(
      createDataChunk({ tsn: 0xfffffffe, data: "a", fragment: "first" }),
      createDataChunk({ tsn: 0, data: "c", fragment: "last" }),
    );

    // Act: wrap 後の TSN 0 を lastTsn に持つ reset request を受け取る
    await inject(
      createResetRequestChunk({
        requestSequence: 1001,
        lastTsn: 0,
        streams: [1],
      }),
    );

    // Assert: 0xffffffff が欠けているので保留する
    expect(responses().map((r) => r.result)).toEqual([
      reconfigResult.InProgress,
    ]);
    expect(events).toEqual([]);

    // Act: 欠けていた 0xffffffff が届く
    await inject(
      createDataChunk({ tsn: 0xffffffff, data: "b", fragment: "middle" }),
    );

    // Assert: wrap をまたいだメッセージが配信されてから reset される
    expect(events).toEqual([
      { type: "message", streamId: 1, data: "abc" },
      { type: "reset", streamIds: [1] },
    ]);
  });

  test("FORWARD-TSN で境界を越えたときも保留中の reset を実行する", async () => {
    // Arrange
    const { inject, events, responses, internal } = setup();
    await inject(createDataChunk({ tsn: 101, ssn: 0, data: "kept" }));
    await inject(
      createResetRequestChunk({
        requestSequence: 1001,
        lastTsn: 102,
        streams: [1],
      }),
    );

    // Act: 相手が TSN 102 (SSN 1) を破棄し FORWARD-TSN を送ってくる
    await inject(createForwardTsnChunk(102, [[1, 1]]));

    // Assert: 保留が解消されて reset が発火し、Success - Performed が送られる
    expect(responses().map((r) => r.result)).toEqual([
      reconfigResult.InProgress,
      reconfigResult.ReconfigResultSuccessPerformed,
    ]);
    expect(events).toEqual([
      { type: "message", streamId: 1, data: "kept" },
      { type: "reset", streamIds: [1] },
    ]);
    expect(internal.deferredReset).toBeUndefined();
  });

  test("保留中に届いた lastTsn より後の DATA は reset 後の stream として扱う", async () => {
    // Arrange
    const { inject, events } = setup();
    await inject(createDataChunk({ tsn: 101, ssn: 0, data: "old-0" }));
    await inject(
      createResetRequestChunk({
        requestSequence: 1001,
        lastTsn: 102,
        streams: [1],
      }),
    );

    // Act: reset 後の stream の最初のメッセージ (SSN 0) が先に届く
    await inject(createDataChunk({ tsn: 103, ssn: 0, data: "new-0" }));

    // Assert: 新しい stream のメッセージは配信されない
    expect(events).toEqual([{ type: "message", streamId: 1, data: "old-0" }]);

    // Act: 境界までの最後のメッセージ (SSN 1) が届く
    await inject(createDataChunk({ tsn: 102, ssn: 1, data: "old-1" }));

    // Assert: 古い stream の配信、reset、新しい stream (SSN 0) の配信の順になる
    expect(events).toEqual([
      { type: "message", streamId: 1, data: "old-0" },
      { type: "message", streamId: 1, data: "old-1" },
      { type: "reset", streamIds: [1] },
      { type: "message", streamId: 1, data: "new-0" },
    ]);
  });

  test("同じ seq の再送は保留中なら In progress、実行後なら Success - Performed を返し状態は二重に変わらない", async () => {
    // Arrange
    const { inject, events, responses, resetRequests, internal } = setup();
    internal.outboundStreamSeq[1] = 1;
    const request = () =>
      createResetRequestChunk({
        requestSequence: 1001,
        lastTsn: 101,
        streams: [1],
      });
    await inject(request());

    // Act: 保留中に同じ request が再送される
    await inject(request());

    // Assert: どちらも In progress で、reset はまだ起きない
    expect(responses().map((r) => r.result)).toEqual([
      reconfigResult.InProgress,
      reconfigResult.InProgress,
    ]);
    expect(events).toEqual([]);

    // Act: 境界の DATA が届いたあと、同じ request がさらに再送される
    await inject(createDataChunk({ tsn: 101, data: "a" }));
    await inject(request());
    await inject(request());

    // Assert: 保留解除時と実行後の再送は Success - Performed で、reset と逆方向の reset は 1 回だけ
    expect(responses().map((r) => r.result)).toEqual([
      reconfigResult.InProgress,
      reconfigResult.InProgress,
      reconfigResult.ReconfigResultSuccessPerformed,
      reconfigResult.ReconfigResultSuccessPerformed,
      reconfigResult.ReconfigResultSuccessPerformed,
    ]);
    expect(events).toEqual([
      { type: "message", streamId: 1, data: "a" },
      { type: "reset", streamIds: [1] },
    ]);
    expect(resetRequests()).toHaveLength(1);
    expect(internal.reconfigResponseSeq).toBe(1001);
  });

  test("不正な seq には Bad Sequence Number を返し何もしない", async () => {
    // Arrange
    const { inject, events, responses, internal } = setup();

    // Act: 期待値 1001 ではない seq の request を受け取る
    await inject(
      createResetRequestChunk({
        requestSequence: 1005,
        lastTsn: 100,
        streams: [1],
      }),
    );

    // Assert: Bad Sequence Number を返し、reset も保留もしない
    expect(responses().map((r) => r.result)).toEqual([
      reconfigResult.BadSequenceNumber,
    ]);
    expect(events).toEqual([]);
    expect(internal.deferredReset).toBeUndefined();
    expect(internal.reconfigResponseSeq).toBe(1000);

    // Act: 保留中に別の seq の request を受け取る
    await inject(
      createResetRequestChunk({
        requestSequence: 1001,
        lastTsn: 101,
        streams: [1],
      }),
    );
    await inject(
      createResetRequestChunk({
        requestSequence: 1002,
        lastTsn: 101,
        streams: [2],
      }),
    );

    // Assert: 保留中の request はそのままで、別の seq には Bad Sequence Number を返す
    expect(responses().map((r) => r.result)).toEqual([
      reconfigResult.BadSequenceNumber,
      reconfigResult.InProgress,
      reconfigResult.BadSequenceNumber,
    ]);
    expect(internal.deferredReset.request.requestSequence).toBe(1001);
  });

  test("FORWARD-TSN は保留中の lastTsn より後の受信済み DATA を破棄しない", async () => {
    // Arrange: 境界 TSN 102 が欠けたまま、reset 後の stream の DATA 103 を保留する
    const { inject, events, responses } = setup();
    await inject(
      createResetRequestChunk({
        requestSequence: 1001,
        lastTsn: 102,
        streams: [1],
      }),
    );
    await inject(createDataChunk({ tsn: 103, ssn: 0, data: "new-0" }));

    // Act: 相手が TSN 102 を破棄する FORWARD-TSN を送ってくる
    await inject(createForwardTsnChunk(102));

    // Assert: reset が実行され、受信済みの DATA 103 は新しい stream で配信される
    expect(responses().map((r) => r.result)).toEqual([
      reconfigResult.InProgress,
      reconfigResult.ReconfigResultSuccessPerformed,
    ]);
    expect(events).toEqual([
      { type: "reset", streamIds: [1] },
      { type: "message", streamId: 1, data: "new-0" },
    ]);
  });

  test("stream list が空の request は全 stream を reset し、保留中の全 stream の新 DATA も退避する", async () => {
    // Arrange: stream 1 と 2 にメッセージがあり、境界 TSN 103 が欠けている
    const { inject, events, responses } = setup();
    await inject(
      createDataChunk({ tsn: 101, streamId: 1, data: "s1" }),
      createDataChunk({ tsn: 102, streamId: 2, data: "s2" }),
    );
    await inject(
      createResetRequestChunk({ requestSequence: 1001, lastTsn: 103, streams: [] }),
    );

    // Act: reset 後の stream 3 の DATA と、境界の DATA が届く
    await inject(createDataChunk({ tsn: 104, streamId: 3, data: "new-3" }));
    await inject(createDataChunk({ tsn: 103, streamId: 1, ssn: 1, data: "s1b" }));

    // Assert: 既存の全 stream が reset され、stream 3 の新 DATA は reset 後に配信される
    expect(responses().map((r) => r.result)).toEqual([
      reconfigResult.InProgress,
      reconfigResult.ReconfigResultSuccessPerformed,
    ]);
    expect(events).toEqual([
      { type: "message", streamId: 1, data: "s1" },
      { type: "message", streamId: 2, data: "s2" },
      { type: "message", streamId: 1, data: "s1b" },
      { type: "reset", streamIds: [1, 2] },
      { type: "message", streamId: 3, data: "new-3" },
    ]);
  });

  test("stop で保留状態と退避した DATA を破棄する", async () => {
    // Arrange
    const { sctp, inject, internal } = setup();
    await inject(
      createResetRequestChunk({
        requestSequence: 1001,
        lastTsn: 101,
        streams: [1],
      }),
    );
    await inject(createDataChunk({ tsn: 102, data: "new" }));

    // Act: association を止める
    await sctp.stop();

    // Assert: 保留状態が残らない
    expect(internal.deferredReset).toBeUndefined();
  });
});

describe("outgoing stream reset answered with In progress", () => {
  test("In progress は失敗扱いにせず request を残して再送を続ける", async () => {
    // Arrange
    const { sctp, inject, internal, resetRequests } =
      createEstablishedMockSctp();
    internal.outboundStreamSeq[1] = 1;
    sctp.reconfigQueue.push(1);
    await sctp.transmitReconfigRequest();
    const request = sctp.reconfigRequest!;
    internal.timerReconfigFailures = 5;

    // Act: 相手が In progress を返す
    await inject(
      createReconfigResponseChunk(
        request.requestSequence,
        reconfigResult.InProgress,
      ),
    );

    // Assert: request は残り、失敗回数はリセットされ、association は閉じない
    expect(sctp.reconfigRequest).toBe(request);
    expect(internal.timerReconfigFailures).toBe(0);
    expect(internal.timerReconfigHandle).toBeDefined();
    expect(sctp.associationState).toBe(SCTP_STATE.ESTABLISHED);

    // Act: 再送した request に Success - Performed が返る
    await inject(
      createReconfigResponseChunk(
        request.requestSequence,
        reconfigResult.ReconfigResultSuccessPerformed,
      ),
    );

    // Assert: reset が完了する
    expect(sctp.reconfigRequest).toBeUndefined();
    expect(resetRequests()).toHaveLength(1);

    await sctp.stop();
  });

  test("In progress を受けた後のタイマー満了は失敗回数を加算せず、association を閉じない", async () => {
    // Arrange
    const { sctp, inject, internal, resetRequests } =
      createEstablishedMockSctp();
    internal.outboundStreamSeq[1] = 1;
    sctp.reconfigQueue.push(1);
    await sctp.transmitReconfigRequest();
    const request = sctp.reconfigRequest!;
    await inject(
      createReconfigResponseChunk(
        request.requestSequence,
        reconfigResult.InProgress,
      ),
    );
    internal.timerReconfigFailures = 0;

    // Act: 応答がないままタイマーが何度も満了する
    for (let i = 0; i < 20; i++) {
      await internal.timerReconfigHandleExpired();
    }

    // Assert: 失敗回数は加算されず、association は閉じず、request は再送され続ける
    expect(internal.timerReconfigFailures).toBe(0);
    expect(sctp.associationState).toBe(SCTP_STATE.ESTABLISHED);
    expect(resetRequests()).toHaveLength(21);

    await sctp.stop();
  });
});

describe("incoming reset request acknowledging our outstanding request", () => {
  test("responseSequence が自分の request と一致すればタイマーを止めるが、成功応答までは完了にしない", async () => {
    // Arrange: 自分の reset request が未応答のまま残っている
    const { sctp, inject, internal } = createEstablishedMockSctp();
    internal.outboundStreamSeq[1] = 1;
    sctp.reconfigQueue.push(1);
    await sctp.transmitReconfigRequest();
    const request = sctp.reconfigRequest!;
    expect(internal.timerReconfigHandle).toBeDefined();

    // Act: 相手が自分の request を受信済みとして responseSequence に載せた request を送る
    await inject(
      createResetRequestChunk({
        requestSequence: 1001,
        lastTsn: 100,
        streams: [2],
        responseSequence: request.requestSequence,
      }),
    );

    // Assert: 再構成タイマーは止まるが、request と stream の状態は維持される
    expect(internal.timerReconfigHandle).toBeUndefined();
    expect(sctp.reconfigRequest).toBe(request);
    expect(internal.outboundStreamSeq[1]).toBe(1);

    // Act: 相手から成功応答が届く
    await inject(
      createReconfigResponseChunk(
        request.requestSequence,
        reconfigResult.ReconfigResultSuccessPerformed,
      ),
    );

    // Assert: ここで reset が完了する
    expect(sctp.reconfigRequest).toBeUndefined();
    expect(internal.outboundStreamSeq[1]).toBeUndefined();

    await sctp.stop();
  });
});

describe("stream reset overtaking a retransmitted DATA chunk", () => {
  test(
    "最後のフラグメントが落ちても 64 KiB のメッセージが届いてから両方向の reset が完了する",
    async () => {
      // Arrange
      const size = 64 * 1024;
      const fragments = Math.ceil(
        size / maxPayloadSizeForMtu(DEFAULT_SCTP_MTU),
      );
      // client の DATA パケット 0 は "hello"、1..fragments が 64 KiB のメッセージ
      const pair = await createConnectedSctpPair({
        dropClient: dropDataPacketsAt([fragments]),
      });
      const serverEvents = recordSctpEvents(pair.server);
      const clientEvents = recordSctpEvents(pair.client);
      try {
        await pair.client.send(1, 51, Buffer.from("hello"));
        await pair.server.send(1, 51, Buffer.from("hi"));
        const message = Buffer.alloc(size, 7);

        // Act: 最後のフラグメントが落ちた直後に client が stream 1 を reset する
        await pair.client.send(1, 53, message);
        pair.client.reconfigQueue.push(1);
        await pair.client.transmitReconfigRequest();

        // Assert: T3 再送後にメッセージが届き、その後で両方向の reset が完了する
        await vi.waitFor(
          () => {
            expect(pair.client.reconfigRequest).toBeUndefined();
            expect(pair.server.reconfigRequest).toBeUndefined();
            expect(
              serverEvents.filter((e) => e.type === "reset"),
            ).not.toHaveLength(0);
          },
          { timeout: 20_000, interval: 50 },
        );
        expect(pair.transports.client.droppedPackets).toBe(1);
        // 両端とも stream 1 で送信済みなので reset は複数回届きうるが、すべてメッセージの後
        const serverLog = serverEvents.map((e) =>
          e.type === "message" ? `message:${e.data.length}` : "reset",
        );
        expect(serverLog.slice(0, 3)).toEqual([
          "message:5",
          `message:${size}`,
          "reset",
        ]);
        expect(serverLog.slice(3).every((e) => e === "reset")).toBe(true);
        expect(clientEvents.some((e) => e.type === "reset")).toBe(true);
        expect(pair.client.associationState).toBe(SCTP_STATE.ESTABLISHED);
        expect(pair.server.associationState).toBe(SCTP_STATE.ESTABLISHED);
      } finally {
        await pair.stop();
      }
    },
    30_000,
  );
});
