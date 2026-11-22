import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  CandidatePair,
  RECEIVING_SWITCHING_DELAY,
  RTT_SWITCH_MIN_IMPROVEMENT,
  WEAK_CONNECTION_RECEIVE_TIMEOUT,
} from "../../src";
import {
  notReceivingSince,
  type SwitchPairState,
  SelectionController,
  type SelectionControllerHost,
  shouldSwitch,
} from "../../src/nomination/selectionController";
import {
  createConsentCandidate,
  createRttSwitchHarness,
  createRttSwitchRealPair,
  FAILOVER_HIGH,
  FAILOVER_LOW,
} from "../utils";

/**
 * The controlling agent's choice of the selected pair after the first one
 * (libwebrtc's ICE controller): state (writable, receiving with
 * RECEIVING_SWITCHING_DELAY), then priority, then the smoothed RTT with
 * RTT_SWITCH_MIN_IMPROVEMENT.
 */
describe("shouldSwitch", () => {
  const now = 100_000;
  /** A writable pair that received something just now, with smoothed RTT `rtt` ms. */
  const up = (rtt?: number): SwitchPairState => ({
    writable: true,
    lastReceived: now,
    rtt: rtt === undefined ? undefined : rtt / 1000,
  });
  /** A writable pair silent for `silentMs` whose check went unanswered `missedMs` ago. */
  const silent = (silentMs: number, missedMs: number): SwitchPairState => ({
    writable: true,
    lastReceived: now - silentMs,
    missedSince: now - missedMs,
  });

  test("equal priority: moves only to a pair whose smoothed RTT is at least 10 ms lower", () => {
    // Act: RTT の差がちょうど 10 ms、9 ms、差なし、相手が遅い場合を判定する。
    const exactly = shouldSwitch({
      selected: up(40),
      candidate: up(40 - RTT_SWITCH_MIN_IMPROVEMENT),
      priority: 0,
      now,
    });
    const below = shouldSwitch({
      selected: up(40),
      candidate: up(31),
      priority: 0,
      now,
    });
    const same = shouldSwitch({
      selected: up(40),
      candidate: up(40),
      priority: 0,
      now,
    });
    const unknown = shouldSwitch({
      selected: up(undefined),
      candidate: up(1),
      priority: 0,
      now,
    });

    // Assert: 10 ms 以上良い場合だけ RTT を理由に移る。RTT が分からない間は移らない。
    expect(exactly.reason).toBe("rtt");
    expect(below.reason).toBeUndefined();
    expect(same.reason).toBeUndefined();
    expect(unknown.reason).toBeUndefined();
  });

  test("state comes before priority and priority before RTT", () => {
    // Act: 書き込み不可の候補、低い priority で速い候補、高い priority で遅い候補を判定する。
    const unwritable = shouldSwitch({
      selected: up(100),
      candidate: { ...up(1), writable: false },
      priority: 1,
      now,
    });
    const lowerFaster = shouldSwitch({
      selected: up(100),
      candidate: up(1),
      priority: -1,
      now,
    });
    const higherSlower = shouldSwitch({
      selected: up(1),
      candidate: up(100),
      priority: 1,
      now,
    });
    const selectionDown = shouldSwitch({
      selected: { ...up(1), writable: false },
      candidate: up(100),
      priority: -1,
      now,
    });

    // Assert: 書き込み可能かどうか → priority → RTT の順に決まる。
    expect(unwritable.reason).toBeUndefined();
    expect(lowerFaster.reason).toBeUndefined();
    expect(higherSlower.reason).toBe("priority");
    expect(selectionDown.reason).toBe("writable");
  });

  test("a pair that wins only by receiving waits RECEIVING_SWITCHING_DELAY and asks for a recheck", () => {
    // Arrange: 選択中のペアは 2.5 s 受信がなく、0.4 s 前の check が未応答。
    const selected = silent(WEAK_CONNECTION_RECEIVE_TIMEOUT + 400, 400);

    // Act: 保留中、保留時間の経過後、選択中のペアが受信を取り戻した後を判定する。
    const held = shouldSwitch({
      selected,
      candidate: up(),
      priority: -1,
      now,
    });
    const after = shouldSwitch({
      selected,
      candidate: up(),
      priority: -1,
      now: now + RECEIVING_SWITCHING_DELAY,
    });
    const recovered = shouldSwitch({
      selected: up(),
      candidate: up(),
      priority: -1,
      now: now + RECEIVING_SWITCHING_DELAY,
    });

    // Assert: 保留中は移らず、保留が明ける時刻に再判定を求める。明けたら移る。回復すれば移らない。
    expect(held.reason).toBeUndefined();
    expect(held.recheckAt).toBe(now - 400 + RECEIVING_SWITCHING_DELAY);
    expect(after.reason).toBe("receiving");
    expect(recovered.reason).toBeUndefined();
    expect(recovered.recheckAt).toBeUndefined();
  });

  test("silence alone (no unanswered check) is not 'not receiving'; a receiving selection beats a pair that is not", () => {
    // Act: 3 s 受信がないが check は未応答になっていないペア、未応答のペアを判定する。
    const quiet = notReceivingSince(
      { writable: true, lastReceived: now - 3000 },
      now,
    );
    const missed = notReceivingSince(
      {
        writable: true,
        lastReceived: now - 3000,
        missedSince: now - 2000,
      },
      now,
    );
    const candidateDown = shouldSwitch({
      selected: up(50),
      candidate: { ...silent(4000, 2000), rtt: 0.001 },
      priority: 1,
      now,
    });

    // Assert: 受信なしは「2.5 s の無受信」と「未応答の check」の両方が揃った時点から。
    expect(quiet).toBeUndefined();
    expect(missed).toBe(now - 3000 + WEAK_CONNECTION_RECEIVE_TIMEOUT);
    expect(candidateDown.reason).toBeUndefined();
  });

  test("a late unanswered check starts the hold at the check, and a recovery in the hold keeps the selection", () => {
    // Arrange: 選択中のペアは 10 s 無通信だが、check が未応答になったのはたった今。
    const selected: SwitchPairState = {
      writable: true,
      lastReceived: now - 10_000,
      missedSince: now,
    };

    // Act: 未応答の確定直後、保留の途中、保留が明けた時刻、保留中に受信した場合を判定する。
    const since = notReceivingSince(selected, now);
    const justAfter = shouldSwitch({
      selected,
      candidate: up(),
      priority: -1,
      now,
    });
    const halfway = shouldSwitch({
      selected,
      candidate: up(),
      priority: -1,
      now: now + RECEIVING_SWITCHING_DELAY / 2,
    });
    const expired = shouldSwitch({
      selected,
      candidate: up(),
      priority: -1,
      now: now + RECEIVING_SWITCHING_DELAY,
    });
    const recovered = shouldSwitch({
      selected: {
        ...selected,
        lastReceived: now + 500,
        missedSince: undefined,
      },
      candidate: up(),
      priority: -1,
      now: now + RECEIVING_SWITCHING_DELAY,
    });

    // Assert: 非受信は未応答の確定時刻から数え、その時点では移らず保留が明けて初めて移る。回復すれば移らない。
    expect(since).toBe(now);
    expect(justAfter.reason).toBeUndefined();
    expect(justAfter.recheckAt).toBe(now + RECEIVING_SWITCHING_DELAY);
    expect(halfway.reason).toBeUndefined();
    expect(expired.reason).toBe("receiving");
    expect(recovered.reason).toBeUndefined();
  });
});

