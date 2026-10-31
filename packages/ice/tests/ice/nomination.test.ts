import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CandidatePairState } from "../../src";
import { createNominationHarness } from "../utils";

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

  test("a failed nomination falls back to the next valid pair, one request at a time", async () => {
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
