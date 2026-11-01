import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CandidatePairState } from "../../src";
import {
  createMultiPathPair,
  createNominationHarness,
  createProvisionalRestartPair,
  createRelayProvisionalRestartPair,
  dropNominationResponses,
  ignoreRequestsOn,
  nominationInFlight,
  turnAllocations,
  waitUntil,
} from "../utils";

const LOW = 100;
const MID = 1_000_000;
const HIGH = 2_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("regular nomination of UDP / relay pairs (full ICE, controlling)", () => {
  test("nominates the higher-priority pair even when the lower one succeeds first", async () => {
    const h = createNominationHarness();
    const low = await h.addRemote(LOW);
    const high = await h.addRemote(HIGH);
    h.check(high);
    h.check(low);

    try {
      // Act: 低優先度 pair が先に成功し、その後 deadline 内に高優先度 pair が成功する。
      await h.succeed(low);
      await vi.advanceTimersByTimeAsync(100);
      await h.succeed(high);
      await vi.advanceTimersByTimeAsync(300);

      // Assert: 通常 check には USE-CANDIDATE が付かない。
      expect(h.ordinaryChecks()).toHaveLength(2);
      for (const request of h.ordinaryChecks()) {
        expect(request.message.attributesKeys).not.toContain("USE-CANDIDATE");
      }
      // Assert: nomination は高優先度 pair 宛ての 1 回だけで、高優先度 pair だけが nominate される。
      expect(h.nominations()).toHaveLength(1);
      expect(h.nominations()[0].addr).toEqual(high.remoteAddr);
      expect(h.connection.nominated).toBe(high);
      expect(low.nominated).toBe(false);
    } finally {
      await h.connection.close();
    }
  });

  test("a higher-priority candidate trickled before the deadline joins the nomination", async () => {
    const h = createNominationHarness();
    const low = await h.addRemote(LOW);
    h.check(low);

    try {
      // Act: 低優先度 (relay 相当) pair が成功し、deadline 直前まで進める。
      await h.succeed(low);
      await vi.advanceTimersByTimeAsync(290);

      // Assert: deadline 前は nominate されず、USE-CANDIDATE も送られていない。
      expect(h.connection.nominated).toBeUndefined();
      expect(h.nominations()).toHaveLength(0);

      // Act: 高優先度候補が trickle され、静穏起点が更新される。
      const high = await h.addRemote(HIGH);
      h.check(high);
      await vi.advanceTimersByTimeAsync(200);

      // Assert: 当初の deadline を過ぎても、更新後の deadline 前なので nominate されない。
      expect(h.nominations()).toHaveLength(0);

      // Act: 高優先度 pair の check が成功し、deadline を迎える。
      await h.succeed(high);
      await vi.advanceTimersByTimeAsync(100);

      // Assert: 後から届いた高優先度 pair が nominate される。
      expect(h.nominations()).toHaveLength(1);
      expect(h.connection.nominated).toBe(high);
      expect(low.nominated).toBe(false);
    } finally {
      await h.connection.close();
    }
  });

  test("nominates the valid pair at the deadline without end-of-candidates", async () => {
    const h = createNominationHarness();
    const low = await h.addRemote(LOW);
    h.check(low);

    try {
      // Act: EOC を受け取らないまま、成功後に deadline まで進める。
      await h.succeed(low);
      await vi.advanceTimersByTimeAsync(299);
      const before = h.nominations().length;
      await vi.advanceTimersByTimeAsync(1);

      // Assert: deadline 到達で唯一の valid pair が nominate される。
      expect(before).toBe(0);
      expect(h.nominations()).toHaveLength(1);
      expect(h.connection.nominated).toBe(low);
    } finally {
      await h.connection.close();
    }
  });

  test("orders pairs of different local and remote priorities by the RFC 8445 pair priority", async () => {
    // local 100 / 200 と remote 1000 / 300 の 4 pair。正しい順位は
    // (200,1000) > (200,300) > (100,1000) > (100,300) (MIN が大きい方が上位)。
    const h = createNominationHarness({ localPriorities: [100, 200] });
    const [lowX, highX] = await h.addRemotePairs(1000);
    const [lowY, highY] = await h.addRemotePairs(300);
    await h.connection.addRemoteCandidate(undefined);
    for (const pair of [lowX, highX, lowY, highY]) h.check(pair);

    try {
      // Assert: checklist は MIN(G,D) を優先して並ぶ。
      expect(h.connection.checkList).toEqual([highX, highY, lowX, lowY]);

      // Act: (100,1000) と (200,300) が成功し、残りは失敗する (EOC 済み)。
      await h.succeed(lowX);
      await h.fail(highX);
      await h.fail(lowY);
      await h.succeed(highY);

      // Assert: MAX だけが大きい (100,1000) ではなく (200,300) が nominate される。
      expect(h.nominations()).toHaveLength(1);
      expect(h.connection.nominated).toBe(highY);
      expect(lowX.nominated).toBe(false);
    } finally {
      await h.connection.close();
    }
  });

  test("nominates at once when the only valid pair succeeds after end-of-candidates", async () => {
    const h = createNominationHarness();
    const pair = await h.addRemote(HIGH);
    await h.connection.addRemoteCandidate(undefined);
    h.check(pair);

    try {
      // Act: remote / local とも EOC 済みで、唯一の pair が成功する (timer は進めない)。
      await h.succeed(pair);

      // Assert: 待たずに nominate される。
      expect(h.nominations()).toHaveLength(1);
      expect(h.connection.nominated).toBe(pair);
    } finally {
      await h.connection.close();
    }
  });

  test("does not wait past the deadline for a higher-priority pair still in progress", async () => {
    const h = createNominationHarness();
    const unreachable = await h.addRemote(HIGH);
    const low = await h.addRemote(LOW);
    await h.connection.addRemoteCandidate(undefined);
    h.check(unreachable);
    h.check(low);

    try {
      // Act: 到達不能な高優先度 pair が in-flight のまま、低優先度 pair が成功する。
      await h.succeed(low);

      // Assert: EOC 済みでも上位 pair が未完了なので即時には nominate しない。
      expect(h.nominations()).toHaveLength(0);

      // Act: deadline まで進める。
      await vi.advanceTimersByTimeAsync(300);

      // Assert: 失敗確定を待たず、次点の valid pair が nominate される。
      expect(h.connection.nominated).toBe(low);
      expect(unreachable.state).toBe(CandidatePairState.IN_PROGRESS);
    } finally {
      await h.connection.close();
    }
  });

  test("nominationDelayMs: 0 nominates the first valid pair at once", async () => {
    const h = createNominationHarness({ nominationDelayMs: 0 });
    const high = await h.addRemote(HIGH);
    const low = await h.addRemote(LOW);
    h.check(high);
    h.check(low);

    try {
      // Act: 上位 pair が in-flight のまま低優先度 pair が成功する。
      await h.succeed(low);

      // Assert: 猶予なしで最初の valid pair が nominate される。
      expect(h.nominations()).toHaveLength(1);
      expect(h.connection.nominated).toBe(low);
    } finally {
      await h.connection.close();
    }
  });

  test("an invalid nominationDelayMs falls back to the default delay", async () => {
    const h = createNominationHarness({ nominationDelayMs: -1 });
    const pair = await h.addRemote(HIGH);
    h.check(pair);

    try {
      // Act: 成功後、既定値 (300 ms) の直前と到達時を観測する。
      await h.succeed(pair);
      await vi.advanceTimersByTimeAsync(299);
      const before = h.nominations().length;
      await vi.advanceTimersByTimeAsync(1);

      // Assert: 負値は既定値として扱われる。
      expect(before).toBe(0);
      expect(h.connection.nominated).toBe(pair);
    } finally {
      await h.connection.close();
    }
  });

  test("adding a lower-priority pair does not extend the deadline", async () => {
    const h = createNominationHarness();
    const high = await h.addRemote(HIGH);
    h.check(high);

    try {
      // Act: 高優先度 pair が成功した後、200 ms 経ってから低優先度 pair を追加する。
      await h.succeed(high);
      await vi.advanceTimersByTimeAsync(200);
      await h.addRemote(LOW);
      await vi.advanceTimersByTimeAsync(100);

      // Assert: 最初の valid pair から 300 ms で nominate される (deadline は延びない)。
      expect(h.connection.nominated).toBe(high);
    } finally {
      await h.connection.close();
    }
  });

  test("sends a single USE-CANDIDATE check when several pairs succeed together", async () => {
    const h = createNominationHarness();
    const high = await h.addRemote(HIGH);
    const low = await h.addRemote(LOW);
    await h.connection.addRemoteCandidate(undefined);
    h.check(high);
    h.check(low);

    try {
      // Act: 両方の pair が同時に成功する。
      await h.succeed(low);
      await h.succeed(high);
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: USE-CANDIDATE は 1 回だけで、nominate される pair も 1 つだけ。
      expect(h.nominations()).toHaveLength(1);
      expect(h.connection.nominated).toBe(high);
      expect(h.connection.checkList.filter((p) => p.nominated)).toEqual([high]);
    } finally {
      await h.connection.close();
    }
  });

  test("a nomination rejected with an error response falls back to the next valid pair, one request at a time", async () => {
    const h = createNominationHarness({
      nominationReply: (index) => (index === 0 ? 401 : "success"),
    });
    const high = await h.addRemote(HIGH);
    const low = await h.addRemote(LOW);
    await h.connection.addRemoteCandidate(undefined);
    h.check(high);
    h.check(low);

    try {
      // Act: 両方成功し、最良 pair への nomination が失敗する。
      await h.succeed(low);
      await h.succeed(high);
      await vi.advanceTimersByTimeAsync(0);

      // Assert: 失敗した pair だけ FAILED になり、次点の pair へ nomination が 1 回送られる。
      expect(high.state).toBe(CandidatePairState.FAILED);
      expect(h.nominations().map((request) => request.addr)).toEqual([
        high.remoteAddr,
        low.remoteAddr,
      ]);
      expect(h.connection.nominated).toBe(low);
      expect(high.nominated).toBe(false);
    } finally {
      await h.connection.close();
    }
  });

  test("an unanswered nomination is repeated on the same pair, never moved to another", async () => {
    const h = createNominationHarness({ nominationReply: () => "hold" });
    const high = await h.addRemote(HIGH);
    const low = await h.addRemote(LOW);
    await h.connection.addRemoteCandidate(undefined);
    h.check(high);
    h.check(low);
    const states: string[] = [];
    h.connection.stateChanged.subscribe((state) => states.push(state));

    try {
      await h.succeed(low);
      await h.succeed(high);

      // Act: 最良 pair への nomination が応答なしでタイムアウトする (相手は受理済みかもしれない)。
      h.nominations()[0].release("failure");
      await vi.advanceTimersByTimeAsync(0);

      // Assert: 次点へ切り替えず、同じ pair へ USE-CANDIDATE を送り直す。
      expect(h.nominations().map((request) => request.addr)).toEqual([
        high.remoteAddr,
        high.remoteAddr,
      ]);
      expect(h.connection.nominated).toBeUndefined();

      // Act: 再送した nomination には応答が届く。
      h.nominations()[1].release("success");
      await vi.advanceTimersByTimeAsync(0);

      // Assert: 同じ pair が nominate され、次点の pair には一度も USE-CANDIDATE を送らない。
      expect(h.connection.nominated).toBe(high);
      expect(low.nominated).toBe(false);
      expect(states).not.toContain("failed");
    } finally {
      await h.connection.close();
    }
  });

  test("gives up without nominating another pair when every nomination goes unanswered", async () => {
    const h = createNominationHarness({ nominationReply: () => "hold" });
    const high = await h.addRemote(HIGH);
    const low = await h.addRemote(LOW);
    await h.connection.addRemoteCandidate(undefined);
    h.check(high);
    h.check(low);
    await h.succeed(low);
    await h.succeed(high);

    try {
      // Act: 同じ pair への nomination が 3 回ともタイムアウトする。
      for (let attempt = 0; attempt < 3; attempt++) {
        h.nominations()[attempt].release("failure");
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: 次点の pair を nominate せず、agent は failed になる (ICE restart で回復する)。
      expect(h.nominations()).toHaveLength(3);
      expect(h.nominations().map((request) => request.addr)).toEqual(
        Array(3).fill(high.remoteAddr),
      );
      expect(h.connection.nominated).toBeUndefined();
      expect(low.nominated).toBe(false);
      expect(h.connection.state).toBe("failed");
    } finally {
      await h.connection.close();
    }
  });

  test("an error answering a repeated nomination does not move it to another pair", async () => {
    // 1 回目は応答なし、再送 2 回はエラー応答 (401) を返す。
    const h = createNominationHarness({
      nominationReply: (index) => (index === 0 ? "hold" : 401),
    });
    const high = await h.addRemote(HIGH);
    const low = await h.addRemote(LOW);
    await h.connection.addRemoteCandidate(undefined);
    h.check(high);
    h.check(low);
    await h.succeed(low);
    await h.succeed(high);

    try {
      // Act: 最初の nomination がタイムアウトし、その後の再送はエラーで終わる。
      h.nominations()[0].release("failure");
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: 最初の要求が受理済みかもしれないので、次点の pair へは切り替えない。
      expect(h.nominations().map((request) => request.addr)).toEqual(
        Array(3).fill(high.remoteAddr),
      );
      expect(low.nominated).toBe(false);
      expect(h.connection.nominated).toBeUndefined();
      expect(h.connection.state).toBe("failed");
    } finally {
      await h.connection.close();
    }
  });

  test("a role change invalidates the nomination in flight (late success)", async () => {
    const h = createNominationHarness({ nominationReply: () => "hold" });
    const pair = await h.addRemote(HIGH);
    await h.connection.addRemoteCandidate(undefined);
    h.check(pair);
    await h.succeed(pair);
    const [nomination] = h.nominations();

    try {
      // Act: nomination の応答待ち中に controlled へ切り替わる。
      h.switchRole(false);
      await vi.advanceTimersByTimeAsync(0);

      // Assert: 送信中の nomination transaction は取り消される。
      expect(nomination.done).toBe(true);

      // Act: 取り消し後に古い応答相当の成功が届いても無視される (release は no-op)。
      nomination.release("success");
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: 古い nomination で pair は nominate されず、再送も追加の USE-CANDIDATE もない。
      expect(pair.nominated).toBe(false);
      expect(h.connection.nominated).toBeUndefined();
      expect(h.nominations()).toHaveLength(1);
      expect(h.connection.iceControlling).toBe(false);
    } finally {
      await h.connection.close();
    }
  });

  test("a nomination response that arrives after a role change selects nothing", async () => {
    // 取り消しを無視して応答が後から届く (応答がネットワーク上にあった) ケース。
    const h = createNominationHarness({
      nominationReply: () => "hold",
      honorSignal: false,
    });
    const pair = await h.addRemote(HIGH);
    await h.connection.addRemoteCandidate(undefined);
    h.check(pair);
    await h.succeed(pair);

    try {
      // Act: controlled へ切り替わった後に、古い nomination の成功応答が届く。
      h.switchRole(false);
      h.nominations()[0].release("success");
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: 古いロールの nomination では pair は選ばれない。
      expect(pair.nominated).toBe(false);
      expect(h.connection.nominated).toBeUndefined();
      expect(h.nominations()).toHaveLength(1);
    } finally {
      await h.connection.close();
    }
  });

  test("an unanswered nomination that times out after a role change does not fail the agent", async () => {
    const h = createNominationHarness({
      nominationReply: () => "hold",
      honorSignal: false,
    });
    const pair = await h.addRemote(HIGH);
    await h.connection.addRemoteCandidate(undefined);
    h.check(pair);
    await h.succeed(pair);

    try {
      // Act: controlled へ切り替わった後に、古い nomination がタイムアウトする。
      const sent = h.requests().length;
      h.switchRole(false);
      // 古い nomination と、その後に出うる要求をすべてタイムアウトさせる。
      for (let round = 0; round < 3; round++) await h.timeOutPending();
      await vi.advanceTimersByTimeAsync(5000);

      // Assert: 再送も断念もせず、pair は valid のまま agent は failed にならない。
      expect(h.requests()).toHaveLength(sent);
      expect(pair.state).toBe(CandidatePairState.SUCCEEDED);
      expect(h.connection.state).not.toBe("failed");
    } finally {
      await h.connection.close();
    }
  });

  test("a role change stops an unanswered nomination from failing the agent", async () => {
    const h = createNominationHarness({ nominationReply: () => "hold" });
    const high = await h.addRemote(HIGH);
    const low = await h.addRemote(LOW);
    await h.connection.addRemoteCandidate(undefined);
    h.check(high);
    h.check(low);
    await h.succeed(low);
    await h.succeed(high);

    try {
      // Act: 1 回目の nomination がタイムアウトして再送中に controlled へ切り替わり、
      // 新しい controlling 側 (相手) が低優先度 pair を nominate する。
      h.nominations()[0].release("failure");
      await vi.advanceTimersByTimeAsync(0);
      const sent = h.requests().length;
      h.switchRole(false);
      h.receiveNomination(low);
      // 残っている要求 (古い再送を含む) をすべてタイムアウトさせる。
      for (let round = 0; round < 3; round++) await h.timeOutPending();
      await vi.advanceTimersByTimeAsync(5000);

      // Assert: 相手の選択に従い、古い nomination の再送・断念で failed にならない。
      expect(h.connection.nominated).toBe(low);
      expect(h.requests()).toHaveLength(sent);
      expect(h.connection.state).not.toBe("failed");
      expect(high.state).toBe(CandidatePairState.SUCCEEDED);
    } finally {
      await h.connection.close();
    }
  });

  test("a 487 answering a nomination switches to controlled and keeps the pair valid", async () => {
    const h = createNominationHarness({ nominationReply: () => 487 });
    const pair = await h.addRemote(HIGH);
    await h.connection.addRemoteCandidate(undefined);
    h.check(pair);

    try {
      // Act: nomination が 487 Role Conflict で拒否される。
      await h.succeed(pair);
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: controlled へ切り替わり、pair は valid のまま、追加の nomination も送らない。
      expect(h.connection.iceControlling).toBe(false);
      expect(pair.state).toBe(CandidatePairState.SUCCEEDED);
      expect(h.nominations()).toHaveLength(1);
      expect(h.connection.nominated).toBeUndefined();

      // Act: 新しい controlling 側 (相手) が同じ pair を nominate する。
      h.receiveNomination(pair);

      // Assert: controlled として相手の nomination を受け入れ、接続が成立する。
      expect(h.connection.nominated).toBe(pair);
    } finally {
      await h.connection.close();
    }
  });

  test("a restart after an abandoned nomination nominates again", async () => {
    const h = createNominationHarness({
      nominationReply: (index) => (index < 3 ? "hold" : "success"),
    });
    const first = await h.addRemote(HIGH);
    await h.connection.addRemoteCandidate(undefined);
    h.check(first);
    await h.succeed(first);
    for (let attempt = 0; attempt < 3; attempt++) {
      h.nominations()[attempt].release("failure");
      await vi.advanceTimersByTimeAsync(0);
    }

    try {
      // Act: ICE restart 後、新しい世代で pair が成功する。
      await h.connection.restart();
      h.connection.remoteUsername = "remote";
      h.connection.remotePassword = "remote-password-0000000000";
      h.connection.localCandidatesEnd = true;
      const next = await h.addRemote(HIGH);
      await h.connection.addRemoteCandidate(undefined);
      h.check(next);
      await h.succeed(next);

      // Assert: 断念状態は世代とともに解除され、新しい pair が nominate される。
      expect(h.connection.nominated).toBe(next);
    } finally {
      await h.connection.close();
    }
  });

  test.each(["restart", "close"] as const)(
    "%s while waiting for the deadline cancels the nomination",
    async (operation) => {
      const h = createNominationHarness();
      const pair = await h.addRemote(HIGH);
      h.check(pair);
      await h.succeed(pair);

      try {
        // Act: deadline 待機中に restart / close する。
        if (operation === "restart") await h.connection.restart();
        else await h.connection.close();
        await vi.advanceTimersByTimeAsync(1000);

        // Assert: 古い世代の pair は nominate されず、USE-CANDIDATE も送られない。
        expect(h.nominations()).toHaveLength(0);
        expect(h.connection.nominated).toBeUndefined();
        expect(pair.nominated).toBe(false);
      } finally {
        await h.connection.close();
      }
    },
  );

  test("an ICE-lite peer still gets USE-CANDIDATE on the first pair that succeeds", async () => {
    const h = createNominationHarness({ remoteIsLite: true });
    const high = await h.addRemote(HIGH);
    const low = await h.addRemote(LOW);
    h.check(high);
    h.check(low);

    try {
      // Act: 上位 pair が in-flight のまま低優先度 pair が成功する (timer は進めない)。
      await h.succeed(low);

      // Assert: 従来どおり最初の成功 pair に専用 USE-CANDIDATE を送って nominate する。
      expect(h.nominations()).toHaveLength(1);
      expect(h.connection.nominated).toBe(low);
    } finally {
      await h.connection.close();
    }
  });
});

describe("a nomination in flight when its checklist ends", () => {
  test.each(
    (
      ["restart", "restartRemote", "resetNominatedPair", "close"] as const
    ).flatMap((operation) => [
      { operation, attempt: 1 },
      { operation, attempt: 2 },
    ]),
  )(
    "$operation during attempt $attempt: the late answer selects nothing",
    async ({ operation, attempt }) => {
      // 応答は signal の中止後にも届く (遅れて届く成功応答)。
      const h = createNominationHarness({
        nominationReply: () => "hold",
        honorSignal: false,
      });
      const pair = await h.addRemote(HIGH);
      await h.connection.addRemoteCandidate(undefined);
      h.check(pair);
      await h.succeed(pair);
      if (attempt === 2) {
        // 1 回目が応答なしで終わり、同じ pair への再送 (受理済みかもしれない状態) が in-flight。
        h.nominations()[0].release("failure");
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(h.nominations()).toHaveLength(attempt);

      try {
        // Act: nomination の応答待ちのまま checklist を終わらせ、その後に成功応答が届く。
        if (operation === "close") await h.connection.close();
        else if (operation === "restart") await h.connection.restart();
        else h.connection[operation]();
        h.nominations()[attempt - 1].release("success");
        await vi.advanceTimersByTimeAsync(10_000);

        // Assert: 古い pair は nominate されず、再送も新しい nomination も送られず、in-flight も残らない。
        expect(h.connection.nominated).toBeUndefined();
        expect(pair.nominated).toBe(false);
        expect(h.nominations()).toHaveLength(attempt);
        expect(nominationInFlight(h.connection)).toBe(false);
      } finally {
        await h.connection.close();
      }
    },
  );

  test.each([
    "a replacement pranswer",
    "discarding the staged credentials",
    "the final answer",
    "close",
  ] as const)(
    "a provisional nomination in flight selects nothing after %s",
    async (operation) => {
      const h = createNominationHarness({
        nominationReply: () => "hold",
        honorSignal: false,
      });
      h.stageProvisional();
      const pair = await h.addProvisionalRemote(HIGH);
      await h.connection.addProvisionalRemoteCandidate(undefined);
      await h.succeed(pair);
      expect(h.nominations()).toHaveLength(1);

      try {
        // Act: provisional の nomination の応答待ちのまま checklist を終わらせ、その後に成功応答が届く。
        if (operation === "a replacement pranswer")
          h.replaceProvisionalRemote();
        else if (operation === "discarding the staged credentials") {
          h.connection.discardStagedLocalCredentials("provA");
        } else if (operation === "the final answer") await h.finalAnswer();
        else await h.connection.close();
        h.nominations()[0].release("success");
        await vi.advanceTimersByTimeAsync(10_000);

        // Assert: provisional・live とも何も選択されず、追加の nomination も送られない。
        expect(h.connection.provisionalNominated).toBeUndefined();
        expect(pair.nominated).toBe(false);
        expect(h.connection.nominated).toBeUndefined();
        expect(h.nominations()).toHaveLength(1);
      } finally {
        await h.connection.close();
      }
    },
  );

  test("a nomination answered after its pair left the checklist moves on to the remaining pairs", async () => {
    const h = createNominationHarness({
      nominationReply: (index) => (index === 0 ? "hold" : "success"),
      honorSignal: false,
    });
    const high = await h.addRemote(HIGH);
    const low = await h.addRemote(LOW);
    high.remoteCandidate.ufrag = "previous";
    await h.connection.addRemoteCandidate(undefined);
    h.check(high);
    h.check(low);
    await h.succeed(low);
    await h.succeed(high);
    expect(h.nominations().map((request) => request.addr)).toEqual([
      high.remoteAddr,
    ]);

    try {
      // Act: 別の remote generation の pair として high が checklist から外れ、その後に nomination の応答が届く。
      h.connection.dropOtherRemoteGenerations("remote");
      h.nominations()[0].release("success");
      await vi.advanceTimersByTimeAsync(0);

      // Assert: 外れた pair は選ばれず、nomination 待ちのまま止まらずに残った pair が nominate される。
      expect(high.nominated).toBe(false);
      expect(h.nominations().map((request) => request.addr)).toEqual([
        high.remoteAddr,
        low.remoteAddr,
      ]);
      expect(h.connection.nominated).toBe(low);
    } finally {
      await h.connection.close();
    }
  });
});

describe("regular nomination under forceTurn", () => {
  test("a trickled host pair, which forceTurn never checks, does not extend the deadline", async () => {
    // relay 相当の local (低優先度) と forceTurn で check しない host の local。
    const h = createNominationHarness({
      forceTurn: true,
      localPriorities: [LOW, HIGH],
      localTypes: [undefined, "stun"],
    });
    const [relay] = await h.addRemotePairs(HIGH);
    h.check(relay);

    try {
      // Act: relay pair が成功し、deadline 直前に「host とは最良 pair を上回る pair、relay とは下回る pair」を作る候補が届く。
      await h.succeed(relay);
      await vi.advanceTimersByTimeAsync(290);
      const [relayLower, host] = await h.addRemotePairs(MID);
      await vi.advanceTimersByTimeAsync(20);

      // Assert: 前提として host pair は最良 pair を上回り、relay 側の新 pair は下回る。
      const order = h.connection.checkList;
      expect(order.indexOf(host)).toBeLessThan(order.indexOf(relay));
      expect(order.indexOf(relayLower)).toBeGreaterThan(order.indexOf(relay));
      // Assert: check されない host pair は deadline を延ばさず、当初の deadline で relay pair が nominate される。
      expect(host.requestsSent).toBe(0);
      expect(h.nominations().map((request) => request.addr)).toEqual([
        relay.remoteAddr,
      ]);
      expect(h.connection.nominated).toBe(relay);
    } finally {
      await h.connection.close();
    }
  });

  test("a trickled provisional host pair is neither checked nor extends the deadline", async () => {
    const h = createNominationHarness({
      forceTurn: true,
      localPriorities: [LOW, HIGH],
      localTypes: [undefined, "stun"],
    });
    h.stageProvisional();
    const [relay] = await h.addProvisionalRemotePairs(HIGH);

    try {
      // Act: provisional の relay pair が成功し、deadline 直前に上位の host pair を作る候補が届く。
      await h.succeed(relay);
      await vi.advanceTimersByTimeAsync(290);
      const [, host] = await h.addProvisionalRemotePairs(MID);
      await vi.advanceTimersByTimeAsync(20);

      // Assert: forceTurn generation では host pair 自体が候補外となり、relay pair が nominate される。
      expect(host).toBeUndefined();
      expect(h.nominations().map((request) => request.addr)).toEqual([
        relay.remoteAddr,
      ]);
      expect(h.connection.provisionalNominated).toBe(relay);
    } finally {
      await h.connection.close();
    }
  });
});

describe("the final answer after a provisional nomination", () => {
  test.each([
    { reply: "hold", outcome: "unanswered" },
    { reply: "success", outcome: "answered" },
  ] as const)(
    "the live checklist prefers the pair of an $outcome provisional nomination",
    async ({ reply }) => {
      const h = createNominationHarness({
        nominationReply: (index) => (index === 0 ? reply : "success"),
      });
      h.stageProvisional();
      const provisional = await h.addProvisionalRemote(LOW);
      await h.connection.addProvisionalRemoteCandidate(undefined);
      await h.succeed(provisional);
      expect(h.nominations()).toHaveLength(1);

      try {
        // Act: pranswer と同じ資格情報の final answer を適用し、より高優先度の pair を含む live checklist で check する。
        await h.finalAnswer();
        const high = await h.addRemote(HIGH);
        const same = await h.addRemoteLike(provisional);
        await h.connection.addRemoteCandidate(undefined);
        h.check(high);
        h.check(same);
        await h.succeed(high);
        await vi.advanceTimersByTimeAsync(1000);

        // Assert: provisional で nominate した 5-tuple の check が終わるまで、高優先度 pair を nominate しない。
        expect(h.nominations()).toHaveLength(1);
        expect(h.connection.nominated).toBeUndefined();

        // Act: provisional と同じ 5-tuple の check が成功する。
        await h.succeed(same);

        // Assert: その pair (provisional とは別の pair object) が nominate される。
        expect(h.nominations().map((request) => request.addr)).toEqual([
          provisional.remoteAddr,
          same.remoteAddr,
        ]);
        expect(h.connection.nominated).toBe(same);
        expect(h.connection.nominated).not.toBe(provisional);
      } finally {
        await h.connection.close();
      }
    },
  );

  test("gives up without nominating another pair when the preferred pair fails", async () => {
    const h = createNominationHarness({
      nominationReply: (index) => (index === 0 ? "hold" : "success"),
    });
    h.stageProvisional();
    const provisional = await h.addProvisionalRemote(LOW);
    await h.connection.addProvisionalRemoteCandidate(undefined);
    await h.succeed(provisional);

    try {
      // Act: final answer の後、高優先度 pair は成功し、provisional と同じ 5-tuple の check だけが失敗する。
      await h.finalAnswer();
      const high = await h.addRemote(HIGH);
      const same = await h.addRemoteLike(provisional);
      await h.connection.addRemoteCandidate(undefined);
      h.check(high);
      h.check(same);
      await h.succeed(high);
      await h.fail(same);
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: 相手が provisional の pair を選択済みかもしれないため、別の valid pair は nominate せず、agent は failed になる。
      expect(h.nominations().map((request) => request.addr)).toEqual([
        provisional.remoteAddr,
      ]);
      expect(high.nominated).toBe(false);
      expect(h.connection.nominated).toBeUndefined();
      expect(h.connection.state).toBe("failed");
    } finally {
      await h.connection.close();
    }
  });

  test.each([
    { case: "by the deadline", endOfCandidates: false },
    { case: "after end-of-candidates", endOfCandidates: true },
  ] as const)(
    "gives up when the preferred pair is not in the checklist $case",
    async ({ endOfCandidates }) => {
      const h = createNominationHarness({
        nominationReply: (index) => (index === 0 ? "hold" : "success"),
      });
      h.stageProvisional();
      const provisional = await h.addProvisionalRemote(LOW);
      await h.connection.addProvisionalRemoteCandidate(undefined);
      await h.succeed(provisional);

      try {
        // Act: final answer が provisional の pair と同じ 5-tuple を含まず、別の pair だけが成功する。
        await h.finalAnswer();
        const high = await h.addRemote(HIGH);
        if (endOfCandidates) await h.connection.addRemoteCandidate(undefined);
        h.check(high);
        await h.succeed(high);
        await vi.advanceTimersByTimeAsync(2900);

        // Assert: EOC 後も、受信 check で pair が現れうる間 (最初の valid pair から 3 秒) は失敗しない。
        expect(h.connection.state).not.toBe("failed");
        expect(h.nominations()).toHaveLength(1);

        // Act: その待機時間が尽きる。
        await vi.advanceTimersByTimeAsync(100);

        // Assert: 別の pair を nominate せずに failed になる。
        expect(h.nominations()).toHaveLength(1);
        expect(high.nominated).toBe(false);
        expect(h.connection.nominated).toBeUndefined();
        expect(h.connection.state).toBe("failed");
      } finally {
        await h.connection.close();
      }
    },
  );

  test("a preferred pair whose local socket the commit closed is not waited for: the usual rule nominates", async () => {
    // local0 / local1 の 2 つのソケットを持つ。
    const h = createNominationHarness({
      nominationReply: (index) => (index === 0 ? "hold" : "success"),
      localPriorities: [undefined, undefined],
    });
    h.stageProvisional();
    const provisional = await h.addProvisionalRemote(LOW);
    await h.connection.addProvisionalRemoteCandidate(undefined);
    await h.succeed(provisional);
    expect(h.nominations()).toHaveLength(1);

    try {
      // Act: final answer の確定で provisional の pair のソケット (local0) が閉じられ、残るソケットの pair だけが成功する。
      await h.finalAnswer();
      h.dropLocalSocketOf(provisional);
      const [gone, kept] = await h.addRemotePairs(HIGH);
      await h.connection.addRemoteCandidate(undefined);
      h.check(kept);
      await h.succeed(kept);

      // Assert: 経路は両端で失われているので待たず (3 秒の待機も断念もせず)、通常の規則で残る pair が即 nominate される。
      expect(gone).toBeUndefined();
      expect(h.nominations().map((request) => request.addr)).toEqual([
        provisional.remoteAddr,
        kept.remoteAddr,
      ]);
      expect(h.connection.nominated).toBe(kept);
      expect(h.connection.state).not.toBe("failed");
    } finally {
      await h.connection.close();
    }
  });

  test("an empty checklist after end-of-candidates waits for the preferred pair, then gives up", async () => {
    const h = createNominationHarness({
      nominationReply: (index) => (index === 0 ? "hold" : "success"),
    });
    h.stageProvisional();
    const provisional = await h.addProvisionalRemote(LOW);
    await h.connection.addProvisionalRemoteCandidate(undefined);
    await h.succeed(provisional);

    try {
      // Act: final answer が候補なしで end-of-candidates だけを届ける。
      await h.finalAnswer();
      await h.connection.addRemoteCandidate(undefined);
      await vi.advanceTimersByTimeAsync(2900);

      // Assert: 空の checklist でも、受信 check で pair が現れうる間は失敗しない。
      expect(h.connection.checkList).toHaveLength(0);
      expect(h.connection.state).not.toBe("failed");

      // Act: 待機時間が尽きる。
      await vi.advanceTimersByTimeAsync(100);

      // Assert: 別の pair を nominate せずに failed になる。
      expect(h.nominations()).toHaveLength(1);
      expect(h.connection.state).toBe("failed");
    } finally {
      await h.connection.close();
    }
  });

  test("nominates the preferred path when it reappears as a peer-reflexive pair after end-of-candidates", async () => {
    const h = createNominationHarness({
      nominationReply: (index) => (index === 0 ? "hold" : "success"),
    });
    h.stageProvisional();
    const provisional = await h.addProvisionalRemote(LOW);
    await h.connection.addProvisionalRemoteCandidate(undefined);
    await h.succeed(provisional);

    try {
      // Act: final answer は provisional の経路の候補を含まずに end-of-candidates まで届き、別の pair が成功する。
      await h.finalAnswer();
      const high = await h.addRemote(HIGH);
      await h.connection.addRemoteCandidate(undefined);
      h.check(high);
      await h.succeed(high);
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: end-of-candidates 後でも即座には断念せず、別の pair も nominate しない。
      expect(h.connection.state).not.toBe("failed");
      expect(h.nominations()).toHaveLength(1);

      // Act: 相手の check が provisional と同じ経路から届き、peer-reflexive の pair として再生成され、その triggered check が成功する。
      const reflexive = h.receiveCheckLike(provisional);
      await h.succeed(reflexive);

      // Assert: 再生成された同じ経路の pair が nominate される。
      expect(reflexive.remoteCandidate.type).toBe("prflx");
      expect(h.nominations().map((request) => request.addr)).toEqual([
        provisional.remoteAddr,
        provisional.remoteAddr,
      ]);
      expect(h.connection.nominated).toBe(reflexive);
      expect(high.nominated).toBe(false);
    } finally {
      await h.connection.close();
    }
  });

  test.each([
    { case: "other remote credentials", reply: "hold", remote: "other" },
    { case: "a rejected provisional nomination", reply: 401, remote: "same" },
  ] as const)("prefers no pair after $case", async ({ reply, remote }) => {
    const h = createNominationHarness({
      nominationReply: (index) => (index === 0 ? reply : "success"),
    });
    h.stageProvisional();
    const provisional = await h.addProvisionalRemote(LOW);
    await h.connection.addProvisionalRemoteCandidate(undefined);
    await h.succeed(provisional);

    try {
      // Act: final answer を適用し、高優先度 pair だけが成功する。
      await h.finalAnswer(
        remote === "other"
          ? {
              usernameFragment: "other",
              password: "other-password-00000000000",
            }
          : {},
      );
      const high = await h.addRemote(HIGH);
      const same = await h.addRemoteLike(provisional);
      await h.connection.addRemoteCandidate(undefined);
      h.check(high);
      h.check(same);
      await h.succeed(high);

      // Assert: 引き継ぐ pair はなく、同じ 5-tuple の check を待たずに最良 pair が即 nominate される。
      expect(same.state).toBe(CandidatePairState.IN_PROGRESS);
      expect(h.nominations().at(-1)!.addr).toEqual(high.remoteAddr);
      expect(h.connection.nominated).toBe(high);
    } finally {
      await h.connection.close();
    }
  });
});

describe("regular nomination of the provisional generation", () => {
  test("ordinary provisional checks carry no USE-CANDIDATE and the higher-priority pair wins", async () => {
    const h = createNominationHarness();
    h.stageProvisional();
    const low = await h.addProvisionalRemote(LOW);
    const high = await h.addProvisionalRemote(HIGH);

    try {
      // Act: 低優先度 pair が先に成功し、deadline 内に高優先度 pair が成功する。
      await h.succeed(low);
      await vi.advanceTimersByTimeAsync(100);
      await h.succeed(high);
      await vi.advanceTimersByTimeAsync(300);

      // Assert: 通常 check に USE-CANDIDATE は付かず、高優先度 pair にだけ 1 回送られる。
      for (const request of h.ordinaryChecks()) {
        expect(request.message.attributesKeys).not.toContain("USE-CANDIDATE");
      }
      expect(h.nominations()).toHaveLength(1);
      expect(h.nominations()[0].addr).toEqual(high.remoteAddr);
      expect(h.connection.provisionalNominated).toBe(high);
      // live 側の選択には影響しない。
      expect(h.connection.nominated).toBeUndefined();
    } finally {
      await h.connection.close();
    }
  });

  test("a trickled higher-priority provisional candidate restarts the delay", async () => {
    const h = createNominationHarness();
    h.stageProvisional();
    const low = await h.addProvisionalRemote(LOW);

    try {
      // Act: 低優先度 pair が成功し、deadline 直前に高優先度候補を追加する。
      await h.succeed(low);
      await vi.advanceTimersByTimeAsync(290);
      const high = await h.addProvisionalRemote(HIGH);
      await vi.advanceTimersByTimeAsync(200);

      // Assert: 更新後の deadline 前は nominate されない。
      expect(h.nominations()).toHaveLength(0);

      // Act: 高優先度 pair が成功し、deadline を迎える。
      await h.succeed(high);
      await vi.advanceTimersByTimeAsync(100);

      // Assert: 後から届いた高優先度 pair が nominate される。
      expect(h.connection.provisionalNominated).toBe(high);
    } finally {
      await h.connection.close();
    }
  });

  test("does not wait past the deadline for a provisional pair still in progress", async () => {
    const h = createNominationHarness();
    h.stageProvisional();
    const unreachable = await h.addProvisionalRemote(HIGH);
    const low = await h.addProvisionalRemote(LOW);
    await h.connection.addProvisionalRemoteCandidate(undefined);

    try {
      // Act: 上位 pair が in-flight のまま低優先度 pair が成功し、deadline まで進める。
      await h.succeed(low);
      const before = h.nominations().length;
      await vi.advanceTimersByTimeAsync(300);

      // Assert: EOC 済みでも上位が未完了なら待ち、deadline で次点が nominate される。
      expect(before).toBe(0);
      expect(h.connection.provisionalNominated).toBe(low);
      expect(unreachable.state).toBe(CandidatePairState.IN_PROGRESS);
    } finally {
      await h.connection.close();
    }
  });

  test("a provisional nomination rejected with an error response falls back to the next valid pair", async () => {
    const h = createNominationHarness({
      nominationReply: (index) => (index === 0 ? 401 : "success"),
    });
    h.stageProvisional();
    const high = await h.addProvisionalRemote(HIGH);
    const low = await h.addProvisionalRemote(LOW);
    await h.connection.addProvisionalRemoteCandidate(undefined);

    try {
      // Act: 両方成功し、最良 pair への provisional nomination がエラー応答で拒否される。
      await h.succeed(low);
      await h.succeed(high);
      await vi.advanceTimersByTimeAsync(0);

      // Assert: live と同じく拒否された pair だけ FAILED になり、次点へ 1 回だけ nomination が送られる。
      expect(high.state).toBe(CandidatePairState.FAILED);
      expect(h.nominations().map((request) => request.addr)).toEqual([
        high.remoteAddr,
        low.remoteAddr,
      ]);
      expect(h.connection.provisionalNominated).toBe(low);
    } finally {
      await h.connection.close();
    }
  });

  test("an unanswered provisional nomination is repeated on the same pair", async () => {
    const h = createNominationHarness({ nominationReply: () => "hold" });
    h.stageProvisional();
    const high = await h.addProvisionalRemote(HIGH);
    const low = await h.addProvisionalRemote(LOW);
    await h.connection.addProvisionalRemoteCandidate(undefined);
    await h.succeed(low);
    await h.succeed(high);

    try {
      // Act: provisional の nomination が 3 回とも応答なしで終わる。
      for (let attempt = 0; attempt < 3; attempt++) {
        h.nominations()[attempt].release("failure");
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: 送り先は常に同じ pair で、次点の pair は nominate しない。
      expect(h.nominations()).toHaveLength(3);
      expect(h.nominations().map((request) => request.addr)).toEqual(
        Array(3).fill(high.remoteAddr),
      );
      expect(h.connection.provisionalNominated).toBeUndefined();
      expect(low.nominated).toBe(false);
    } finally {
      await h.connection.close();
    }
  });

  test("an error answering a repeated provisional nomination does not move it to another pair", async () => {
    const h = createNominationHarness({
      nominationReply: (index) => (index === 0 ? "hold" : 401),
    });
    h.stageProvisional();
    const high = await h.addProvisionalRemote(HIGH);
    const low = await h.addProvisionalRemote(LOW);
    await h.connection.addProvisionalRemoteCandidate(undefined);
    await h.succeed(low);
    await h.succeed(high);

    try {
      // Act: 最初の provisional nomination がタイムアウトし、再送はエラーで終わる。
      h.nominations()[0].release("failure");
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: 送り先は同じ pair のままで、次点の pair は nominate しない。
      expect(h.nominations().map((request) => request.addr)).toEqual(
        Array(3).fill(high.remoteAddr),
      );
      expect(low.nominated).toBe(false);
      expect(h.connection.provisionalNominated).toBeUndefined();
    } finally {
      await h.connection.close();
    }
  });

  test("a role change invalidates a provisional nomination in flight", async () => {
    const h = createNominationHarness({ nominationReply: () => "hold" });
    h.stageProvisional();
    const pair = await h.addProvisionalRemote(HIGH);
    await h.connection.addProvisionalRemoteCandidate(undefined);
    await h.succeed(pair);
    const [nomination] = h.nominations();

    try {
      // Act: provisional nomination の応答待ち中に controlled へ切り替わる。
      h.switchRole(false);
      nomination.release("success");
      await vi.advanceTimersByTimeAsync(5000);

      // Assert: transaction は取り消され、古い nomination は provisional pair を選ばない。
      expect(nomination.done).toBe(true);
      expect(pair.nominated).toBe(false);
      expect(h.connection.provisionalNominated).toBeUndefined();
      expect(h.nominations()).toHaveLength(1);
    } finally {
      await h.connection.close();
    }
  });

  test("a 487 answering a provisional nomination switches to controlled", async () => {
    const h = createNominationHarness({ nominationReply: () => 487 });
    h.stageProvisional();
    const pair = await h.addProvisionalRemote(HIGH);
    await h.connection.addProvisionalRemoteCandidate(undefined);

    try {
      // Act: provisional nomination が 487 Role Conflict で拒否される。
      await h.succeed(pair);
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: controlled へ切り替わり、pair は valid のまま、再 nomination しない。
      expect(h.connection.iceControlling).toBe(false);
      expect(pair.state).toBe(CandidatePairState.SUCCEEDED);
      expect(h.nominations()).toHaveLength(1);
      expect(h.connection.provisionalNominated).toBeUndefined();
    } finally {
      await h.connection.close();
    }
  });

  test("a replacement pranswer invalidates the pending nomination timer", async () => {
    const h = createNominationHarness();
    h.stageProvisional();
    const pair = await h.addProvisionalRemote(HIGH);

    try {
      // Act: 成功後の deadline 待機中に置換 pranswer (revision 更新) を受け取る。
      await h.succeed(pair);
      h.replaceProvisionalRemote();
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: 旧 checklist の pair は nominate されず、USE-CANDIDATE も送られない。
      expect(h.nominations()).toHaveLength(0);
      expect(h.connection.provisionalNominated).toBeUndefined();
      expect(pair.nominated).toBe(false);
    } finally {
      await h.connection.close();
    }
  });
});

describe("nomination over real sockets", () => {
  test("both agents select the same pair when the first nomination response is lost", async () => {
    vi.useRealTimers();
    const { a, b } = await createMultiPathPair();
    // b は最初の USE-CANDIDATE を処理する (pair を選択しうる) が、その応答だけを失う。
    const loss = dropNominationResponses(b);

    try {
      // Act: 両端で ICE を実行する。
      await Promise.all([a.connect(), b.connect()]);

      // Assert: 前提として有効な pair が複数あり、nomination の応答が実際に失われている。
      expect(
        a.checkList.filter(
          (pair) =>
            pair.state === CandidatePairState.SUCCEEDED ||
            pair.nominated ||
            pair.state === CandidatePairState.FAILED,
        ).length,
      ).toBeGreaterThanOrEqual(2);
      expect(loss.dropped.size).toBe(1);

      // Assert: controlling 側と controlled 側が同じ 5-tuple を選択している。
      expect(a.nominated?.localCandidate.host).toBe(b.nominated?.remoteAddr[0]);
      expect(a.nominated?.localCandidate.port).toBe(b.nominated?.remoteAddr[1]);
      expect(a.nominated?.remoteAddr[0]).toBe(b.nominated?.localCandidate.host);
      expect(a.nominated?.remoteAddr[1]).toBe(b.nominated?.localCandidate.port);
    } finally {
      await a.close();
      await b.close();
    }
  }, 20_000);

  test("connect() rejects when every nomination response is lost", async () => {
    vi.useRealTimers();
    const { a, b } = await createMultiPathPair();
    // b はすべての USE-CANDIDATE を処理するが、その応答はすべて失われる。
    dropNominationResponses(b, Number.POSITIVE_INFINITY);

    try {
      // Act: 両端で ICE を実行する。
      const connecting = a.connect();
      void b.connect().catch(() => {});

      // Assert: controlling 側の connect() は待ち続けずに拒否され、state は failed。
      await expect(connecting).rejects.toThrow("ICE negotiation failed");
      expect(a.state).toBe("failed");
      expect(a.nominated).toBeUndefined();
    } finally {
      await a.close();
      await b.close();
    }
  }, 30_000);
  test("both agents keep one path when a provisional nomination reaches the controlled agent's committed checklist", async () => {
    vi.useRealTimers();
    const { a, b, bLowest, startProvisional, commit } =
      await createProvisionalRestartPair();
    // b は provisional の USE-CANDIDATE を処理するが、応答 (再送分も) は失われる。
    const loss = dropNominationResponses(b, Number.POSITIVE_INFINITY);

    try {
      // Act: pranswer の provisional checklist で a が nominate を送り、b が選択する。
      await startProvisional();
      await waitUntil(() => b.provisionalNominated !== undefined);

      // Act: b が先に final answer を確定し、a の provisional nomination の再送が b の live checklist に届いて選択される。
      const bConnected = commit(b);
      await waitUntil(() => b.nominated !== undefined, 15_000);
      loss.stop();

      // Act: a も final answer を確定し、全候補で live checklist を一から check する。
      await Promise.all([commit(a), bConnected]);

      // Assert: controlling 側と controlled 側が同じ 5-tuple を選択している。
      expect(a.nominated?.localCandidate.host).toBe(b.nominated?.remoteAddr[0]);
      expect(a.nominated?.localCandidate.port).toBe(b.nominated?.remoteAddr[1]);
      expect(a.nominated?.remoteAddr[0]).toBe(b.nominated?.localCandidate.host);
      expect(a.nominated?.remoteAddr[1]).toBe(b.nominated?.localCandidate.port);
      // Assert: 選択は provisional で nominate した pair と同じ 5-tuple で、a の live checklist ではより上位の pair があった (優先度だけなら別の pair を選んでいた)。
      expect(a.nominated!.remoteAddr).toEqual([bLowest.host, bLowest.port]);
      expect(a.checkList.indexOf(a.nominated!)).toBeGreaterThan(0);
      // Assert: 選択した経路でデータが双方向に届く。
      await a.send(Buffer.from("ping"));
      expect((await b.onData.asPromise())[0].toString()).toBe("ping");
      await b.send(Buffer.from("pong"));
      expect((await a.onData.asPromise())[0].toString()).toBe("pong");
    } finally {
      await a.close();
      await b.close();
    }
  }, 40_000);

  test("the controlling agent nominates no other path when the re-check of an accepted provisional path fails", async () => {
    vi.useRealTimers();
    const { a, b, bLowest, startProvisional, commit } =
      await createProvisionalRestartPair();
    const loss = dropNominationResponses(b, Number.POSITIVE_INFINITY);

    try {
      // Act: b が先に final answer を確定し、a の provisional nomination の再送を live checklist で受理する。
      await startProvisional();
      await waitUntil(() => b.provisionalNominated !== undefined);
      void commit(b).catch(() => {});
      await waitUntil(() => b.nominated !== undefined, 15_000);
      loss.stop();
      const selected = b.nominated!;
      // b の選択済み経路 (bLowest のソケット) は以後 a からの check に応答しない。
      ignoreRequestsOn(b, bLowest.host, bLowest.port);

      // Act: a が final answer を確定し、同じ経路の再 check だけが失敗する。
      const connecting = commit(a);

      // Assert: a は別の valid pair を nominate せずに connect() を拒否し、failed になる。
      await expect(connecting).rejects.toThrow("ICE negotiation failed");
      expect(a.state).toBe("failed");
      expect(a.nominated).toBeUndefined();
      expect(a.checkList.some((pair) => pair.nominated)).toBe(false);
      expect(
        a.checkList.some((pair) => pair.state === CandidatePairState.SUCCEEDED),
      ).toBe(true);
      // Assert: b の選択は受理した provisional の経路のまま変わらない (両端が異なる経路を選んでいない)。
      expect(b.nominated).toBe(selected);
      expect([
        selected.localCandidate.host,
        selected.localCandidate.port,
      ]).toEqual([bLowest.host, bLowest.port]);
    } finally {
      await a.close();
      await b.close();
    }
  }, 40_000);

  test("waits on an empty checklist after end-of-candidates until the provisional path reappears from the peer's check", async () => {
    vi.useRealTimers();
    const { a, b, bLowest, startProvisional, commit } =
      await createProvisionalRestartPair();

    try {
      // Arrange: provisional checklist で a が nominate を確定させる。
      await startProvisional();
      await waitUntil(() => a.provisionalNominated !== undefined);

      // Act: a が候補なし・end-of-candidates だけの final answer を確定し、空の checklist で connect() を始める。
      const aConnected = commit(a, { signalCandidates: false });
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Assert: 空の checklist でも即座に失敗せず待機している。
      expect(a.checkList).toHaveLength(0);
      expect(a.state).not.toBe("failed");

      // Act: b が final answer を確定して check を送り、a 側で同じ経路が peer-reflexive の pair として再生成される。
      await Promise.all([aConnected, commit(b)]);

      // Assert: a は再生成された provisional と同じ経路を nominate し、両端が同じ 5-tuple を選ぶ。
      expect(a.nominated!.remoteCandidate.type).toBe("prflx");
      expect(a.nominated!.remoteAddr).toEqual([bLowest.host, bLowest.port]);
      expect(a.nominated?.localCandidate.host).toBe(b.nominated?.remoteAddr[0]);
      expect(a.nominated?.localCandidate.port).toBe(b.nominated?.remoteAddr[1]);
      expect(a.nominated?.remoteAddr[0]).toBe(b.nominated?.localCandidate.host);
      expect(a.nominated?.remoteAddr[1]).toBe(b.nominated?.localCandidate.port);
      // Assert: 選択した経路でデータが双方向に届く。
      await a.send(Buffer.from("ping"));
      expect((await b.onData.asPromise())[0].toString()).toBe("ping");
      await b.send(Buffer.from("pong"));
      expect((await a.onData.asPromise())[0].toString()).toBe("pong");
    } finally {
      await a.close();
      await b.close();
    }
  }, 40_000);

  test("a relay path the final answer's re-allocation closed is no longer preferred and the new allocation connects", async () => {
    vi.useRealTimers();
    const pair = await createRelayProvisionalRestartPair();
    const { a, b } = pair;

    try {
      // Arrange: a は保持している TURN allocation 上で provisional の relay pair を nominate する。
      await pair.startProvisional();
      await waitUntil(() => a.provisionalNominated !== undefined, 15_000);
      const provisional = a.provisionalNominated!;
      const [oldAllocation] = turnAllocations(a);
      expect(provisional.localCandidate.type).toBe("relay");
      expect(provisional.protocol).toBe(oldAllocation);

      // Act: 同じ資格情報の final answer を両端で確定する (a は TURN を allocation し直し、旧 allocation を閉じる)。
      await pair.commit(b);
      await pair.commit(a);
      await pair.connectBoth();

      // Assert: 旧 allocation は外れ、新しい allocation の relay pair が nominate されて両端の 5-tuple が一致する。
      expect(turnAllocations(a)).not.toContain(oldAllocation);
      expect(a.nominated!.localCandidate.type).toBe("relay");
      expect(a.nominated!.protocol).not.toBe(oldAllocation);
      expect(a.state).not.toBe("failed");
      expect(a.nominated?.localCandidate.host).toBe(b.nominated?.remoteAddr[0]);
      expect(a.nominated?.localCandidate.port).toBe(b.nominated?.remoteAddr[1]);
      expect(a.nominated?.remoteAddr[0]).toBe(b.nominated?.localCandidate.host);
      expect(a.nominated?.remoteAddr[1]).toBe(b.nominated?.localCandidate.port);
      // Assert: 新しい経路でデータが双方向に届く。
      await a.send(Buffer.from("ping"));
      expect((await b.onData.asPromise())[0].toString()).toBe("ping");
      await b.send(Buffer.from("pong"));
      expect((await a.onData.asPromise())[0].toString()).toBe("pong");
    } finally {
      await pair.close();
    }
  }, 40_000);
});
