import { describe, expect, test, vi } from "vitest";

import type { IceState } from "../../src";
import {
  createFailoverRealPair,
  expectDataFlows,
  selectSamePath,
} from "../utils";

/**
 * Acceptance test of ticket 6b2d7627: when the selected host ↔ host path
 * stops working after connecting, both agents move to the relay path
 * without an ICE restart and data flows again (before: consent expired and
 * the agents ended `failed` until the application restarted ICE).
 * Real sockets and a local TURN server; `cutHostPath()` drops every
 * host ↔ host packet in both directions while the relay still works.
 */
describe("acceptance: a cut selected path fails over without an ICE restart", () => {
  test.each([
    { mode: "semi-aggressive", renomination: false },
    { mode: "renomination", renomination: true },
  ])(
    "($mode) 1章・F3・F5: 選択中の host 経路が切れると、ICE restart なしで両端が relay 経路へ移りデータが届く",
    async ({ renomination }) => {
      const { a, b, selectsHostPath, selectsRelayPath, cutHostPath, close } =
        await createFailoverRealPair({ renomination });
      const states: IceState[] = [];
      a.stateChanged.subscribe((state) => states.push(state));
      b.stateChanged.subscribe((state) => states.push(state));

      try {
        // Act: 両端で ICE を実行し、上位の host ↔ host 経路で接続させる。
        await Promise.all([a.connect(), b.connect()]);
        await vi.waitFor(
          () => {
            expect(selectsHostPath(a)).toBe(true);
            expect(selectsHostPath(b)).toBe(true);
          },
          { timeout: 5000 },
        );

        // Assert: 前提として、host 経路でデータが届く。
        await expectDataFlows(a, b, "before the cut");
        const generation = a.generation;

        // Act: host ↔ host の経路を両方向とも遮断する (relay は通るまま)。
        cutHostPath();

        // Assert: controlling 側 (a) が D3 の上限 (約 10 s) に余裕を足した時間内に relay 経路へ移る。
        await vi.waitFor(() => expect(selectsRelayPath(a)).toBe(true), {
          timeout: 12_000,
          interval: 100,
        });

        // Act: a が relay 経路でデータを送る (controlled 側 b は相手の指名とデータに従う)。
        await expectDataFlows(a, b, "a to b after the cut");

        // Assert: b も同じ relay 経路へ移り、逆方向のデータも届く。
        await vi.waitFor(() => expect(selectsRelayPath(b)).toBe(true), {
          timeout: 5000,
        });
        expect(selectSamePath(a, b)).toBe(true);
        await expectDataFlows(b, a, "b to a after the cut");

        // Assert: ICE restart をせず、両端とも一度も failed を経ずに connected へ戻る。
        await vi.waitFor(() => {
          expect(a.state).toBe("connected");
          expect(b.state).toBe("connected");
        });
        expect(a.generation).toBe(generation);
        expect(states).not.toContain("failed");
      } finally {
        await close();
      }
    },
    30_000,
  );
});
