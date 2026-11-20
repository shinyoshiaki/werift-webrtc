import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CandidatePairState } from "../../src";
import {
  createFailoverHarness,
  createFailoverMatrixCell,
  drawFailoverMatrixCase,
  FAILOVER_HIGH,
  FAILOVER_MID,
  propertySeeds,
} from "../utils";

/**
 * Failover matrix (ticket 6b2d7627): one invariant checked over role ×
 * nomination mode × where the alternative path is × how long it was down
 * (a property: each run of 16 seeds covers every role × mode × position;
 * the downtime, the time before the cut and the timer jitter are drawn).
 *
 * Invariant: an eligible pair on a path other than the selected one (another
 * local socket, or another remote address on the selected socket), above or
 * below the selection, whatever the role, is monitored and taken when the
 * selected path breaks:
 * - controlling: within 11 s of the cut the selection is the alternative
 *   (an alternative above the selection that is reachable is selected before
 *   the cut already) and the agent never fails;
 * - controlled: within 10 s of the cut the alternative is valid and still
 *   checked, the agent does not fail before 40 s, and the peer's nomination
 *   alone (USE-CANDIDATE, or NOMINATION + 1; no application data) moves the
 *   selection to it within 2 s, connected again.
 */
const MODES = [
  { mode: "semi-aggressive", renomination: false },
  { mode: "renomination", renomination: true },
] as const;

