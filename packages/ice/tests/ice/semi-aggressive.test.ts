import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CandidatePairState } from "../../src";
import {
  createDelayedPreferredPathPair,
  createNominationHarness,
  expectDataFlows,
  selectSamePath,
} from "../utils";

const LOW = 100;
const MID = 1_000_000;
const HIGH = 2_000_000_000;

describe("semi-aggressive nomination (default, full ICE, controlling)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Arrange: the default nomination; every request waits for `release`. */
  const createHarness = () =>
    createNominationHarness({
      nomination: "semi-aggressive",
      nominationReply: () => "hold",
    });

  test("ordinary checks carry USE-CANDIDATE and the first pair that succeeds is selected at once", async () => {
    const h = createHarness();
    const low = await h.addRemote(LOW);
    const high = await h.addRemote(HIGH);
    h.check(high);
    h.check(low);

    try {
      // Act: 低優先度 pair の check が先に成功する (タイマーは進めない)。
      await h.release(low);

      // Assert: 選択前の通常 check には USE-CANDIDATE が付き、最初に成功した pair が待たずに選択される。
      expect(h.requests()).toHaveLength(2);
      for (const request of h.requests()) {
        expect(request.message.attributesKeys).toContain("USE-CANDIDATE");
      }
      expect(h.connection.nominated).toBe(low);
      // Assert: 高優先度 pair の check は打ち切られず続いている。
      expect(high.state).toBe(CandidatePairState.IN_PROGRESS);
    } finally {
      await h.connection.close();
    }
  });

  test("a higher-priority pair that succeeds after the selection replaces it", async () => {
    const h = createHarness();
    const low = await h.addRemote(LOW);
    const high = await h.addRemote(HIGH);
    h.check(high);
    h.check(low);
    await h.release(low);

    try {
      // Act: 選択後に高優先度 pair の check (USE-CANDIDATE 付き) が成功する。
      await h.release(high);

      // Assert: 選択が高優先度 pair に置き換わる。
      expect(h.connection.nominated).toBe(high);
      expect(high.nominated).toBe(true);
    } finally {
      await h.connection.close();
    }
  });

  test("a pair that does not outrank the selection neither carries USE-CANDIDATE nor replaces it", async () => {
    const h = createHarness();
    const high = await h.addRemote(HIGH);
    const low = await h.addRemote(LOW);
    h.check(high);
    await h.release(high);
    expect(h.connection.nominated).toBe(high);

    try {
      // Act: 選択後に低優先度 pair の check (相手からの triggered check 相当) が成功する。
      h.check(low);
      await h.release(low);

      // Assert: 選択より低い pair の check には USE-CANDIDATE が付かず、選択も変わらない。
      const [lowCheck] = h.requestsTo(low);
      expect(lowCheck.message.attributesKeys).not.toContain("USE-CANDIDATE");
      expect(h.connection.nominated).toBe(high);
      expect(low.nominated).toBe(false);
    } finally {
      await h.connection.close();
    }
  });

  test("a higher-priority candidate trickled after the selection is checked and replaces it; a lower one becomes a backup checked without USE-CANDIDATE", async () => {
    const h = createHarness();
    const mid = await h.addRemote(MID);
    h.check(mid);
    await h.release(mid);
    expect(h.connection.nominated).toBe(mid);

    try {
      // Act: 選択後に低優先度と高優先度の候補が trickle で届く。
      const low = await h.addRemote(LOW);
      const high = await h.addRemote(HIGH);

      // Assert: 低優先度の候補は同じソケットの退避先の pair になり、USE-CANDIDATE なしで監視される (failover)。
      expect(low).toBeDefined();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.requestsTo(low).length).toBeGreaterThan(0);
      for (const request of h.requestsTo(low)) {
        expect(request.message.attributesKeys).not.toContain("USE-CANDIDATE");
      }
      expect(h.connection.nominated).toBe(mid);
      // Assert: 高優先度の pair は自動で check される (USE-CANDIDATE 付き)。
      const [highCheck] = h.requestsTo(high);
      expect(highCheck.message.attributesKeys).toContain("USE-CANDIDATE");

      // Act: その check が成功する。
      await h.release(high);

      // Assert: 選択が高優先度 pair に置き換わる。
      expect(h.connection.nominated).toBe(high);
    } finally {
      await h.connection.close();
    }
  });

  test("a pair that succeeded while controlled is nominated with a separate USE-CANDIDATE check after the agent became controlling", async () => {
    const h = createHarness();
    h.switchRole(false);
    const pair = await h.addRemote(HIGH);
    h.check(pair);
    await h.release(pair);
    expect(h.connection.nominated).toBeUndefined();

    try {
      // Act: ロール競合の修復で controlling に切り替わる。
      h.switchRole(true);

      // Assert: valid な pair へ USE-CANDIDATE 付きの check を 1 回送る。
      const [, nomination] = h.requestsTo(pair);
      expect(nomination.message.attributesKeys).toContain("USE-CANDIDATE");
      expect(nomination.message.attributesKeys).toContain("ICE-CONTROLLING");

      // Act: その check が成功する。
      await h.release(pair);

      // Assert: その pair が選択される。
      expect(h.connection.nominated).toBe(pair);
    } finally {
      await h.connection.close();
    }
  });
  test("a pair the peer nominated while controlled gets USE-CANDIDATE after the agent became controlling", async () => {
    const h = createHarness();
    h.switchRole(false);
    const pair = await h.addRemote(HIGH);
    h.check(pair);
    await h.release(pair);
    h.receiveNomination(pair);
    expect(h.connection.nominated).toBe(pair);

    try {
      // Act: 相手の指名で選択済みのまま、ロール競合の修復で controlling に切り替わる。
      h.switchRole(true);
      await vi.advanceTimersByTimeAsync(0);

      // Assert: 選択は変えず、controlled になった相手のために同じ pair へ USE-CANDIDATE を送る。
      expect(h.connection.nominated).toBe(pair);
      const confirmation = h.requestsTo(pair).at(-1)!;
      expect(confirmation.message.attributesKeys).toContain("USE-CANDIDATE");
      expect(confirmation.message.attributesKeys).toContain("ICE-CONTROLLING");
    } finally {
      await h.connection.close();
    }
  });
});

