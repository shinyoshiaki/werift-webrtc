import { describe, expect, test, vi } from "vitest";

import {
  createRttSwitchRealPair,
  expectDataFlows,
  keepSending,
  selectSamePath,
} from "../utils";

/**
 * Acceptance test of ticket 205c811f: connected over one of two TURN relays
 * of equal priority, when only the selected relay becomes slow the
 * controlling agent compares the smoothed RTT, nominates the fast relay and
 * both agents move to it with data flowing (before: the choice used the
 * priority only, so the agents stayed on the slow relay).
 * Real sockets and a local TURN server; each relay goes through its own UDP
 * proxy, and `delay()` slows one of them.
 */
describe("acceptance: the selection moves to an equal-priority path with a clearly lower RTT", () => {
  test.each([
    { mode: "semi-aggressive", renomination: false },
    { mode: "renomination", renomination: true },
  ])(
    "($mode) M1・M3〜M5: 選択中の relay だけ遅くなると、両端が速い relay へ移りデータが届く",
    async ({ renomination }) => {
      const h = await createRttSwitchRealPair({ renomination });
      // 双方がデータを送り続ける (controlled 側はデータを受けたペアへ追従する)。
      const stops = [keepSending(h.a, 100), keepSending(h.b, 100)];

      try {
        // Act: 両端が同じ relay を選び、退避先の relay の RTT も測れるまで待つ。
        const slow = h.relayIndexOf(h.a);
        const fast = 1 - slow;
        await vi.waitFor(
          () => {
            expect(h.relayIndexOf(h.b)).toBe(slow);
            expect(h.relayPairOf(fast).smoothedRtt).toBeDefined();
          },
          { timeout: 15_000, interval: 200 },
        );

        // Assert: RTT の差がない間は、両端とも最初の relay から動かない。
        expect(h.relayIndexOf(h.a)).toBe(slow);

        // Act: 選択中の relay の経路だけに片道 50 ms (RTT +100 ms) の遅延を入れる。
        h.delay(slow, 50);

        // Assert: controlling 側が速い relay へ移り、controlled 側も追従して同じ 5-tuple を使う。
        await vi.waitFor(
          () => {
            expect(h.relayIndexOf(h.a)).toBe(fast);
            expect(h.relayIndexOf(h.b)).toBe(fast);
          },
          { timeout: 40_000, interval: 200 },
        );
        expect(selectSamePath(h.a, h.b)).toBe(true);

        // Assert: 移った先は平滑化 RTT が 10 ms 以上低く、接続を保ったままデータが双方向に届く。
        expect(
          h.relayPairOf(slow).smoothedRtt! - h.relayPairOf(fast).smoothedRtt!,
        ).toBeGreaterThanOrEqual(0.01);
        expect([h.a.state, h.b.state]).toEqual(["connected", "connected"]);
        await expectDataFlows(h.a, h.b, "a to b");
        await expectDataFlows(h.b, h.a, "b to a");
      } finally {
        for (const stop of stops) stop();
        await h.close();
      }
    },
    90_000,
  );
});
