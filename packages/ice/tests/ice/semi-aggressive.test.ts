import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type CandidatePair, CandidatePairState } from "../../src";
import {
  createDelayedPreferredPathPair,
  createNominationHarness,
  createSelectionPair,
  expectDataFlows,
  propertySeeds,
  recordSentRequests,
  type ScriptedRequest,
  seededRandom,
  selectSamePath,
} from "../utils";

const LOW = 100;
const MID = 1_000_000;
const HIGH = 2_000_000_000;
/** Captured before the fake timers replace it. */
const realSetTimeout = setTimeout;

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

/** Real `setTimeout`: the paced outranking checks wait on `node:timers/promises`, which fake timers do not advance. */
const realDelay = (ms: number) =>
  new Promise<void>((resolve) => realSetTimeout(resolve, ms));

describe("semi-aggressive nomination / renomination (controlling): model property", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const PRIORITIES = [LOW, MID, 300_000_000, HIGH];
  const { seeds, steps, replay } = propertySeeds("WERIFT_ICE_SELECTION", {
    seeds: 40,
    steps: 30,
  });

  test.each(
    seeds.flatMap((seed) =>
      (["semi-aggressive", "renomination"] as const).map((mode) => ({
        seed,
        mode,
      })),
    ),
  )("$mode, seed $seed", async ({ seed, mode }) => {
    // Arrange: seed から候補の追加・check の開始・応答 (成功 / 失敗)・時間の経過の列を決める。
    const random = seededRandom(seed);
    const renomination = mode === "renomination";
    const h = createNominationHarness({
      nomination: "semi-aggressive",
      renomination,
      nominationReply: () => "hold",
    });
    const pairs: { pair: CandidatePair; priority: number }[] = [];
    const failures = new Map<CandidatePair, number>();
    const trace: string[] = [];
    let lastValue = 0;
    let processed = 0;
    /** Requests of the checks a peer's check triggered (any pair, also after the selection). */
    const triggered = new Set<number>();
    const why = (what: string) =>
      `${what} (${replay(seed)}; ${trace.join(", ")})`;
    const priorityOf = (pair: CandidatePair) =>
      pairs.find((p) => p.pair === pair)!.priority;
    const pairAt = (port: number) =>
      pairs.find((p) => p.pair.remoteAddr[1] === port)!.pair;
    const selected = () => h.connection.nominated;
    const outranksSelection = (pair: CandidatePair) =>
      !selected() || priorityOf(pair) > priorityOf(selected()!);
    const pending = () => h.requests().filter((request) => !request.done);
    /** Pairs with no request in flight. */
    const idle = () =>
      pairs.filter(
        (p) => !pending().some((r) => r.addr[1] === p.pair.remoteAddr[1]),
      );

    /** Check the requests sent since the last step and the state they left. */
    const observe = (before: CandidatePair | undefined) => {
      const after = selected();
      for (; processed < h.requests().length; processed++) {
        const request = h.requests()[processed];
        const keys = request.message.attributesKeys;
        const pair = pairAt(request.addr[1]);
        trace.push(
          `sent:${priorityOf(pair)}${keys.includes("NOMINATION") ? "/N" : ""}`,
        );
        if (renomination) {
          // Assert: renomination は USE-CANDIDATE を使わず、NOMINATION の値は増え続ける。
          expect(keys, why("USE-CANDIDATE with renomination")).not.toContain(
            "USE-CANDIDATE",
          );
          if (keys.includes("NOMINATION")) {
            const value = request.message.getAttributeValue("NOMINATION");
            expect(value, why("NOMINATION is not the next value")).toBe(
              lastValue + 1,
            );
            lastValue = value;
          }
        } else if (triggered.has(processed)) {
          // Assert: semi-aggressive の check は、未選択の間と選択より上位の pair にだけ USE-CANDIDATE を運ぶ。
          expect(
            request.nominate,
            why("USE-CANDIDATE on a triggered check"),
          ).toBe(outranksSelection(pair));
        } else {
          // Assert: 自分から送る check は (未選択か選択より上位なので) すべて USE-CANDIDATE を運ぶ。
          expect(request.nominate, why("a check without USE-CANDIDATE")).toBe(
            true,
          );
        }
        // Assert: 選択後に自分から送る check と指名は、選択より上位の pair にだけ送る。
        if (after && !triggered.has(processed)) {
          expect(
            outranksSelection(pair),
            why("a request to a pair below the selection"),
          ).toBe(true);
        }
      }
      // Assert: 選択は上位の pair にしか移らない。
      if (before && after !== before) {
        expect(
          priorityOf(after!) > priorityOf(before),
          why("the selection moved down"),
        ).toBe(true);
      }
      // Assert: 選択より上位の pair は、失敗させた応答なしには FAILED にならない (8.1.2 の掃除は下位だけ)。
      for (const { pair } of pairs) {
        if (
          pair.state === CandidatePairState.FAILED &&
          outranksSelection(pair)
        ) {
          expect(
            failures.has(pair),
            why("a higher pair failed without a failure"),
          ).toBe(true);
        }
      }
      // Assert: renomination では NOMINATION の指名は同時に 1 つだけ。
      if (renomination) {
        const inFlight = pending().filter((request) =>
          request.message.attributesKeys.includes("NOMINATION"),
        );
        expect(
          inFlight.length,
          why("several NOMINATION checks in flight"),
        ).toBeLessThanOrEqual(1);
      }
    };

    try {
      for (let step = 0; step < steps; step++) {
        const before = selected();
        let answered:
          | { request: ScriptedRequest; pair: CandidatePair }
          | undefined;
        const waiting = pairs.filter(
          (p) => p.pair.state === CandidatePairState.WAITING && !before,
        );
        const answerable = pending();
        const actions = [
          ...(pairs.length < PRIORITIES.length ? ["add", "add"] : []),
          ...(waiting.length > 0 ? ["check"] : []),
          ...(answerable.length > 0 ? ["success", "success", "failure"] : []),
          ...(before && idle().length > 0 ? ["triggered"] : []),
          "advance",
        ];
        const action = random.pick(actions);

        // Act: seed の操作を 1 つ行う。
        if (action === "add") {
          const priority = random.pick(
            PRIORITIES.filter((p) => !pairs.some((q) => q.priority === p)),
          );
          trace.push(`add:${priority}`);
          const pair = await h.addRemote(priority);
          // Assert: 選択後は、選択より下位の候補で pair を作らない。
          if (before && priority < priorityOf(before)) {
            expect(
              pair,
              why("a lower pair formed after the selection"),
            ).toBeUndefined();
          }
          if (pair) {
            pairs.push({ pair, priority });
            // 選択前の check の開始はスケジューラ相当 (すぐに、または後の "check" で)。
            if (!before && random.chance(0.6)) h.check(pair);
          }
        } else if (action === "triggered") {
          // 相手の check が起こす triggered check (選択より下位の pair にも起きる)。
          const { pair, priority } = random.pick(idle());
          trace.push(`triggered:${priority}`);
          triggered.add(h.requests().length);
          h.check(pair);
        } else if (action === "check") {
          const { pair, priority } = random.pick(waiting);
          trace.push(`check:${priority}`);
          h.check(pair);
        } else if (action === "success" || action === "failure") {
          const request = random.pick(answerable);
          const pair = pairAt(request.addr[1]);
          const failed = action === "failure" && (failures.get(pair) ?? 0) < 2;
          trace.push(`${failed ? "failure" : "success"}:${priorityOf(pair)}`);
          if (failed) failures.set(pair, (failures.get(pair) ?? 0) + 1);
          request.release(failed ? "failure" : "success");
          if (!failed) answered = { request, pair };
        } else {
          const ms = random.pick([0, 500, 1000, 2000, 5000, 16_000]);
          trace.push(`advance:${ms}`);
          await vi.advanceTimersByTimeAsync(ms);
        }
        await vi.advanceTimersByTimeAsync(0);
        observe(before);

        // Assert: 指名を運ぶ check (semi-aggressive は USE-CANDIDATE、renomination は NOMINATION) が成功すると、未選択か上位ならすぐにその pair を選択する。
        const carried =
          answered &&
          (renomination
            ? answered.request.message.attributesKeys.includes("NOMINATION")
            : answered.request.nominate);
        if (
          answered &&
          carried &&
          (!before || priorityOf(answered.pair) > priorityOf(before))
        ) {
          expect(selected(), why("not selected at once")).toBe(answered.pair);
        }
        // Assert: renomination では、選択より上位の valid pair があれば NOMINATION の check を出している。
        if (renomination) {
          const better = pairs.some(
            (p) =>
              p.pair.state === CandidatePairState.SUCCEEDED &&
              outranksSelection(p.pair),
          );
          const inFlight = pending().some((r) =>
            r.message.attributesKeys.includes("NOMINATION"),
          );
          if (better)
            expect(inFlight, why("no NOMINATION for a better valid pair")).toBe(
              true,
            );
        }
      }

      // Act: 以降の check と指名にすべて成功で応答し、再 check の時間を経過させる。
      for (let round = 0; round < 40; round++) {
        const before = selected();
        if (pending().length > 0) {
          for (const request of pending()) request.release("success");
        } else if (
          pairs.some((p) => p.pair.state === CandidatePairState.WAITING)
        ) {
          if (!before) {
            for (const p of pairs)
              if (p.pair.state === CandidatePairState.WAITING) h.check(p.pair);
          } else {
            await realDelay(25);
          }
        } else {
          const sent = h.requests().length;
          await vi.advanceTimersByTimeAsync(20_000);
          if (h.requests().length === sent) break;
        }
        await vi.advanceTimersByTimeAsync(0);
        observe(before);
      }

      // Assert: 選択があれば最終的に最上位の pair が選択される (renomination は最後に送った値で)。
      // 選択がないのは、選択前にすべての pair が失敗したときだけ (再 check は選択後に働く)。
      const top = [...pairs].sort((a, b) => b.priority - a.priority)[0]?.pair;
      if (selected()) {
        expect(selected(), why("the top pair is not selected")).toBe(top);
        if (renomination) {
          expect(top.nomination, why("final NOMINATION value")).toBe(lastValue);
        }
      } else {
        expect(
          pairs.every((p) => p.pair.state === CandidatePairState.FAILED),
          why("nothing selected while a pair can still succeed"),
        ).toBe(true);
      }
    } finally {
      await h.connection.close();
    }
  });
});