describe("SelectionController: several backups compete", () => {
  const now = 100_000;
  type Spec = { name: string; priority: number; rtt: number; silent: boolean };
  const pairOf = (spec: Spec) =>
    ({
      name: spec.name,
      smoothedRtt: spec.rtt / 1000,
      toJSON: () => ({}),
    }) as unknown as CandidatePair;

  /** Arrange: 選択中 (受信停止・未応答 2 s) と、指定した退避先から成る controller。 */
  const arrange = (backups: Spec[], missedAgo = 2000) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const selected = pairOf({
      name: "selected",
      priority: 10,
      rtt: 50,
      silent: true,
    });
    const specs = new Map<CandidatePair, Spec>([
      [selected, { name: "selected", priority: 10, rtt: 50, silent: true }],
    ]);
    const pairs = backups.map((spec) => {
      const pair = pairOf(spec);
      specs.set(pair, spec);
      return pair;
    });
    const switched: string[] = [];
    const host: SelectionControllerHost = {
      active: () => true,
      selected: () => selected,
      candidates: () => pairs,
      liveness: (pair) =>
        specs.get(pair)!.silent
          ? ({
              lastReceived: now - 10_000,
              missedSince: now - missedAgo,
            } as never)
          : ({ lastReceived: now } as never),
      writable: () => true,
      allows: () => true,
      comparePriority: (pair, other) =>
        specs.get(pair)!.priority - specs.get(other)!.priority,
      switchTo: (pair) =>
        switched.push((pair as unknown as { name: string }).name),
    };
    return { controller: new SelectionController(host), switched };
  };
  afterEach(() => vi.useRealTimers());

  test("a receiving backup of lower priority wins over a silent one of equal priority and lower RTT", () => {
    // Arrange: 選択中と同 priority で RTT が低いが受信停止中の A と、priority は低いが受信中の B。
    const { controller, switched } = arrange([
      { name: "A", priority: 10, rtt: 5, silent: true },
      { name: "B", priority: 5, rtt: 40, silent: false },
    ]);

    // Act: 選択中の保留時間が明けた時点で判定する。
    vi.setSystemTime(now + RECEIVING_SWITCHING_DELAY);
    controller.evaluate();

    // Assert: 受信中の B へ移り、受信停止中の A は選ばれない。
    expect(switched).toEqual(["B"]);
    controller.stop();
  });

  test("among receiving backups the higher priority wins, then the lower RTT", () => {
    // Arrange: 受信中の 3 つ (priority 低・RTT 低 / priority 高・RTT 高 / priority 高・RTT 低)。
    const { controller, switched } = arrange([
      { name: "low", priority: 5, rtt: 1, silent: false },
      { name: "highSlow", priority: 7, rtt: 30, silent: false },
      { name: "highFast", priority: 7, rtt: 20, silent: false },
    ]);

    // Act: 保留時間が明けた時点で判定する。
    vi.setSystemTime(now + RECEIVING_SWITCHING_DELAY);
    controller.evaluate();

    // Assert: priority が高い中で RTT が最も低いものへ移る。
    expect(switched).toEqual(["highFast"]);
    controller.stop();
  });

  test("the hold is counted from the unanswered check: no switch right after it", () => {
    // Arrange: 選択中は 10 s 無通信で、未応答が確定したのは now。受信中の退避先が 1 つ。
    const { controller, switched } = arrange(
      [{ name: "B", priority: 5, rtt: 40, silent: false }],
      0,
    );

    // Act: 未応答の確定直後に判定する。
    controller.evaluate();

    // Assert: 保留中で移らない (保留の再判定がタイマーで予約される)。
    expect(switched).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    controller.stop();
  });
});

