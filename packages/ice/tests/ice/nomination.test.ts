import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CandidatePairState } from "../../src";
import {
  createMultiPathPair,
  createNominationHarness,
  dropNominationResponses,
} from "../utils";

const LOW = 100;
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
});