describe("controlled agent: model property (which nominated pair is used)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const { seeds, steps, replay } = propertySeeds("WERIFT_ICE_CONTROLLED", {
    seeds: 60,
    steps: 20,
  });

  test.each(seeds)("seed %i", async (seed) => {
    // Arrange: 3 つの valid pair を持つ controlled agent。seed から指名 (USE-CANDIDATE / NOMINATION の値) とデータ受信の列を決める。
    const random = seededRandom(seed);
    const h = createNominationHarness();
    h.switchRole(false);
    const pairs: CandidatePair[] = [];
    for (const priority of [LOW, MID, HIGH]) {
      const pair = await h.addRemote(priority);
      h.check(pair);
      await h.succeed(pair);
      pairs.push(pair);
    }
    const nomination = new Map<CandidatePair, number>();
    const lastData = new Map<CandidatePair, number>();
    const trace: string[] = [];
    let sequence = 0;

    try {
      for (let step = 0; step < steps; step++) {
        const index = random.int(0, pairs.length);
        const pair = pairs[index];

        // Act: 相手が pair を指名するか、pair でデータを送る。
        if (random.chance(0.6)) {
          const value = random.chance(0.4)
            ? undefined
            : random.pick([0, 1, 2, 3, 5]);
          trace.push(`nominate:${index}=${value ?? "UC"}`);
          h.receiveNomination(pair, value);
          const received = value ?? 1;
          if (received > 0)
            nomination.set(pair, Math.max(nomination.get(pair) ?? 0, received));
        } else {
          trace.push(`data:${index}`);
          h.receiveData(pair);
          lastData.set(pair, ++sequence);
        }
        await vi.advanceTimersByTimeAsync(0);

        // Assert: 指名された pair のうち「値 → 最後にデータを受けた順 → 優先度」が最大の pair を使う。
        const expected = pairs
          .filter((p) => (nomination.get(p) ?? 0) > 0)
          .sort(
            (a, b) =>
              nomination.get(b)! - nomination.get(a)! ||
              (lastData.get(b) ?? 0) - (lastData.get(a) ?? 0) ||
              pairs.indexOf(b) - pairs.indexOf(a),
          )[0];
        expect(
          h.connection.nominated,
          `${replay(seed)}; ${trace.join(", ")}`,
        ).toBe(expected);
      }
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

  test("retries back off (1, 2, 4, 8, 16 s) and stop after five", async () => {
    const { h, high } = await selectLowAfterHighFailed();
    const counts: number[] = [];

    try {
      // Act: 再 check をすべて失敗させながら、各間隔の直前と到達時の送信数を記録する。
      for (const delay of [1000, 2000, 4000, 8000, 16000]) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        counts.push(h.requestsTo(high).length);
        await vi.advanceTimersByTimeAsync(1);
        counts.push(h.requestsTo(high).length);
        await h.release(high, "failure");
      }
      // Act: さらに 60 s 進める。
      await vi.advanceTimersByTimeAsync(60_000);

      // Assert: 間隔が倍になり、5 回で止まる。選択は低優先度 pair のまま。
      expect(counts).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
      expect(h.requestsTo(high)).toHaveLength(6);
      expect(h.connection.nominated).not.toBe(high);
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

      // Assert: どちらも再 check を送らない。
      expect(closing.h.requestsTo(closing.high)).toHaveLength(1);
      expect(switching.h.requestsTo(switching.high)).toHaveLength(1);
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
