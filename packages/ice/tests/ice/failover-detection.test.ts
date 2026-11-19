import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Message } from "../../src";
import {
  DEFAULT_FAILOVER_THRESHOLDS,
  resolveFailoverThresholds,
} from "../../src/failover";
import { classes, methods } from "../../src/stun/const";
import { StunProtocol } from "../../src/stun/protocol";
import {
  createStunOverTurnClient,
  type StunOverTurnProtocol,
} from "../../src/turn/protocol";
import {
  createFailoverHarness,
  createFailoverRealPair,
  createStreamTurnServer,
  createTurnSuccessResponse,
  expectDataFlows,
  FAILOVER_HIGH,
  FAILOVER_LOW,
  keepSending,
  selectSamePath,
} from "../utils";

/**
 * §15 of ticket 6b2d7627: the selected pair fails over sooner than the
 * unwritable rule (5 unanswered checks and 5 s) allows.
 * A: a selected pair that stopped receiving moves to a backup that receives
 * (libwebrtc `receiving` + `receiving_switching_delay`).
 * B: a path the OS or the TURN client reports gone fails over at once.
 * C: the thresholds are options (`IceOptions.failover`).
 */

type Internals = {
  failover: { knownUnwritable(pair: unknown): boolean };
};
const knownUnwritable = (h: { connection: unknown }, pair: unknown) =>
  (h.connection as Internals).failover.knownUnwritable(pair);