describe("CandidatePair.smoothedRtt", () => {
  test("the median of the last 5 samples: one outlier does not move it", () => {
    // Arrange
    const pair = new CandidatePair(
      { localCandidate: createConsentCandidate("192.0.2.1", 4000) } as never,
      createConsentCandidate("192.0.2.2", 5000),
      true,
    );

    // Act: 2 回だけでは値がなく、3 回目から値が出る。続けて外れ値を 1 回入れる。
    pair.recordRoundTrip(0.05);
    pair.recordRoundTrip(0.05);
    const twoSamples = pair.smoothedRtt;
    pair.recordRoundTrip(0.05);
    pair.recordRoundTrip(0.001);
    const afterLowOutlier = pair.smoothedRtt;
    pair.recordRoundTrip(0.9);
    const afterHighOutlier = pair.smoothedRtt;

    // Assert: 外れ値 (低・高) で平滑値は動かない。統計用の値は最新・合計を保つ。
    expect(twoSamples).toBeUndefined();
    expect(afterLowOutlier).toBe(0.05);
    expect(afterHighOutlier).toBe(0.05);
    expect(pair.rtt).toBe(0.9);
    expect(pair.roundTripTimeMeasurements).toBe(5);
    expect(pair.totalRoundTripTime).toBeCloseTo(1.051);
  });
});

