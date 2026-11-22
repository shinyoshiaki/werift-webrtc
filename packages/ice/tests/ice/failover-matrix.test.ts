import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CandidatePairState } from "../../src";
import {
  createFailoverHarness,
  createFailoverMatrixCell,
  FAILOVER_HIGH,
  FAILOVER_MID,
} from "../utils";

/**
 * Failover matrix (ticket 6b2d7627): the cases around the matrix property
 * (`tests/pbt/failoverMatrix`, which checks the invariant over role × mode ×
 * where the alternative path is × how long it was down): a role change, a
 * late candidate, a path back at the moment the selection breaks, and a
 * remote restart.
 */
const MODES = [
  { mode: "semi-aggressive", renomination: false },
  { mode: "renomination", renomination: true },
] as const;

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