describe("renomination (both agents advertise it, controlling)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Arrange: renomination negotiated; every request waits for `release`. */
  const createHarness = () =>
    createNominationHarness({
      renomination: true,
      nominationReply: () => "hold",
    });

  test("a role change invalidates a renomination in flight", async () => {
    const h = createNominationHarness({
      renomination: true,
      nominationReply: () => "hold",
      // 中止された request にも後から応答できるようにする (遅れた応答)。
      honorSignal: false,
    });
    const pair = await h.addRemote(HIGH);
    h.check(pair);
    await h.release(pair);
    expect(h.requestsTo(pair)).toHaveLength(2);

    try {
      // Act: NOMINATION の check の送信中にロールが controlled に変わり、その後に応答が届く。
      h.switchRole(false);
      await h.release(pair);

      // Assert: 古いロールで送った指名の応答では選択しない。
      expect(h.connection.nominated).toBeUndefined();
      expect(pair.nomination).toBe(0);
    } finally {
      await h.connection.close();
    }
  });

  test("without the peer's renomination the agent nominates semi-aggressively", async () => {
    const h = createNominationHarness({
      nomination: "semi-aggressive",
      renomination: true,
      nominationReply: () => "hold",
    });
    h.connection.remoteRenomination = false;
    const pair = await h.addRemote(HIGH);

    try {
      // Act: 相手が renomination を広告していない状態で check を始める。
      h.check(pair);

      // Assert: renomination ではなく USE-CANDIDATE (semi-aggressive) で指名する。
      const [check] = h.requestsTo(pair);
      expect(check.message.attributesKeys).toContain("USE-CANDIDATE");
      expect(check.message.attributesKeys).not.toContain("NOMINATION");
    } finally {
      await h.connection.close();
    }
  });
});

describe("controlled agent: a later nomination replaces the selection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Arrange: a controlled agent with a low- and a high-priority valid pair. */
  const createValidPairs = async () => {
    const h = createNominationHarness();
    h.switchRole(false);
    const low = await h.addRemote(LOW);
    const high = await h.addRemote(HIGH);
    h.check(low);
    h.check(high);
    await h.succeed(low);
    await h.succeed(high);
    return { h, low, high };
  };

  test("a check cancelled while a higher-priority nomination of its pair was received is checked again and replaces the selection", async () => {
    const h = createNominationHarness();
    h.switchRole(false);
    const low = await h.addRemote(LOW);
    const high = await h.addRemote(HIGH);
    h.check(low);
    h.check(high);
    await h.succeed(low);
    h.receiveNomination(low);

    try {
      // Act: 高優先度 pair の check の応答待ち中に相手の USE-CANDIDATE が届き、その後 check が打ち切られる (接続完了時と同じ)。
      h.receiveNomination(high);
      high.handle!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      const checksAfterCancel = h.requestsTo(high).length;
      // Act: 再び始まった check が成功する。
      await h.succeed(high);

      // Assert: 打ち切り直後に高優先度 pair の check が再び送られ、成功で選択が切り替わる。
      expect(checksAfterCancel).toBe(2);
      expect(h.connection.nominated).toBe(high);
    } finally {
      await h.connection.close();
    }
  });

  test("a pair whose check was cancelled goes back to Waiting, so the peer's later nomination triggers a check", async () => {
    const h = createNominationHarness({ renomination: true });
    h.switchRole(false);
    const low = await h.addRemote(LOW);
    const high = await h.addRemote(HIGH);
    h.check(low);
    h.check(high);
    await h.succeed(low);
    h.receiveNomination(low, 1);

    try {
      // Act: 高優先度 pair の check を打ち切る (接続完了時と同じ)。
      high.handle!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      const stateAfterCancel = high.state;
      // Act: 相手が NOMINATION=2 で高優先度 pair を指名し、それが起こした check が成功する。
      h.receiveNomination(high, 2);
      await h.succeed(high);

      // Assert: 打ち切った pair は Waiting に戻り、後続の指名で check され選択が切り替わる。
      expect(stateAfterCancel).toBe(CandidatePairState.WAITING);
      expect(h.connection.nominated).toBe(high);
      expect(high.remoteNomination).toBe(2);
    } finally {
      await h.connection.close();
    }
  });
});

