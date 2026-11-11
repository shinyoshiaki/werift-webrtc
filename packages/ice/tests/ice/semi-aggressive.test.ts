import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CandidatePairState } from "../../src";
import {
  createDelayedPreferredPathPair,
  createNominationHarness,
  createSelectionPair,
  expectDataFlows,
  recordSentRequests,
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

  test("a higher-priority candidate trickled after the selection is checked and replaces it; a lower one forms no pair", async () => {
    const h = createHarness();
    const mid = await h.addRemote(MID);
    h.check(mid);
    await h.release(mid);
    expect(h.connection.nominated).toBe(mid);

    try {
      // Act: 選択後に低優先度と高優先度の候補が trickle で届く。
      const low = await h.addRemote(LOW);
      const high = await h.addRemote(HIGH);

      // Assert: 低優先度の候補は pair を作らず、高優先度の pair は自動で check される (USE-CANDIDATE 付き)。
      expect(low).toBeUndefined();
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

  test("ordinary checks carry no nomination; the first valid pair is nominated with NOMINATION 1", async () => {
    const h = createHarness();
    const low = await h.addRemote(LOW);
    const high = await h.addRemote(HIGH);
    h.check(high);
    h.check(low);

    try {
      // Act: 低優先度 pair の通常 check が成功する。
      await h.release(low);

      // Assert: 通常 check には USE-CANDIDATE も NOMINATION も付かない。
      for (const pair of [low, high]) {
        const [check] = h.requestsTo(pair);
        expect(check.message.attributesKeys).not.toContain("USE-CANDIDATE");
        expect(check.message.attributesKeys).not.toContain("NOMINATION");
      }
      // Assert: valid になった pair へ NOMINATION=1 の check を別に送り、応答までは選択しない。
      const [, renomination] = h.requestsTo(low);
      expect(renomination.message.getAttributeValue("NOMINATION")).toBe(1);
      expect(renomination.message.attributesKeys).not.toContain(
        "USE-CANDIDATE",
      );
      expect(h.connection.nominated).toBeUndefined();

      // Act: NOMINATION の check が成功する。
      await h.release(low);

      // Assert: その pair が選択される。
      expect(h.connection.nominated).toBe(low);
      expect(low.nomination).toBe(1);
    } finally {
      await h.connection.close();
    }
  });

  test("a higher-priority pair that succeeds later is renominated with a larger value and replaces the selection", async () => {
    const h = createHarness();
    const low = await h.addRemote(LOW);
    const high = await h.addRemote(HIGH);
    h.check(high);
    h.check(low);
    await h.release(low);
    await h.release(low);
    expect(h.connection.nominated).toBe(low);

    try {
      // Act: 高優先度 pair の通常 check が成功し、続く再指名の check も成功する。
      await h.release(high);
      const [, renomination] = h.requestsTo(high);
      await h.release(high);

      // Assert: より大きい NOMINATION=2 で再指名し、選択が高優先度 pair に置き換わる。
      expect(renomination.message.getAttributeValue("NOMINATION")).toBe(2);
      expect(h.connection.nominated).toBe(high);
      expect(high.nomination).toBe(2);
    } finally {
      await h.connection.close();
    }
  });

  test("a renomination that goes unanswered keeps the selection", async () => {
    const h = createHarness();
    const low = await h.addRemote(LOW);
    const high = await h.addRemote(HIGH);
    h.check(high);
    h.check(low);
    await h.release(low);
    await h.release(low);
    await h.release(high);

    try {
      // Act: 高優先度 pair への再指名 check がタイムアウトする。
      await h.release(high, "failure");

      // Assert: 選択は変わらず、その pair は使わない。
      expect(h.connection.nominated).toBe(low);
      expect(high.state).toBe(CandidatePairState.FAILED);
    } finally {
      await h.connection.close();
    }
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

  test("a larger NOMINATION value wins, even on a lower-priority pair; a smaller one does not", async () => {
    const { h, low, high } = await createValidPairs();

    try {
      // Act: 相手が NOMINATION=1 で高優先度 pair を、続いて NOMINATION=2 で低優先度 pair を指名する。
      h.receiveNomination(high, 1);
      const first = h.connection.nominated;
      h.receiveNomination(low, 2);
      const second = h.connection.nominated;
      // Act: 古い値 (1) の指名が高優先度 pair に再び届く。
      h.receiveNomination(high, 1);

      // Assert: 値の大きい指名に切り替わり、小さい値では戻らない。
      expect(first).toBe(high);
      expect(second).toBe(low);
      expect(h.connection.nominated).toBe(low);
    } finally {
      await h.connection.close();
    }
  });

  test("USE-CANDIDATE on a higher-priority pair replaces the selection, on a lower one it does not", async () => {
    const { h, low, high } = await createValidPairs();

    try {
      // Act: 相手の USE-CANDIDATE が低優先度、高優先度、再び低優先度の順に届く。
      h.receiveNomination(low);
      const first = h.connection.nominated;
      h.receiveNomination(high);
      const second = h.connection.nominated;
      h.receiveNomination(low);

      // Assert: 指名済みのうち最も優先度の高い pair を使う (RFC 5245 §8.1.1.2)。
      expect(first).toBe(low);
      expect(second).toBe(high);
      expect(h.connection.nominated).toBe(high);
    } finally {
      await h.connection.close();
    }
  });
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

describe("semi-aggressive nomination and renomination over real sockets", () => {
  test("two agents with the default options connect, settle on one path and exchange data", async () => {
    const { a, b } = await createSelectionPair();
    const sent = recordSentRequests(a);

    try {
      // Act: 既定の設定 (semi-aggressive) で両 agent が接続する。
      await Promise.all([a.connect(), b.connect()]);

      // Assert: controlling 側の check は USE-CANDIDATE を付けて送られる。
      expect(sent.some((request) => request.useCandidate)).toBe(true);
      // Assert: 両端の選択が同じ 5-tuple に収束し、データが双方向に届く。
      await vi.waitFor(() => expect(selectSamePath(a, b)).toBe(true), {
        timeout: 3000,
      });
      await expectDataFlows(a, b, "a to b");
      await expectDataFlows(b, a, "b to a");
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  test("with renomination negotiated both agents select the pair the NOMINATION values name", async () => {
    const { a, b } = await createSelectionPair({
      options: { renomination: true },
      remoteRenomination: true,
    });
    const sent = recordSentRequests(a);

    try {
      // Act: 両 agent が renomination を有効にして接続する。
      await Promise.all([a.connect(), b.connect()]);

      // Assert: controlling 側は USE-CANDIDATE を使わず、NOMINATION を送る。
      expect(sent.some((request) => request.useCandidate)).toBe(false);
      expect(sent.some((request) => (request.nomination ?? 0) > 0)).toBe(true);
      // Assert: 両端の選択が同じ 5-tuple になり、controlled 側はその値で選択している。
      await vi.waitFor(() => expect(selectSamePath(a, b)).toBe(true), {
        timeout: 3000,
      });
      expect(b.nominated!.remoteNomination).toBe(a.nominated!.nomination);
      await expectDataFlows(a, b, "a to b");
      await expectDataFlows(b, a, "b to a");
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

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
});