describe("failover matrix property: role × mode × alternative path × how long it was down", () => {
  // 16 の組み合わせ (ロール × モード × 代替の位置) を seed 順に一巡ずつ回し、
  // 代替が落ちていた時間・切断までの時間・タイマーの揺らぎを乱数で引く。
  const { seeds, replay } = propertySeeds("WERIFT_ICE_FAILOVER_MATRIX", {
    seeds: 128,
    steps: 1,
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test.each(seeds)("seed %i", async (seed) => {
    const { iceControlling, renomination, phase, altDownMs, settleMs, random } =
      drawFailoverMatrixCase(seed);
    vi.useFakeTimers();
    // consent と退避先の間隔の揺らぎ (0.8〜1.2 倍) も seed で決める。
    vi.spyOn(Math, "random").mockImplementation(random.next);
    const label = `${replay(seed)} ${iceControlling ? "controlling" : "controlled"} ${renomination ? "renomination" : "semi-aggressive"} ${phase} altDownMs=${altDownMs} settleMs=${settleMs}`;
    const cell = await createFailoverMatrixCell({
      iceControlling,
      renomination,
      phase,
      altDownMs,
    });
    const { h, alt } = cell;
    const upper = phase.endsWith("upper");

    try {
      // Act: 代替経路が戻るまで (落ちていれば) 進め、さらに 20〜40 s 進める (16 s ごとの再試行を 1 回以上含む)。
      await vi.advanceTimersByTimeAsync(altDownMs + settleMs);

      // Assert: controlling は通る上位の代替へ切断前に移っている。他は元の選択のまま接続している。
      expect(h.connection.nominated, label).toBe(
        iceControlling && upper ? alt : h.selection,
      );
      expect(h.connection.state, label).toBe("connected");

      // Act: 選択した経路 (local 0 → remote 0) だけを切る。
      cell.cutSelected();
      const cutAt = Date.now();

      if (iceControlling) {
        // Act: 代替へ移るまで進める。
        await h.advanceUntil(() => h.connection.nominated === alt, 20_000);

        // Assert: 切断から 11 s 以内に代替へ移り、failed を経ない。
        expect(h.connection.nominated, label).toBe(alt);
        expect(Date.now() - cutAt, label).toBeLessThanOrEqual(11_000);
        expect(
          h.states.map(({ state }) => state),
          label,
        ).not.toContain("failed");
        return;
      }

      // Act: 切断から 10 s 進める。
      await vi.advanceTimersByTimeAsync(10_000);

      // Assert: 代替は有効 (SUCCEEDED) で、check が続いている。
      expect(alt.state, label).toBe(CandidatePairState.SUCCEEDED);
      expect(
        h
          .requestsTo(alt)
          .some((request) => request.at >= cutAt + 7_000 && request.answered),
        label,
      ).toBe(true);

      // Act: 切断から 35 s まで進める (consent は失効し、猶予期間に入る)。
      await vi.advanceTimersByTimeAsync(25_000);

      // Assert: 40 s 前に failed にならない。
      expect(["connected", "disconnected"], label).toContain(
        h.connection.state,
      );
      expect(
        h.states.map(({ state }) => state),
        label,
      ).not.toContain("failed");

      // Act: 相手が代替を指名する (データは送らない)。
      h.receiveNomination(alt, renomination ? 2 : undefined);
      await vi.advanceTimersByTimeAsync(2_000);

      // Assert: 2 s 以内に代替へ移り、connected に戻る。
      expect(h.connection.nominated, label).toBe(alt);
      expect(h.connection.state, label).toBe("connected");
    } finally {
      await cell.close();
    }
  });
});

describe("failover matrix: role change, a late candidate and a remote restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("an agent that becomes controlled right after the selection monitors the higher-priority pair on its socket", async () => {
    // 同一ソケットの上位の代替は最初から 30 s 落ちている。
    const cell = await createFailoverMatrixCell({
      iceControlling: true,
      renomination: false,
      phase: "same-socket-upper",
      altDownMs: 30_000,
    });
    const { h, alt } = cell;

    try {
      // Act: 選択直後にロール競合の修復で controlled になり、代替が戻った後まで進める。
      h.switchRole(false);
      await vi.advanceTimersByTimeAsync(30_000 + 20_000);
      const from = Date.now();
      await vi.advanceTimersByTimeAsync(5_000);

      // Assert: controlled として上位の代替を監視し続け、有効になっている。
      expect(alt.state).toBe(CandidatePairState.SUCCEEDED);
      expect(
        h
          .requestsTo(alt)
          .some((r) => r.at >= from && r.answered && !r.controlling),
      ).toBe(true);
      expect(h.connection.nominated).toBe(h.selection);
    } finally {
      await cell.close();
    }
  });

  test("controlled: a higher-priority remote candidate trickled after the selection is monitored as the backup of the selected socket", async () => {
    const h = await createFailoverHarness({
      iceControlling: false,
      locals: [
        { type: "stun", candidateType: "host", priority: FAILOVER_HIGH },
      ],
      remotes: [FAILOVER_MID],
    });

    try {
      // Act: 選択後に上位のリモート候補が届き、10 s 進める。
      const late = await h.addRemote(FAILOVER_HIGH);
      await vi.advanceTimersByTimeAsync(10_000);

      // Assert: その経路が同じソケットの退避先として監視され、有効になる。選択は相手の指名まで変わらない。
      const pair = h.pairOf(0, late);
      expect(pair.state).toBe(CandidatePairState.SUCCEEDED);
      expect(h.requestsTo(pair).length).toBeGreaterThan(3);
      expect(h.connection.nominated).toBe(h.selection);
    } finally {
      await h.connection.close();
    }
  });

  test.each(MODES)(
    "($mode) controlling: a higher-priority pair on the selected socket comes back just after a retry failed, as the selected path breaks: it is checked at once, not after the next 16 s retry",
    async ({ renomination }) => {
      // 同一ソケットの上位の代替は長く落ちたまま (再試行は 16 s ごとになっている)。
      const cell = await createFailoverMatrixCell({
        iceControlling: true,
        renomination,
        phase: "same-socket-upper",
        altDownMs: 600_000,
      });
      const { h, alt } = cell;

      try {
        // Act: 70 s 進め、代替への再試行がちょうど失敗した時点で代替を戻し、選択した経路を切る。
        await vi.advanceTimersByTimeAsync(70_000);
        const sent = h.requestsTo(alt).length;
        await h.advanceUntil(
          () =>
            h.requestsTo(alt).length > sent &&
            h.requestsTo(alt).every((request) => request.done),
          20_000,
        );
        cell.restoreAlt();
        cell.cutSelected();
        const cutAt = Date.now();
        await h.advanceUntil(() => h.connection.nominated === alt, 30_000);

        // Assert: 次の再試行 (16 s 後) を待たず、選択した経路の書き込み不可の判定と同時に上位の代替を check して移る。
        expect(h.connection.nominated).toBe(alt);
        expect(Date.now() - cutAt).toBeLessThanOrEqual(11_000);
        expect(h.states.map(({ state }) => state)).not.toContain("failed");
      } finally {
        await cell.close();
      }
    },
  );

  test("a remote restart (new remote ufrag) leaves no demoted path of the old generation", async () => {
    const cell = await createFailoverMatrixCell({
      iceControlling: true,
      renomination: false,
      phase: "same-socket-lower",
      altDownMs: 0,
    });
    const { h, alt } = cell;
    const demoted = () =>
      (
        h.connection as unknown as {
          failover: { demoted: Map<unknown, unknown> };
        }
      ).failover.demoted.size;
    await vi.advanceTimersByTimeAsync(10_000);
    cell.cutSelected();
    await h.advanceUntil(() => h.connection.nominated === alt, 20_000);
    expect(demoted()).toBe(1);

    try {
      // Act: 相手だけが ICE restart する (リモートの ufrag が変わる)。
      h.connection.restartRemote();

      // Assert: 古い世代の demote 情報と選択は残らない。
      expect(demoted()).toBe(0);
      expect(h.connection.nominated).toBeUndefined();
    } finally {
      await cell.close();
    }
  });
});