describe("switching the selection by RTT and receiving state (controlling)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // consent と退避先の check の間隔を揺らさない (5 s と 2.5 s)。
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe.each([
    { mode: "semi-aggressive", renomination: false },
    { mode: "renomination", renomination: true },
  ])("$mode", ({ renomination }) => {
    test("equal priority: the selection moves to the pair whose RTT is 11 ms lower, nominating it", async () => {
      // Arrange: priority が同じ 2 つの TURN 割り当て。選択中 (0) の RTT 30 ms、もう一方 (1) 19 ms。
      const h = await createRttSwitchHarness({ renomination });
      const slow = h.selection;
      const fast = h.pairOf(1);
      h.setRtt(0, 30);
      h.setRtt(1, 19);

      try {
        // Act: 双方の RTT の標本がそろうまで進める。
        await h.advanceUntil(() => h.connection.nominated === fast, 30_000);

        // Assert: 速い方へ移り、USE-CANDIDATE / 大きい NOMINATION で指名した。
        expect(h.connection.nominated).toBe(fast);
        expect(fast.smoothedRtt).toBeCloseTo(0.019);
        expect(slow.smoothedRtt).toBeCloseTo(0.03);
        const [nomination] = h.switchNominations(fast);
        if (renomination) {
          expect(nomination?.nomination).toBeGreaterThan(slow.nomination);
          expect(fast.nomination).toBe(nomination?.nomination);
        } else {
          expect(nomination?.useCandidate).toBe(true);
        }
        // Assert: 元のペアは退避先として残り、指名は外れる (戻るには新しい指名が要る)。
        expect(slow.nominated).toBe(false);
        expect(h.connection.state).toBe("connected");

        // Act: そのまま 30 s 進める。
        const movedAt = Date.now();
        await vi.advanceTimersByTimeAsync(30_000);

        // Assert: 行ったり来たりしない (移った後、元のペアへの指名はない)。
        expect(h.connection.nominated).toBe(fast);
        expect(
          h.switchNominations(slow).filter(({ at }) => at > movedAt),
        ).toEqual([]);
      } finally {
        await h.connection.close();
      }
    });

    test("equal priority: a pair only 9 ms faster does not take the selection", async () => {
      // Arrange: 選択中 (0) の RTT 30 ms、もう一方 (1) 21 ms。
      const h = await createRttSwitchHarness({ renomination });
      const fast = h.pairOf(1);
      h.setRtt(0, 30);
      h.setRtt(1, 21);

      try {
        // Act: 30 s 進める。
        await vi.advanceTimersByTimeAsync(30_000);

        // Assert: 10 ms 未満の改善では移らず、指名も送らない。
        expect(fast.smoothedRtt).toBeCloseTo(0.021);
        expect(h.connection.nominated).toBe(h.selection);
        expect(h.switchNominations(fast)).toEqual([]);
      } finally {
        await h.connection.close();
      }
    });

    test("equal priority: one outlier RTT of the other pair does not move the selection", async () => {
      // Arrange: 双方とも RTT 30 ms で安定させる。
      const h = await createRttSwitchHarness({ renomination });
      const other = h.pairOf(1);
      h.setRtt(0, 30);
      h.setRtt(1, 30);
      await vi.advanceTimersByTimeAsync(15_000);
      const answered = () =>
        h.requestsTo(other).filter((request) => request.answered).length;

      try {
        // Act: もう一方の check が 1 回だけ 0 ms で応答され、その後は 30 ms に戻る。
        h.setRtt(1, 0);
        const before = answered();
        await h.advanceUntil(() => answered() > before, 10_000);
        h.setRtt(1, 30);
        const outlier = other.rtt;
        await vi.advanceTimersByTimeAsync(20_000);

        // Assert: 外れ値は記録されるが平滑値は 30 ms のままで、選択は動かない。
        expect(outlier).toBe(0);
        expect(other.smoothedRtt).toBeCloseTo(0.03);
        expect(h.connection.nominated).toBe(h.selection);
        expect(h.switchNominations(other)).toEqual([]);
      } finally {
        await h.connection.close();
      }
    });

    test("receiving: a selection that recovers within RECEIVING_SWITCHING_DELAY stays; one that does not moves after it", async () => {
      // Arrange: 選択中は host (高い priority)、退避先は relay (低い priority)。
      const h = await createRttSwitchHarness({
        renomination,
        locals: [
          { type: "stun", candidateType: "host", priority: FAILOVER_HIGH },
          { type: "turn", candidateType: "relay", priority: FAILOVER_LOW },
        ],
      });
      const host = h.selection;
      const relay = h.pairOf(1);
      await vi.advanceTimersByTimeAsync(10_000);

      try {
        // Act: 応答の直後に host の経路を切り、受信なしの判定 (2.5 s) の後 (保留中) に戻す。
        await h.cutRightAfterAnswer(0);
        await vi.advanceTimersByTimeAsync(
          WEAK_CONNECTION_RECEIVE_TIMEOUT + RECEIVING_SWITCHING_DELAY / 2,
        );
        h.restore(0);
        await vi.advanceTimersByTimeAsync(10_000);

        // Assert: 保留中に host が応答を取り戻したので移らず、relay を指名もしない。
        expect(h.connection.nominated).toBe(host);
        expect(h.switchNominations(relay)).toEqual([]);

        // Act: host の経路をもう一度、応答の直後に切り、今度は戻さない。
        await h.cutRightAfterAnswer(0);
        const holdFrom =
          h.liveness(host)!.lastReceived + WEAK_CONNECTION_RECEIVE_TIMEOUT;
        await h.advanceUntil(() => h.connection.nominated === relay, 10_000);

        // Assert: 受信がなくなってから RECEIVING_SWITCHING_DELAY 経って relay へ移る。
        expect(h.connection.nominated).toBe(relay);
        expect(Date.now() - holdFrom).toBeGreaterThanOrEqual(
          RECEIVING_SWITCHING_DELAY,
        );
        expect(Date.now() - holdFrom).toBeLessThanOrEqual(
          RECEIVING_SWITCHING_DELAY + 1200,
        );
        expect(h.connection.state).toBe("connected");
      } finally {
        await h.connection.close();
      }
    });
  });

  test("controlled: the agent does not switch by RTT itself (it follows the peer's nominations)", async () => {
    // Arrange: controlled の agent。priority が同じ 2 つの経路で、選択中の方が 30 ms 遅い。
    const h = await createRttSwitchHarness();
    h.switchRole(false);
    h.setRtt(0, 40);
    h.setRtt(1, 10);

    try {
      // Act: 30 s 進める。
      await vi.advanceTimersByTimeAsync(30_000);

      // Assert: 自分からは指名せず、選択も変えない。
      expect(h.connection.nominated).toBe(h.selection);
      expect(h.switchNominations(h.pairOf(1))).toEqual([]);
    } finally {
      await h.connection.close();
    }
  });
});