describe("a failed pair that outranks the selection is checked again (controlling)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Arrange: the high-priority pair's check fails and the low one is
   * selected. Every request waits for `release` (with renomination, the
   * low pair's NOMINATION is answered too).
   */
  const selectLowAfterHighFailed = async ({
    renomination = false,
  }: {
    renomination?: boolean;
  } = {}) => {
    const h = createNominationHarness({
      nomination: "semi-aggressive",
      renomination,
      nominationReply: () => "hold",
    });
    const low = await h.addRemote(LOW);
    const high = await h.addRemote(HIGH);
    h.check(high);
    h.check(low);
    await h.release(high, "failure");
    await h.release(low);
    if (renomination) await h.release(low);
    expect(h.connection.nominated).toBe(low);
    expect(high.state).toBe(CandidatePairState.FAILED);
    return { h, low, high };
  };

  test("retries back off (1, 2, 4, 8, 16 s) and then go on every 16 s (failover keeps looking for the path)", async () => {
    const { h, high } = await selectLowAfterHighFailed();
    const counts: number[] = [];

    try {
      // Act: 再 check をすべて失敗させながら、各間隔の直前と到達時の送信数を記録する。
      for (const delay of [1000, 2000, 4000, 8000, 16000, 16000, 16000]) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        counts.push(h.requestsTo(high).length);
        await vi.advanceTimersByTimeAsync(1);
        counts.push(h.requestsTo(high).length);
        await h.release(high, "failure");
      }

      // Assert: 間隔が倍になり、5 回目の後は 16 s ごとに続く (長く落ちていた経路も復帰を検出できる)。選択は低優先度 pair のまま。
      expect(counts).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8]);
      expect(h.connection.nominated).not.toBe(high);
    } finally {
      await h.connection.close();
    }
  });

  test("a failed pair that does not outrank the selection is not retried as an outranking pair (only monitored as a backup, without USE-CANDIDATE)", async () => {
    const h = createNominationHarness({
      nomination: "semi-aggressive",
      nominationReply: () => "hold",
    });
    const low = await h.addRemote(LOW);
    const high = await h.addRemote(HIGH);
    h.check(high);
    h.check(low);
    await h.release(low, "failure");
    await h.release(high);

    try {
      // Act: 60 s 進める。
      await vi.advanceTimersByTimeAsync(60_000);

      // Assert: 選択より下位の失敗した pair は上位ペアとしては再 check しない (USE-CANDIDATE を付けない)。
      // 同じソケットの退避先としての監視 check だけが送られ、選択は変わらない。
      expect(h.connection.nominated).toBe(high);
      for (const request of h.requestsTo(low).slice(1)) {
        expect(request.message.attributesKeys).not.toContain("USE-CANDIDATE");
      }
    } finally {
      await h.connection.close();
    }
  });

  test("close and a role change stop the pending retries", async () => {
    const closing = await selectLowAfterHighFailed();
    const switching = await selectLowAfterHighFailed();

    try {
      // Act: 片方は close し、もう片方は controlled に切り替えてから 60 s 進める。
      await closing.h.connection.close();
      switching.h.switchRole(false);
      await vi.advanceTimersByTimeAsync(60_000);

      // Assert: close した側は何も送らない。
      expect(closing.h.requestsTo(closing.high)).toHaveLength(1);
      // Assert: controlled になった側は上位ペアとしての再 check (ICE-CONTROLLING / USE-CANDIDATE) を送らない。
      // 同じソケットの退避先としての監視 check (ICE-CONTROLLED、指名なし) だけが続く。
      const after = switching.h.requestsTo(switching.high).slice(1);
      expect(after.length).toBeGreaterThan(0);
      for (const request of after) {
        expect(request.message.attributesKeys).toContain("ICE-CONTROLLED");
        expect(request.message.attributesKeys).not.toContain("USE-CANDIDATE");
      }
    } finally {
      await switching.h.connection.close();
    }
  });
});

