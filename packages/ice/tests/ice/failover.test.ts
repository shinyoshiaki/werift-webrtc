import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CandidatePairState } from "../../src";
import {
  createFailoverHarness,
  createFailoverRealPair,
  expectDataFlows,
  FAILOVER_HIGH,
  FAILOVER_LOW,
  FAILOVER_MID,
  selectSamePath,
} from "../utils";

/**
 * Failover of the selected pair without an ICE restart (libwebrtc
 * compatible): one backup per local socket, the writability rules of
 * libwebrtc (5 unanswered checks and 5 s) and the move to a writable backup.
 */
describe("failover of the selected pair", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Consent and backup intervals without jitter (5 s and 2.5 s).
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe.each([
    { mode: "semi-aggressive", renomination: false },
    { mode: "renomination", renomination: true },
  ])("controlling ($mode)", ({ renomination }) => {
    test("the selected pair stops answering: checked every 900 ms, unwritable after 5 checks and 5 s, the agent moves to the writable backup", async () => {
      const h = await createFailoverHarness({ renomination });
      const host = h.selection;
      const relay = h.pairOf(1);
      // 退避先 (relay) が安定するまで進める。
      await vi.advanceTimersByTimeAsync(10_000);
      expect(relay.state).toBe(CandidatePairState.SUCCEEDED);

      try {
        // Act: 選択中の host の経路を切り、退避するまで進める。
        h.cut(0);
        const cutAt = Date.now();
        const sentBefore = h.requestsTo(host).length;
        const took = await h.advanceUntil(
          () => h.connection.nominated === relay,
          20_000,
        );

        // Assert: 経路が切れてから 5〜10 s (+応答待ち) で relay へ移る。
        expect(h.connection.nominated).toBe(relay);
        expect(took).toBeGreaterThanOrEqual(5000);
        expect(took).toBeLessThanOrEqual(11_000);
        // Assert: 応答がなくなった後の consent check は 1 s 以下の間隔で、少なくとも 5 回送られた。
        const missed = h
          .requestsTo(host)
          .slice(sentBefore)
          .filter((request) => request.at >= cutAt);
        expect(missed.length).toBeGreaterThanOrEqual(5);
        const gaps = missed.slice(1).map((r, i) => r.at - missed[i].at);
        for (const gap of gaps) expect(gap).toBeLessThanOrEqual(1000);
        // Assert: 移る時の指名は USE-CANDIDATE (semi-aggressive) / 大きい NOMINATION (renomination)。
        const nomination = h
          .requestsTo(relay)
          .find((request) => request.useCandidate || request.nomination);
        if (renomination) {
          expect(nomination?.nomination).toBeGreaterThan(host.nomination);
          expect(relay.nomination).toBe(nomination?.nomination);
        } else {
          expect(nomination?.useCandidate).toBe(true);
        }
        // Assert: 書き込み可能な退避先があったので disconnected にならず、統計の nominated も新しいペアを指す。
        expect(h.states.map(({ state }) => state)).not.toContain(
          "disconnected",
        );
        expect(h.connection.state).toBe("connected");
        expect(relay.nominated).toBe(true);
        expect(host.nominated).toBe(false);
      } finally {
        await h.connection.close();
      }
    });

    test("after the failover the old pair moves the selection back only once it answered 3 times in a row", async () => {
      const h = await createFailoverHarness({ renomination });
      const host = h.selection;
      const relay = h.pairOf(1);
      await vi.advanceTimersByTimeAsync(10_000);
      h.cut(0);
      await h.advanceUntil(() => h.connection.nominated === relay, 20_000);
      expect(h.connection.nominated).toBe(relay);

      try {
        // Act: host の経路を戻し、host への check が 2 回応答されるまで進める。
        h.restore(0);
        const restoredAt = Date.now();
        const answered = () =>
          h
            .requestsTo(host)
            .filter(
              (request) =>
                request.at >= restoredAt &&
                !request.useCandidate &&
                request.nomination === undefined,
            ).length;
        await h.advanceUntil(() => answered() >= 2, 20_000);
        // Act: 他の check の結果などで選択の再評価が走る。
        h.evaluateSelection();
        await vi.advanceTimersByTimeAsync(0);

        // Assert: 2 回の応答では (再評価があっても) 戻らない。
        expect(answered()).toBe(2);
        expect(h.connection.nominated).toBe(relay);

        // Act: 3 回目の応答まで進める。
        await h.advanceUntil(() => h.connection.nominated === host, 20_000);

        // Assert: 3 回連続で応答したので上位の host へ指名し直して戻る。
        expect(answered()).toBe(3);
        expect(h.connection.nominated).toBe(host);
        expect(host.nominated).toBe(true);
      } finally {
        await h.connection.close();
      }
    });
  });

  test("one backup per local socket: its checks are 900 ms apart until it answered 3 times, then 2.5 s; a backup that never answers is replaced by the next pair of its socket", async () => {
    const h = await createFailoverHarness({
      locals: [
        { type: "stun", candidateType: "host", priority: FAILOVER_HIGH },
        { type: "stun", candidateType: "host", priority: FAILOVER_MID },
        { type: "turn", candidateType: "relay", priority: FAILOVER_LOW },
      ],
      remotes: [FAILOVER_HIGH, FAILOVER_LOW],
    });
    // relay ソケットの上位ペア (remote 0) への経路だけを切っておく。
    h.cut(2, 0);

    try {
      // Act: 12 s 進める。
      await vi.advanceTimersByTimeAsync(12_000);

      // Assert: 退避先は他のソケットごとに最上位の 1 ペアだけで、選択中のソケットの他のペアは check しない。
      expect(h.requestsTo(h.pairOf(1, 0)).length).toBeGreaterThan(0);
      expect(h.requestsTo(h.pairOf(1, 1))).toHaveLength(0);
      expect(h.requestsTo(h.pairOf(0, 1))).toHaveLength(0);
      expect(h.pairOf(0, 1).state).toBe(CandidatePairState.FAILED);
      // Assert: 退避先の check は 900 ms 間隔で 3 回応答された後、2.5 s 間隔になる。
      const times = h.requestsTo(h.pairOf(1, 0)).map(({ at }) => at);
      const gaps = times.slice(1).map((at, i) => at - times[i]);
      expect(gaps.slice(0, 3)).toEqual([900, 900, 2500]);
      // Assert: 応答しない relay の上位ペアは 5 回・5 s で Failed になり、同じソケットの次のペアが退避先になる。
      expect(h.pairOf(2, 0).state).toBe(CandidatePairState.FAILED);
      expect(h.requestsTo(h.pairOf(2, 0)).length).toBeGreaterThanOrEqual(5);
      expect(h.pairOf(2, 1).state).toBe(CandidatePairState.SUCCEEDED);
      // Assert: 退避先の check は指名を付けない。
      for (const request of h.requestsTo(h.pairOf(2, 1))) {
        expect(request.useCandidate).toBe(false);
        expect(request.nomination).toBeUndefined();
      }
      expect(h.connection.nominated).toBe(h.selection);
    } finally {
      await h.connection.close();
    }
  });

  describe("without a writable backup", () => {
    /** Arrange: one local socket only, so no backup exists. */
    const createSingleSocket = () =>
      createFailoverHarness({
        locals: [
          { type: "stun", candidateType: "host", priority: FAILOVER_HIGH },
        ],
      });

    test("the agent becomes disconnected once the selected pair is unwritable and failed when consent expires", async () => {
      const h = await createSingleSocket();
      await vi.advanceTimersByTimeAsync(1000);

      try {
        // Act: 経路を切り、disconnected になるまで進める。
        h.cut(0);
        const cutAt = Date.now();
        await h.advanceUntil(
          () => h.connection.state === "disconnected",
          20_000,
        );
        const disconnectedAt = Date.now();
        // Act: failed になるまで進める。
        await h.advanceUntil(() => h.connection.state === "failed", 40_000);

        // Assert: 5〜10 s (+応答待ち) で disconnected、最後の応答から 30 s で failed になる。
        expect(disconnectedAt - cutAt).toBeGreaterThanOrEqual(5000);
        expect(disconnectedAt - cutAt).toBeLessThanOrEqual(11_000);
        expect(h.connection.state).toBe("failed");
        expect(Date.now() - cutAt).toBeLessThanOrEqual(31_000);
        expect(h.states.map(({ state }) => state)).toEqual([
          "disconnected",
          "failed",
        ]);
      } finally {
        await h.connection.close();
      }
    });

    test("the agent becomes connected again when the selected pair answers again", async () => {
      const h = await createSingleSocket();
      await vi.advanceTimersByTimeAsync(1000);
      h.cut(0);
      await h.advanceUntil(() => h.connection.state === "disconnected", 20_000);
      expect(h.connection.state).toBe("disconnected");

      try {
        // Act: 経路を戻して 2 s 進める。
        h.restore(0);
        await vi.advanceTimersByTimeAsync(2000);

        // Assert: 900 ms 間隔の consent check が応答され、connected に戻る。
        expect(h.connection.state).toBe("connected");
        expect(h.states.map(({ state }) => state)).toEqual([
          "disconnected",
          "connected",
        ]);
        // Act: 相手が 1 s ごとにデータを送り続ける中で、さらに 40 s 進める。
        for (let i = 0; i < 40; i++) {
          h.receiveData(h.selection);
          await vi.advanceTimersByTimeAsync(1000);
        }
        // Assert: consent は失効せず、受信が続く間の間隔は consent の 5 s に戻っている。
        expect(h.connection.state).toBe("connected");
        const recent = h
          .requestsTo(h.selection)
          .filter(({ at }) => at > Date.now() - 20_000);
        expect(recent.length).toBeLessThanOrEqual(5);
      } finally {
        await h.connection.close();
      }
    });
  });

  test("controlled: backups are monitored and the state follows them, but the agent nominates nothing and follows the peer's nomination", async () => {
    const h = await createFailoverHarness({ iceControlling: false });
    const host = h.selection;
    const relay = h.pairOf(1);

    try {
      // Act: 10 s 進めてから host の経路を切り、15 s 進める。
      await vi.advanceTimersByTimeAsync(10_000);
      h.cut(0);
      await vi.advanceTimersByTimeAsync(15_000);

      // Assert: relay は監視され (ICE-CONTROLLED の check)、自分からは指名せず、選択も変えない。
      expect(relay.state).toBe(CandidatePairState.SUCCEEDED);
      const checks = h.requestsTo(relay);
      expect(checks.length).toBeGreaterThan(3);
      for (const request of checks) {
        expect(request.controlling).toBe(false);
        expect(request.useCandidate).toBe(false);
      }
      expect(h.connection.nominated).toBe(host);
      // Assert: 書き込み可能な退避先があるので disconnected にはならない。
      expect(h.connection.state).toBe("connected");

      // Act: 相手が relay を指名し、relay でデータを送る。
      h.receiveNomination(relay);
      h.receiveData(relay);
      await vi.advanceTimersByTimeAsync(0);

      // Assert: 相手に従って relay へ移る。
      expect(h.connection.nominated).toBe(relay);
    } finally {
      await h.connection.close();
    }
  });

  test.each([
    {
      scope: "regular nomination",
      options: { nomination: "regular" as const },
    },
    { scope: "an ICE-lite peer", options: { remoteIsLite: true } },
    {
      scope: "an ICE-TCP selection",
      options: {
        selectDirectly: true,
        locals: [
          {
            type: "tcp",
            candidateType: "host",
            priority: FAILOVER_HIGH,
            transport: "tcp" as const,
          },
          { type: "turn", candidateType: "relay", priority: FAILOVER_LOW },
        ],
        remotes: [FAILOVER_HIGH, FAILOVER_HIGH],
        remoteTransports: ["tcp" as const, "udp" as const],
      },
    },
  ])(
    "out of scope ($scope): no backup is checked and the agent fails when consent expires, as before",
    async ({ options }) => {
      const h = await createFailoverHarness(options);
      // ICE-TCP の場合、relay は 2 番目の (UDP の) リモート候補と組む。
      const backup = h.pairOf(1, h.connection.remoteCandidates.length - 1);
      const sentToBackup = h.requestsTo(backup).length;

      try {
        // Act: 選択中の経路を切り、40 s 進める。
        h.cut(0);
        const cutAt = Date.now();
        await h.advanceUntil(() => h.connection.state === "failed", 40_000);

        // Assert: 退避先の check は送らず、disconnected を経ずに 30 s で failed になる。
        expect(h.requestsTo(backup)).toHaveLength(sentToBackup);
        expect(h.connection.nominated).toBe(h.selection);
        expect(h.states.map(({ state }) => state)).toEqual(["failed"]);
        expect(Date.now() - cutAt).toBeGreaterThanOrEqual(25_000);
        expect(Date.now() - cutAt).toBeLessThanOrEqual(31_000);
      } finally {
        await h.connection.close();
      }
    },
  );

  describe("restart, close and a role change stop the monitoring", () => {
    /**
     * Arrange: the backup's path is cut, so a backup check is in flight
     * (waiting for its timeout) most of the time.
     */
    const createMonitoring = async () => {
      const h = await createFailoverHarness();
      h.cut(1);
      await vi.advanceTimersByTimeAsync(2000);
      await h.advanceUntil(() => h.protocols[1].pending() > 0, 2000);
      expect(h.protocols[1].pending()).toBe(1);
      return h;
    };

    test.each([
      { operation: "restart" as const },
      { operation: "close" as const },
    ])(
      "$operation: no check is left in flight and none is sent afterwards",
      async ({ operation }) => {
        const h = await createMonitoring();

        try {
          // Act: restart / close する。
          if (operation === "restart") await h.connection.restart();
          else await h.connection.close();
          await vi.advanceTimersByTimeAsync(0);
          const sent = h.requests().length;
          // Act: 60 s 進める。
          await vi.advanceTimersByTimeAsync(60_000);

          // Assert: 監視中の transaction は取り消され、その後は何も送らず、timer も残らない。
          expect(h.pending()).toBe(0);
          expect(h.requests().at(-1)?.cancelled).toBe(true);
          expect(h.requests()).toHaveLength(sent);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          await h.connection.close();
        }
      },
    );

    test("a role change cancels the checks sent under the old role; monitoring goes on under the new one", async () => {
      const h = await createMonitoring();
      const inFlight = h.protocols[1].requests.at(-1)!;

      try {
        // Act: ロール競合の修復で controlled に切り替わり、5 s 進める。
        h.switchRole(false);
        await vi.advanceTimersByTimeAsync(0);
        const switchedAt = Date.now();
        await vi.advanceTimersByTimeAsync(5000);

        // Assert: 旧ロールの check は取り消され、以後の退避先の check は ICE-CONTROLLED で送られる。
        expect(inFlight.cancelled).toBe(true);
        const after = h.protocols[1].requests.filter(
          ({ at }) => at >= switchedAt,
        );
        expect(after.length).toBeGreaterThan(0);
        for (const request of after) expect(request.controlling).toBe(false);
      } finally {
        await h.connection.close();
      }
    });
  });
});