describe("§15 A: a selected pair that stopped receiving", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("an idle selected pair whose checks are answered never fails over, however long nothing else arrives", async () => {
    const h = await createFailoverHarness();
    const relay = h.pairOf(1);

    try {
      // Act: 相手がデータを送らないまま (check の応答だけが届く)、2 分進める。
      await vi.advanceTimersByTimeAsync(120_000);

      // Assert: 選択は host のまま、relay へ指名を送らず、状態も変わらない。
      expect(h.connection.nominated).toBe(h.selection);
      expect(
        h
          .requestsTo(relay)
          .some((request) => request.useCandidate || request.nomination),
      ).toBe(false);
      expect(h.states).toEqual([]);
    } finally {
      await h.connection.close();
    }
  });

  test("a path that breaks right after the selection is checked once nothing arrived for 2.5 s, not after the first consent interval (5 s), and fails over within 4.5 s", async () => {
    const h = await createFailoverHarness();
    const host = h.selection;
    const relay = h.pairOf(1);

    try {
      // Act: 選択 (consent の開始) の直後に host を切り、退避するまで進める。
      const cutAt = Date.now();
      h.cut(0);
      await h.advanceUntil(() => h.connection.nominated === relay, 10_000);

      // Assert: 最初の consent check は無受信 2.5 s の時点で送られ、遮断から 4.5 s 以内に relay へ移る。
      const first = h.requestsTo(host).find((request) => request.at > cutAt);
      expect(first!.at - cutAt).toBeLessThanOrEqual(2500);
      expect(h.connection.nominated).toBe(relay);
      expect(Date.now() - cutAt).toBeLessThanOrEqual(4500);
    } finally {
      await h.connection.close();
    }
  });

  test("a loss burst shorter than 2.5 s + 1 s does not move the selection", async () => {
    const h = await createFailoverHarness();
    const relay = h.pairOf(1);
    await vi.advanceTimersByTimeAsync(10_000);

    try {
      // Act: host の応答直後に host を 3 s だけ切って戻し、30 s 進める。
      const cutAt = await h.cutRightAfterAnswer(0);
      await vi.advanceTimersByTimeAsync(cutAt + 3000 - Date.now());
      h.restore(0);
      await vi.advanceTimersByTimeAsync(30_000);

      // Assert: 選択は host のまま、relay へ指名を送らない。
      expect(h.connection.nominated).toBe(h.selection);
      expect(
        h
          .requestsTo(relay)
          .some((request) => request.useCandidate || request.nomination),
      ).toBe(false);
    } finally {
      await h.connection.close();
    }
  });

  test("a slow selected pair (RTT 3 s) whose checks are all answered is not switched, although nothing arrives for longer than 3.5 s", async () => {
    // 選択後に経路の RTT が 3 s になる (測定済みの RTT も 3 s、応答待ちは RTT から 6.2 s)。
    const h = await createFailoverHarness();
    const relay = h.pairOf(1);
    h.protocols[0].responseDelayMs = 3000;
    h.selection.rtt = 3;

    try {
      // Act: 相手がデータを送らないまま 60 s 進める (応答と応答の間は 3.5 s を超える)。
      await vi.advanceTimersByTimeAsync(60_000);

      // Assert: check は期限内にすべて応答されるので受信途絶とはみなさず、host のまま。
      expect(h.connection.nominated).toBe(h.selection);
      expect(relay.nominated).toBe(false);
      expect(h.states).toEqual([]);
    } finally {
      await h.connection.close();
    }
  });

  test("a backup that does not receive either (weak) is not taken early: the agent waits for the unwritable rule", async () => {
    const h = await createFailoverHarness();
    const relay = h.pairOf(1);
    await vi.advanceTimersByTimeAsync(10_000);

    try {
      // Act: host の応答直後に host と relay の両方を切り、5 s 進める (受信途絶の 3.5 s は過ぎ、書き込み不可の 5 回にはまだ届かない)。
      const cutAt = await h.cutRightAfterAnswer(0);
      h.cut(1);
      await vi.advanceTimersByTimeAsync(cutAt + 5000 - Date.now());

      // Assert: host は受信途絶だが書き込み不可ではなく、relay も受信していないので、指名を送らず host のまま。
      expect(knownUnwritable(h, h.selection)).toBe(false);
      expect(
        h
          .requestsTo(relay)
          .some(
            (request) =>
              request.at >= cutAt &&
              (request.useCandidate || request.nomination !== undefined),
          ),
      ).toBe(false);
      expect(h.connection.nominated).toBe(h.selection);
    } finally {
      await h.connection.close();
    }
  });

  test("controlled: the peer's USE-CANDIDATE (as strong as the selection, no data) moves the selection once the selected pair stopped receiving, before it is unwritable", async () => {
    const h = await createFailoverHarness({ iceControlling: false });
    const host = h.selection;
    const relay = h.pairOf(1);
    await vi.advanceTimersByTimeAsync(10_000);

    try {
      // Act: host の応答直後に host を切り、1 s 後に相手が relay を USE-CANDIDATE で指名する (まだ受信途絶ではない)。
      const cutAt = await h.cutRightAfterAnswer(0);
      await vi.advanceTimersByTimeAsync(cutAt + 1000 - Date.now());
      h.receiveNomination(relay);
      await vi.advanceTimersByTimeAsync(0);

      // Assert: host がまだ受信しているうちは、データのない同じ強さの指名には従わない (従来どおり)。
      expect(h.connection.nominated).toBe(host);

      // Act: 遮断から 4.5 s (受信途絶の 3.5 s と未応答の check の後) まで進め、相手がもう一度 relay を指名する。
      await vi.advanceTimersByTimeAsync(cutAt + 4500 - Date.now());
      expect(knownUnwritable(h, host)).toBe(false);
      h.receiveNomination(relay);
      await vi.advanceTimersByTimeAsync(0);

      // Assert: 書き込み不可を待たずに relay へ移り、connected のまま。
      expect(h.connection.nominated).toBe(relay);
      expect(h.connection.state).toBe("connected");
    } finally {
      await h.connection.close();
    }
  });
});