describe("semi-aggressive nomination and renomination over real sockets", () => {
  test.each([
    { mode: "semi-aggressive", renomination: false },
    { mode: "renomination", renomination: true },
  ])(
    "($mode) a preferred pair whose checks are delayed until after connecting moves both agents to it",
    async ({ renomination }) => {
      const { a, b, open, selectsPreferred, preferredPair, close } =
        await createDelayedPreferredPathPair({ renomination });

      try {
        // Act: 優先 pair の request を止めたまま両 agent が下位の pair で接続する。
        await Promise.all([a.connect(), b.connect()]);

        // Assert: 両端とも下位の pair を選択している。
        expect(selectsPreferred(a)).toBe(false);
        expect(selectsPreferred(b)).toBe(false);
        // Assert: controlled 側の優先 pair の check は接続時に打ち切られ、再び check できる Waiting に戻っている。
        await vi.waitFor(() =>
          expect(preferredPair(b).state).toBe(CandidatePairState.WAITING),
        );

        // Act: 優先 pair の request を通す。
        open();

        // Assert: 両端とも優先 pair に切り替わり、同じ 5-tuple を使う。
        await vi.waitFor(
          () => {
            expect(selectsPreferred(a)).toBe(true);
            expect(selectsPreferred(b)).toBe(true);
            expect(selectSamePath(a, b)).toBe(true);
          },
          { timeout: 3000 },
        );
        // Assert: 切り替え後の経路でデータが双方向に届く。
        await expectDataFlows(a, b, "a to b");
        await expectDataFlows(b, a, "b to a");
      } finally {
        await close();
      }
    },
  );

  test.each([
    { mode: "semi-aggressive", renomination: false },
    { mode: "renomination", renomination: true },
  ])(
    "($mode) a preferred pair whose checks failed on both agents is checked again and both agents move to it",
    async ({ renomination }) => {
      const { a, b, open, selectsPreferred, preferredPair, close } =
        await createDelayedPreferredPathPair({ renomination, drop: true });

      try {
        // Act: 優先 pair の request が失われる間に、両 agent が relay の pair で接続する。
        await Promise.all([a.connect(), b.connect()]);

        // Assert: 両端とも下位の pair を選択し、優先 pair の check は両端で失敗している。
        expect(selectsPreferred(a)).toBe(false);
        expect(selectsPreferred(b)).toBe(false);
        await vi.waitFor(() => {
          expect(preferredPair(a).state).toBe(CandidatePairState.FAILED);
          expect(preferredPair(b).state).toBe(CandidatePairState.FAILED);
        });

        // Act: 優先 pair の経路が回復する。
        open();

        // Assert: controlling 側の再 check で両端とも優先 pair に移り、同じ 5-tuple を使う。
        await vi.waitFor(
          () => {
            expect(selectsPreferred(a)).toBe(true);
            expect(selectsPreferred(b)).toBe(true);
            expect(selectSamePath(a, b)).toBe(true);
          },
          { timeout: 6000 },
        );
        // Assert: 移った経路でデータが双方向に届く。
        await expectDataFlows(a, b, "a to b");
        await expectDataFlows(b, a, "b to a");
      } finally {
        await close();
      }
    },
    15_000,
  );

  test("the controlled agent follows the peer back to a lower-priority pair it nominated, once the peer sends data on it", async () => {
    const { a, b, open, selectsPreferred, relayPair, close } =
      await createDelayedPreferredPathPair();
    await Promise.all([a.connect(), b.connect()]);
    open();
    await vi.waitFor(
      () => {
        expect(selectsPreferred(a)).toBe(true);
        expect(selectsPreferred(b)).toBe(true);
      },
      { timeout: 3000 },
    );
    await expectDataFlows(a, b, "on the preferred path");

    try {
      // Act: controlling 側が自分の判断で relay の pair に選択を戻し (libwebrtc の ICE controller が
      // 選択中の経路の不調で移るのと同じ)、その経路でデータを送る。
      a.nominated = relayPair(a);
      await expectDataFlows(a, b, "back on the relay path");

      // Assert: 指名の値は同じ (USE-CANDIDATE)。controlled 側はデータが届いた relay の pair に移り、両端の経路がそろう。
      expect(relayPair(b).remoteNomination).toBe(b.nominated!.remoteNomination);
      expect(b.nominated).toBe(relayPair(b));
      expect(selectSamePath(a, b)).toBe(true);
      await expectDataFlows(b, a, "b answers on the relay path");
    } finally {
      await close();
    }
  });
});