describe("failover: review regressions (delay, late candidate, state, silence)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("a selected pair whose responses take longer than 900 ms is not cancelled while weak and is not failed over", async () => {
    // RTT 1.2 s (応答待ちは RTT から 2.6 s)。選択時の check で RTT を測る。
    const h = await createFailoverHarness({ responseDelayMs: 1200 });
    const host = h.selection;
    const relay = h.pairOf(1);
    await vi.advanceTimersByTimeAsync(10_000);

    try {
      // Act: 1 回だけ consent check を落として weak (900 ms 間隔) にし、すぐ経路を戻して 20 s 進める。
      const lostAfter = h.requestsTo(host).length;
      h.cut(0);
      await h.advanceUntil(() => h.requestsTo(host).length > lostAfter, 10_000);
      h.restore(0);
      await vi.advanceTimersByTimeAsync(20_000);

      // Assert: 応答の遅い consent check は次の check で取り消されず、経路を戻した後の check はすべて応答される。
      const restoredAt = h.requestsTo(host)[lostAfter].at;
      const after = h
        .requestsTo(host)
        .filter((request) => request.at > restoredAt && request.done);
      expect(after.length).toBeGreaterThan(3);
      for (const request of after) {
        expect(request.cancelled).toBe(false);
        expect(request.answered).toBe(true);
      }
      // Assert: 書き込み不可とは判断されず、退避も disconnected もしない。
      expect(h.connection.nominated).toBe(host);
      expect(relay.nominated).toBe(false);
      expect(h.states).toEqual([]);
    } finally {
      await h.connection.close();
    }
  });

  test.each([
    { mode: "semi-aggressive", renomination: false },
    { mode: "renomination", renomination: true },
  ])(
    "($mode) a selected pair with RTT 1.2 s that goes dead fails over within the D3 bound: checks keep the 900 ms pacing while earlier ones still wait for their response",
    async ({ renomination }) => {
      // RTT 1.2 s (応答待ちは RTT から 2.6 s)。
      const h = await createFailoverHarness({
        renomination,
        responseDelayMs: 1200,
      });
      const host = h.selection;
      const relay = h.pairOf(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(relay.state).toBe(CandidatePairState.SUCCEEDED);

      try {
        // Act: 直前の応答を受けた直後 (最悪の時点) に host の経路を切り、relay へ指名を送るまで進める。
        await h.advanceUntil(() => {
          const last = h.requestsTo(host).at(-1);
          return !!last?.answered;
        }, 10_000);
        h.cut(0);
        const cutAt = Date.now();
        const took = await h.advanceUntil(
          () =>
            h
              .requestsTo(relay)
              .some(
                (request) =>
                  request.at >= cutAt &&
                  (request.useCandidate || request.nomination !== undefined),
              ),
          30_000,
        );
        const decided = Date.now();
        // 退避を決めた時点の遮断後の check の様子 (退避後は新しい consent が古い要求を止める)。
        const atDecision = h
          .requestsTo(host)
          .filter((request) => request.at >= cutAt)
          .map(({ cancelled, answered }) => ({ cancelled, answered }));
        await h.advanceUntil(() => h.connection.nominated === relay, 5000);

        // Assert: 遮断から 10 s 以内に書き込み不可と判定して relay へ指名し、移る。
        expect(took).toBeLessThanOrEqual(10_000);
        expect(h.connection.nominated).toBe(relay);
        // Assert: 遮断後の check は前の応答待ちを取り消さず、900 ms 間隔で重ねて送られた。
        const sent = h
          .requestsTo(host)
          .filter((request) => request.at >= cutAt && request.at <= decided);
        expect(sent.length).toBeGreaterThanOrEqual(5);
        const gaps = sent.slice(1).map((r, i) => r.at - sent[i].at);
        for (const gap of gaps.slice(1)) expect(gap).toBeLessThanOrEqual(1000);
        expect(atDecision.length).toBeGreaterThanOrEqual(5);
        for (const request of atDecision) {
          expect(request).toEqual({ cancelled: false, answered: false });
        }
      } finally {
        await h.connection.close();
      }
    },
  );

  test.each([
    { mode: "semi-aggressive", renomination: false },
    { mode: "renomination", renomination: true },
  ])(
    "($mode) the old pair answers again while the failover nomination is in flight: the switch still demotes it, and the selection moves back only after 3 responses in a row",
    async ({ renomination }) => {
      const h = await createFailoverHarness({ renomination });
      const host = h.selection;
      const relay = h.pairOf(1);
      await vi.advanceTimersByTimeAsync(10_000);
      const relayProtocol = h.protocols[1];

      try {
        // Act: relay への指名の応答を止めたまま host を切り、退避の指名が出るまで進める。
        relayProtocol.holdNominations = true;
        h.cut(0);
        const cutAt = Date.now();
        await h.advanceUntil(
          () =>
            h
              .requestsTo(relay)
              .some(
                (request) =>
                  request.at >= cutAt &&
                  (request.useCandidate || request.nomination !== undefined),
              ),
          20_000,
        );
        // Act: 指名の応答前に host が回復し、consent check が応答される。
        h.restore(0);
        const restoredAt = Date.now();
        await h.advanceUntil(
          () =>
            h
              .requestsTo(host)
              .some((request) => request.at >= restoredAt && request.answered),
          10_000,
        );
        expect(h.connection.nominated).toBe(host);
        // Act: 指名の応答が届く。
        relayProtocol.releaseNominations();
        await vi.advanceTimersByTimeAsync(0);

        // Assert: 指名が成立したので relay に移り、host のソケットには 3 回応答の復帰ガードが掛かる。
        expect(h.connection.nominated).toBe(relay);
        expect(host.nominated).toBe(false);
        // Act: すぐに選択の再評価が走る。
        h.evaluateSelection();
        await vi.advanceTimersByTimeAsync(0);
        // Assert: host は応答していても 3 回連続の応答前には戻らない。
        expect(h.connection.nominated).toBe(relay);

        // Act: host へ戻るまで進める。
        const switchedAt = Date.now();
        await h.advanceUntil(() => h.connection.nominated === host, 20_000);

        // Assert: 切り替え後に host への監視 check が 3 回応答されてから戻る。
        const answered = h
          .requestsTo(host)
          .filter(
            (request) =>
              request.at >= switchedAt &&
              request.answered &&
              !request.useCandidate &&
              request.nomination === undefined,
          );
        expect(answered.length).toBeGreaterThanOrEqual(3);
        expect(h.connection.nominated).toBe(host);
      } finally {
        await h.connection.close();
      }
    },
  );

  test("a consent response that arrives after its RTT-based deadline (a busy event loop) still counts: no false unwritable", async () => {
    // RTT は選択時の check で約 0 (応答待ちの期限は 500 ms)。
    const h = await createFailoverHarness();
    const host = h.selection;
    const liveness = () =>
      (
        h.connection as unknown as {
          failover: {
            livenessOf(pair: unknown): {
              unanswered: number;
              responses: number;
            };
          };
        }
      ).failover.livenessOf(host)!;
    await vi.advanceTimersByTimeAsync(10_000);

    try {
      // Act: 以後の応答が 3 s 遅れる (期限 500 ms は過ぎるが、transaction の 5 s 以内) 状態で 30 s 進める。
      h.protocols[0].responseDelayMs = 3000;
      const responsesBefore = liveness().responses;
      await vi.advanceTimersByTimeAsync(30_000);

      // Assert: 遅れた応答も応答として数え、書き込み不可にも disconnected にもならず、退避もしない。
      expect(liveness().responses).toBeGreaterThan(responsesBefore + 3);
      expect(h.states).toEqual([]);
      expect(h.connection.nominated).toBe(host);
      for (const request of h.requestsTo(host)) {
        if (request.done)
          expect(request.cancelled || request.answered).toBe(true);
      }
    } finally {
      await h.connection.close();
    }
  });

  test("a role change cancels the selected pair's consent request in flight without counting it as unanswered; consent goes on under the new role", async () => {
    // 応答に 1.2 s かかるので、consent request が応答待ちの間にロールを変えられる。
    const h = await createFailoverHarness({ responseDelayMs: 1200 });
    const host = h.selection;
    const liveness = () =>
      (
        h.connection as unknown as {
          failover: { livenessOf(pair: unknown): { unanswered: number } };
        }
      ).failover.livenessOf(host)!;
    await vi.advanceTimersByTimeAsync(10_000);
    await h.advanceUntil(
      () => h.requestsTo(host).some((request) => !request.done),
      10_000,
    );
    const inFlight = h.requestsTo(host).find((request) => !request.done)!;
    expect(inFlight.controlling).toBe(true);

    try {
      // Act: consent request の応答待ちの間に、ロール競合の修復で controlled に切り替わる。
      h.switchRole(false);
      await vi.advanceTimersByTimeAsync(0);

      // Assert: 旧ロールの consent request は取り消され、未応答として数えられない。
      expect(inFlight.cancelled).toBe(true);
      expect(liveness().unanswered).toBe(0);

      // Act: 15 s 進める。
      const switchedAt = Date.now();
      await vi.advanceTimersByTimeAsync(15_000);

      // Assert: 以後の consent check は ICE-CONTROLLED で送られて応答され、書き込み不可にも disconnected にもならない。
      const after = h
        .requestsTo(host)
        .filter((request) => request.at >= switchedAt && request.done);
      expect(after.length).toBeGreaterThan(0);
      for (const request of after) {
        expect(request.controlling).toBe(false);
        expect(request.answered).toBe(true);
      }
      expect(liveness().unanswered).toBe(0);
      expect(h.connection.nominated).toBe(host);
      expect(h.states).toEqual([]);
    } finally {
      await h.connection.close();
    }
  });

  describe("controlled: the selected pair's consent expires while a backup is writable", () => {
    /** Arrange: controlled; the host path is cut and the relay backup keeps answering until consent expires. */
    const expireWithBackup = async () => {
      const h = await createFailoverHarness({ iceControlling: false });
      const relay = h.pairOf(1);
      await vi.advanceTimersByTimeAsync(10_000);
      h.cut(0);
      const cutAt = Date.now();
      await h.advanceUntil(() => h.connection.state !== "connected", 40_000);
      return { h, relay, cutAt };
    };

    test("the peer never nominates the backup: disconnected (nothing is sent) at the expiry, failed after the grace period, even if the old path comes back", async () => {
      const { h, relay, cutAt } = await expireWithBackup();
      const sendData = vi.spyOn(h.protocols[0], "sendData");
      const sendRelay = vi.spyOn(h.protocols[1], "sendData");

      try {
        // Assert: consent の失効 (最後の応答から 30 s) で disconnected になる (退避先は応答中)。
        expect(h.connection.state).toBe("disconnected");
        expect(Date.now() - cutAt).toBeGreaterThanOrEqual(25_000);
        expect(relay.state).toBe(CandidatePairState.SUCCEEDED);
        // Act: アプリケーションがデータを送る。
        await h.connection.send(Buffer.from("data"));
        // Assert: 失効した経路にも退避先にも送らない。
        expect(sendData).not.toHaveBeenCalled();
        expect(sendRelay).not.toHaveBeenCalled();

        // Act: 失効後に元の経路が戻り、相手の指名がないまま猶予期間 (10 s) を進める。
        h.restore(0);
        const expiredAt = Date.now();
        await h.advanceUntil(() => h.connection.state === "failed", 20_000);

        // Assert: 猶予期間の後に failed になり (ICE restart で復旧できる)、監視も止まる。
        expect(h.connection.state).toBe("failed");
        expect(Date.now() - expiredAt).toBeGreaterThanOrEqual(9_000);
        expect(Date.now() - expiredAt).toBeLessThanOrEqual(11_000);
        expect(h.states.map(({ state }) => state)).toEqual([
          "disconnected",
          "failed",
        ]);
        const sent = h.requests().length;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(h.requests()).toHaveLength(sent);
      } finally {
        await h.connection.close();
      }
    });

    test("the peer nominates the backup within the grace period: connected again and data flows on it", async () => {
      const { h, relay } = await expireWithBackup();
      expect(h.connection.state).toBe("disconnected");
      const sendRelay = vi.spyOn(h.protocols[1], "sendData");

      try {
        // Act: 猶予期間内に相手が relay を指名し、relay でデータを送る。
        await vi.advanceTimersByTimeAsync(3000);
        h.receiveNomination(relay);
        h.receiveData(relay);
        await vi.advanceTimersByTimeAsync(0);
        // Act: アプリケーションがデータを送り、猶予期間を過ぎるまで進める。
        await h.connection.send(Buffer.from("data"));
        await vi.advanceTimersByTimeAsync(20_000);

        // Assert: relay へ移って connected に戻り、データは relay で送られ、failed にはならない。
        expect(h.connection.nominated).toBe(relay);
        expect(h.connection.state).toBe("connected");
        expect(sendRelay).toHaveBeenCalled();
        expect(h.states.map(({ state }) => state)).toEqual([
          "disconnected",
          "connected",
        ]);
      } finally {
        await h.connection.close();
      }
    });
  });

  test("a remote candidate trickled later that outranks a socket's backup becomes its backup", async () => {
    // relay ソケットの最上位ペア (remote 0) の経路は切れており、下位の remote 1 のペアが退避先になる。
    const h = await createFailoverHarness({
      remotes: [FAILOVER_HIGH, FAILOVER_LOW],
    });
    // 切る前に検証済みなので、30 s 何も受けずに Failed になるまで待つ。
    h.cut(1, 0);
    await h.advanceUntil(
      () => h.pairOf(1, 1).state === CandidatePairState.SUCCEEDED,
      45_000,
    );
    expect(h.pairOf(1, 0).state).toBe(CandidatePairState.FAILED);

    try {
      // Act: 選択中のペアより低く、今の退避先より高いリモート候補が後から届き、10 s 進める。
      const mid = await h.addRemote(FAILOVER_MID);
      const lowChecks = h.requestsTo(h.pairOf(1, 1)).length;
      await vi.advanceTimersByTimeAsync(10_000);

      // Assert: 後着の上位ペアが relay ソケットの退避先になり、下位ペアの監視は止まる。
      expect(h.pairOf(1, mid).state).toBe(CandidatePairState.SUCCEEDED);
      expect(h.requestsTo(h.pairOf(1, mid)).length).toBeGreaterThan(3);
      expect(h.requestsTo(h.pairOf(1, 1)).length).toBeLessThanOrEqual(
        lowChecks + 1,
      );
      // Assert: 選択中のソケットには後着候補のペアを作らず、選択も変わらない。
      expect(h.pairOf(0, mid)).toBeUndefined();
      expect(h.connection.nominated).toBe(h.selection);
    } finally {
      await h.connection.close();
    }
  });

  test("controlled: a backup that answers again does not end disconnected; the switch to it does", async () => {
    const h = await createFailoverHarness({ iceControlling: false });
    const relay = h.pairOf(1);
    await vi.advanceTimersByTimeAsync(10_000);
    // host と relay の両方を切って disconnected にする。
    h.cut(0);
    h.cut(1);
    await h.advanceUntil(() => h.connection.state === "disconnected", 20_000);
    expect(h.connection.state).toBe("disconnected");

    try {
      // Act: relay の経路だけ戻し、relay の退避先が応答するまで進める。
      h.restore(1);
      await h.advanceUntil(
        () =>
          h.requestsTo(relay).some((request) => !request.cancelled) &&
          relay.state === CandidatePairState.SUCCEEDED &&
          h.connection.nominated === h.selection,
        40_000,
      );
      await vi.advanceTimersByTimeAsync(3000);

      // Assert: 退避先は応答しているが、選択はまだ切れた host のままなので disconnected のまま。
      expect(relay.state).toBe(CandidatePairState.SUCCEEDED);
      expect(h.connection.nominated).toBe(h.selection);
      expect(h.connection.state).toBe("disconnected");

      // Act: 相手が relay を指名し、relay でデータを送る。
      h.receiveNomination(relay);
      h.receiveData(relay);
      await vi.advanceTimersByTimeAsync(0);

      // Assert: relay へ移った時点で connected に戻る。
      expect(h.connection.nominated).toBe(relay);
      expect(h.connection.state).toBe("connected");
      expect(h.states.map(({ state }) => state)).toEqual([
        "disconnected",
        "connected",
      ]);
    } finally {
      await h.connection.close();
    }
  });

  test("weak by silence: the selected pair is checked once nothing was received for 2.5 s, not at the 5 s consent interval", async () => {
    const h = await createFailoverHarness();
    await vi.advanceTimersByTimeAsync(10_000);

    try {
      // Act: 相手からのデータが途絶えた状態で 20 s 進める。
      const from = Date.now();
      await vi.advanceTimersByTimeAsync(20_000);

      // Assert: 最後の受信から 2.5 s で次の check を送る (5 s の consent 間隔を待たない)。
      const times = h
        .requestsTo(h.selection)
        .filter(({ at }) => at >= from)
        .map(({ at }) => at);
      const gaps = times.slice(1).map((at, i) => at - times[i]);
      expect(gaps.length).toBeGreaterThan(5);
      for (const gap of gaps) expect(gap).toBe(2500);

      // Act: 相手が 0.5 s ごとにデータを送る中で 20 s 進める。
      const busyFrom = Date.now();
      for (let i = 0; i < 40; i++) {
        h.receiveData(h.selection);
        await vi.advanceTimersByTimeAsync(500);
      }

      // Assert: 受信が続く間は consent の 5 s 間隔に戻る。
      const busy = h
        .requestsTo(h.selection)
        .filter(({ at }) => at >= busyFrom + 5000)
        .map(({ at }) => at);
      const busyGaps = busy.slice(1).map((at, i) => at - busy[i]);
      for (const gap of busyGaps) expect(gap).toBe(5000);
    } finally {
      await h.connection.close();
    }
  });
});