describe("switching the selection by RTT over real sockets", () => {
  test.each([
    { mode: "semi-aggressive", renomination: false },
    { mode: "renomination", renomination: true },
  ])(
    "$mode: a delay injected on the selected relay moves both agents to the other relay",
    async ({ renomination }) => {
      // Arrange: 同じ priority の relay 2 本 (それぞれ別の UDP 中継経由) で接続済み。
      const h = await createRttSwitchRealPair({ renomination });
      const sending = setInterval(() => {
        // 双方がデータを送り続ける (controlled 側はデータを受けたペアへ追従する)。
        void h.a.send(Buffer.from("a")).catch(() => {});
        void h.b.send(Buffer.from("b")).catch(() => {});
      }, 100);

      try {
        expect(h.relays).toHaveLength(2);
        const before = h.relayIndexOf(h.a);
        expect(before).toBeGreaterThanOrEqual(0);
        await expect
          .poll(() => h.relayIndexOf(h.b), { timeout: 10_000 })
          .toBe(before);
        const other = 1 - before;

        // Act: 選択中の relay の経路だけに片道 50 ms (RTT +100 ms) の遅延を入れる。
        h.delay(before, 50);

        // Assert: 両端とも遅延のない relay へ移る。
        await expect
          .poll(() => h.relayIndexOf(h.a), { timeout: 40_000, interval: 200 })
          .toBe(other);
        await expect
          .poll(() => h.relayIndexOf(h.b), { timeout: 10_000, interval: 200 })
          .toBe(other);
        expect(h.a.state).toBe("connected");
        expect(h.b.state).toBe("connected");
      } finally {
        clearInterval(sending);
        await h.close();
      }
    },
    90_000,
  );
});