describe("§15 B: a path reported gone fails over at once", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test.each([
    { mode: "semi-aggressive", renomination: false },
    { mode: "renomination", renomination: true },
  ])(
    "($mode) the selected socket reports its path gone (ENETUNREACH): the agent nominates the writable backup at once, without waiting for checks",
    async ({ renomination }) => {
      const h = await createFailoverHarness({ renomination });
      const relay = h.pairOf(1);
      await vi.advanceTimersByTimeAsync(10_000);

      try {
        // Act: host のソケットが経路の消失を報告する。
        const sentBefore = h.requestsTo(h.selection).length;
        h.breakPath(0);
        const took = await h.advanceUntil(
          () => h.connection.nominated === relay,
          5000,
        );

        // Assert: host への check の未応答を待たずに (100 ms 以内に) relay へ移り、disconnected にならない。
        expect(h.connection.nominated).toBe(relay);
        expect(took).toBeLessThanOrEqual(100);
        expect(
          h
            .requestsTo(h.selection)
            .slice(sentBefore)
            .filter((request) => request.done && !request.answered),
        ).toEqual([]);
        expect(h.states.map(({ state }) => state)).not.toContain(
          "disconnected",
        );
      } finally {
        await h.connection.close();
      }
    },
  );

  test("without a writable backup the agent is disconnected at once, and connected again once the path answers", async () => {
    const h = await createFailoverHarness({
      locals: [
        { type: "stun", candidateType: "host", priority: FAILOVER_HIGH },
      ],
    });
    await vi.advanceTimersByTimeAsync(10_000);

    try {
      // Act: 唯一のソケットが経路の消失を報告する。
      h.breakPath(0);
      await vi.advanceTimersByTimeAsync(0);

      // Assert: ただちに disconnected (退避先がない)。
      expect(h.connection.state).toBe("disconnected");

      // Act: 経路が戻り、次の check (900 ms 間隔) が応答されるまで進める。
      h.restore(0);
      const took = await h.advanceUntil(
        () => h.connection.state === "connected",
        5000,
      );

      // Assert: 1 s 以内に connected へ戻る。
      expect(h.connection.state).toBe("connected");
      expect(took).toBeLessThanOrEqual(1000);
    } finally {
      await h.connection.close();
    }
  });

  test("the selected TURN allocation is lost: the agent moves to the host backup at once", async () => {
    const h = await createFailoverHarness({
      locals: [
        { type: "turn", candidateType: "relay", priority: FAILOVER_HIGH },
        { type: "stun", candidateType: "host", priority: FAILOVER_LOW },
      ],
    });
    const host = h.pairOf(1);
    await vi.advanceTimersByTimeAsync(10_000);

    try {
      // Act: 選択中の relay のソケットが TURN allocation の喪失 (宛先なし) を報告する。
      h.breakPath(0, undefined);
      const took = await h.advanceUntil(
        () => h.connection.nominated === host,
        5000,
      );

      // Assert: 100 ms 以内に host へ移る。
      expect(h.connection.nominated).toBe(host);
      expect(took).toBeLessThanOrEqual(100);
    } finally {
      await h.connection.close();
    }
  });

  test("a path gone to another remote address leaves the selection alone", async () => {
    const h = await createFailoverHarness({
      remotes: [FAILOVER_HIGH, FAILOVER_LOW],
    });
    await vi.advanceTimersByTimeAsync(10_000);

    try {
      // Act: 選択中のソケットが、別のリモートアドレスへの経路の消失だけを報告する。
      h.breakPath(0, 1);
      await vi.advanceTimersByTimeAsync(3000);

      // Assert: 選択は変わらず、書き込み不可にもならない。
      expect(h.connection.nominated).toBe(h.selection);
      expect(knownUnwritable(h, h.selection)).toBe(false);
      expect(h.states).toEqual([]);
    } finally {
      await h.connection.close();
    }
  });

  test("regular nomination (out of scope, F7): a path reported gone changes nothing", async () => {
    const h = await createFailoverHarness({ nomination: "regular" });
    const relay = h.pairOf(1);
    await vi.advanceTimersByTimeAsync(10_000);

    try {
      // Act: 選択中のソケットが経路の消失を報告する (経路は切らない)。
      h.breakPath(0, undefined, { cut: false });
      await vi.advanceTimersByTimeAsync(3000);

      // Assert: 退避も状態の変化もない。
      expect(h.connection.nominated).toBe(h.selection);
      expect(relay.nominated).toBe(false);
      expect(h.states).toEqual([]);
    } finally {
      await h.connection.close();
    }
  });
});