describe("failover over real sockets (werift ↔ werift)", () => {
  test.each([
    { mode: "semi-aggressive", renomination: false },
    { mode: "renomination", renomination: true },
  ])(
    "($mode) the host path is cut after connecting: both agents move to the relay pair without an ICE restart and data flows",
    async ({ renomination }) => {
      const { a, b, selectsHostPath, selectsRelayPath, cutHostPath, close } =
        await createFailoverRealPair({ renomination });
      await Promise.all([a.connect(), b.connect()]);
      await vi.waitFor(
        () => {
          expect(selectsHostPath(a)).toBe(true);
          expect(selectsHostPath(b)).toBe(true);
        },
        { timeout: 5000 },
      );
      await expectDataFlows(a, b, "on the host path");
      const restarts = a.generation;

      try {
        // Act: host ↔ host の経路を両方向とも遮断する。
        cutHostPath();

        // Assert: controlling 側 (a) が relay の pair へ退避する。
        await vi.waitFor(() => expect(selectsRelayPath(a)).toBe(true), {
          timeout: 15_000,
          interval: 100,
        });
        // Act: a が relay の経路でデータを送る (controlled 側は指名とデータに従う)。
        await expectDataFlows(a, b, "a to b on the relay path");

        // Assert: b も同じ relay の経路に移り、両端の経路がそろい、データが双方向に届く。
        await vi.waitFor(() => expect(selectsRelayPath(b)).toBe(true), {
          timeout: 5000,
        });
        expect(selectSamePath(a, b)).toBe(true);
        await expectDataFlows(b, a, "b to a on the relay path");
        // Assert: ICE restart はしておらず、両端とも connected に戻る。
        expect(a.generation).toBe(restarts);
        await vi.waitFor(() => {
          expect(a.state).toBe("connected");
          expect(b.state).toBe("connected");
        });
      } finally {
        await close();
      }
    },
    30_000,
  );
});