describe("§15 B: the protocols report a path gone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("UDP: a routing error of a STUN message or a sampled data send is reported once per send; other errors and unsampled sends are not, and none rejects", async () => {
    // Arrange: 実 UDP ソケットの StunProtocol の送信が、OS のエラーで失敗するようにする。
    const protocol = new StunProtocol();
    await protocol.connectionMade(true);
    const reports: [unknown, string][] = [];
    protocol.onPathBroken.subscribe((addr, error) =>
      reports.push([addr, (error as NodeJS.ErrnoException).code ?? ""]),
    );
    let code = "ENETUNREACH";
    vi.spyOn(protocol.transport, "send").mockImplementation(
      async (_data, _addr, options) => {
        if (!options?.confirm) return;
        throw Object.assign(new Error(`send ${code}`), { code });
      },
    );
    const peer: [string, number] = ["192.0.2.10", 5000];
    const message = new Message(methods.BINDING, classes.REQUEST);

    try {
      // Act: STUN を送り、データを続けて 2 回 (2 回目は確認の間隔内) 送る。
      await protocol.sendStun(message, peer);
      await protocol.sendData(Buffer.from("a"), peer);
      await protocol.sendData(Buffer.from("b"), peer);

      // Assert: STUN と最初のデータの 2 回だけ、宛先つきで報告される。
      expect(reports).toEqual([
        [peer, "ENETUNREACH"],
        [peer, "ENETUNREACH"],
      ]);

      // Act: 経路の消失ではないエラー (EINVAL) で STUN を送る。
      code = "EINVAL";
      await protocol.sendStun(message, peer);

      // Assert: 報告されない。
      expect(reports).toHaveLength(2);
    } finally {
      await protocol.close();
    }
  });

  test("TURN over TCP: the server closing the connection reports every path of the allocation gone; close() does not", async () => {
    // Arrange: TCP の TURN サーバーに allocation を 2 つ作る。
    const server = await createStreamTurnServer();
    const config = {
      address: ["127.0.0.1", server.port] as [string, number],
      username: "user",
      password: "pass",
    };
    const lost = await createStunOverTurnClient(config, { transport: "tcp" });
    const closed = await createStunOverTurnClient(config, {
      transport: "tcp",
    });
    const lostReports: unknown[] = [];
    const closedReports: unknown[] = [];
    lost.onPathBroken.subscribe((addr) => lostReports.push(addr));
    closed.onPathBroken.subscribe((addr) => closedReports.push(addr));

    try {
      // Act: 1 つは自分で閉じ、サーバーが残りの接続を切る。
      await closed.close();
      await server.close();

      // Assert: サーバーに切られた側だけが、宛先なし (すべての経路) で 1 回報告する。
      await vi.waitFor(() => expect(lostReports).toEqual([undefined]));
      expect(closedReports).toEqual([]);
    } finally {
      await lost.close();
    }
  });

  test("TURN: a Refresh answered with 437 (Allocation Mismatch) reports the allocation lost", async () => {
    // Arrange: 寿命 1 s の allocation を返し、Refresh には 437 を返す TCP の TURN サーバー。
    const server = await createStreamTurnServer({
      reply: (request) => {
        if (request.messageMethod === methods.REFRESH) {
          return new Message(
            methods.REFRESH,
            classes.ERROR,
            request.transactionId,
          ).setAttribute("ERROR-CODE", [437, "Allocation Mismatch"]);
        }
        const response = createTurnSuccessResponse(request);
        if (request.messageMethod === methods.ALLOCATE) {
          response.setAttribute("LIFETIME", 1);
        }
        return response;
      },
    });
    const turn: StunOverTurnProtocol = await createStunOverTurnClient(
      {
        address: ["127.0.0.1", server.port],
        username: "user",
        password: "pass",
      },
      { transport: "tcp" },
    );
    const reports: unknown[] = [];
    turn.onPathBroken.subscribe((addr) => reports.push(addr));

    try {
      // Act / Assert: 寿命の 5/6 (約 0.8 s) で送る Refresh が 437 で失敗し、宛先なしで 1 回報告される。
      await vi.waitFor(() => expect(reports).toEqual([undefined]), {
        timeout: 3000,
      });
    } finally {
      await turn.close();
      await server.close();
    }
  });
});

describe("§15 C: thresholds (IceOptions.failover)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("unset or invalid values keep libwebrtc's defaults; valid ones apply", () => {
    // Act / Assert: 未指定は既定値 (5 回・5000・2500・1000 ms)。
    expect(resolveFailoverThresholds(undefined)).toEqual({
      unwritableMinChecks: 5,
      unwritableTimeout: 5000,
      receivingTimeout: 2500,
      receivingSwitchingDelay: 1000,
    });
    expect(resolveFailoverThresholds({})).toEqual(DEFAULT_FAILOVER_THRESHOLDS);

    // Act / Assert: 範囲内の値はそのまま使う (0 も可の項目は 0 を受け付ける)。
    expect(
      resolveFailoverThresholds({
        unwritableMinChecks: 2,
        unwritableTimeout: 0,
        receivingTimeout: 1000,
        receivingSwitchingDelay: 0,
      }),
    ).toEqual({
      unwritableMinChecks: 2,
      unwritableTimeout: 0,
      receivingTimeout: 1000,
      receivingSwitchingDelay: 0,
    });

    // Act / Assert: 不正な値 (負・非有限・小数の回数・0 の受信時間) は既定値に戻る。
    expect(
      resolveFailoverThresholds({
        unwritableMinChecks: 1.5,
        unwritableTimeout: -1,
        receivingTimeout: 0,
        receivingSwitchingDelay: Number.NaN,
      }),
    ).toEqual(DEFAULT_FAILOVER_THRESHOLDS);
  });

  test("shorter receiving thresholds fail a dead path over sooner", async () => {
    const h = await createFailoverHarness({
      failover: { receivingTimeout: 1000, receivingSwitchingDelay: 0 },
    });
    const relay = h.pairOf(1);
    await vi.advanceTimersByTimeAsync(10_000);

    try {
      // Act: host の応答直後に host を切り、退避するまで進める。
      const cutAt = await h.cutRightAfterAnswer(0);
      await h.advanceUntil(() => h.connection.nominated === relay, 10_000);

      // Assert: 既定値 (2.5 s + 1 s 以上) よりずっと早く、遮断から 2 s 以内に relay へ移る。
      expect(h.connection.nominated).toBe(relay);
      expect(Date.now() - cutAt).toBeLessThanOrEqual(2000);
    } finally {
      await h.connection.close();
    }
  });

  test("fewer unwritable checks fail a one-way break over after that many unanswered checks", async () => {
    const h = await createFailoverHarness({
      failover: { unwritableMinChecks: 2, unwritableTimeout: 1000 },
    });
    const host = h.selection;
    const relay = h.pairOf(1);
    await vi.advanceTimersByTimeAsync(10_000);
    const stopReceiving = h.keepReceiving(host);

    try {
      // Act: 相手のデータは届いたまま host への送信だけを落とし、退避するまで進める。
      const cutAt = await h.cutRightAfterAnswer(0);
      await h.advanceUntil(() => h.connection.nominated === relay, 20_000);

      // Assert: 応答のない consent check 2 回で (既定の 5 回を待たずに) relay へ移る (3 回目は応答待ちのまま)。
      const missed = h
        .requestsTo(host)
        .filter((request) => request.at > cutAt && !request.answered);
      expect(h.connection.nominated).toBe(relay);
      expect(missed.length).toBeGreaterThanOrEqual(2);
      expect(missed.length).toBeLessThanOrEqual(3);
    } finally {
      stopReceiving();
      await h.connection.close();
    }
  });
});

describe("§15 over real sockets (werift ↔ werift)", () => {
  test.each([
    { mode: "semi-aggressive", renomination: false },
    { mode: "renomination", renomination: true },
  ])(
    "($mode) B: the route to the peer's host goes away while data flows: both agents move to the relay path within 1 s",
    async ({ renomination }) => {
      const { a, b, selectsHostPath, selectsRelayPath, loseHostRoute, close } =
        await createFailoverRealPair({ renomination });
      let stopSending = () => {};

      try {
        // Act: host ↔ host で接続し、a がデータを送り続ける (メディア相当)。
        await Promise.all([a.connect(), b.connect()]);
        await vi.waitFor(() => {
          expect(selectsHostPath(a)).toBe(true);
          expect(selectsHostPath(b)).toBe(true);
        });
        stopSending = keepSending(a);

        // Act: a の b の host への経路が消える (OS が ENETUNREACH を返す)。
        const lostAt = Date.now();
        loseHostRoute();

        // Assert: 1 s 以内に a が relay 経路へ移る (check の未応答を待たない)。
        await vi.waitFor(() => expect(selectsRelayPath(a)).toBe(true), {
          timeout: 1000,
          interval: 20,
        });
        expect(Date.now() - lostAt).toBeLessThanOrEqual(1000);

        // Assert: b も同じ relay 経路へ移り、データが双方向に届く。
        await vi.waitFor(() => expect(selectsRelayPath(b)).toBe(true), {
          timeout: 2000,
        });
        expect(selectSamePath(a, b)).toBe(true);
        await expectDataFlows(a, b, "a to b after the route loss");
        await expectDataFlows(b, a, "b to a after the route loss");
      } finally {
        stopSending();
        await close();
      }
    },
    20_000,
  );
});
