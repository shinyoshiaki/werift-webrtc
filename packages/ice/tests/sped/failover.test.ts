import { describe, expect, test, vi } from "vitest";

import type { IceState } from "../../src";
import { markConnectionSpedEnabled } from "../../src/internal/sped-bind";
import {
  createFailoverRealPair,
  expectDataFlows,
  selectSamePath,
} from "../utils";

/**
 * SPED を有効にした ICE agent（Binding Request の HMAC 検証、旧 generation の
 * check を current に渡さない境界、一覧に無い候補の既存 pair 流用）でも、
 * 選択中の経路が切れたときの failover（ICE restart なし）が成り立つ。
 * 実 socket とローカル TURN server を使い、`cutHostPath()` で host ↔ host を遮断する。
 */
describe("SPED: 選択中の経路が切れても ICE restart なしで failover する", () => {
  test.each([
    { mode: "semi-aggressive", renomination: false },
    { mode: "renomination", renomination: true },
  ])(
    "($mode) SPED 有効の両端が relay 経路へ移り、データが届く",
    async ({ renomination }) => {
      // Arrange: host と relay の経路を持つ実 socket の pair。両端で SPED の認証境界を有効にする
      const { a, b, selectsHostPath, selectsRelayPath, cutHostPath, close } =
        await createFailoverRealPair({ renomination });
      markConnectionSpedEnabled(a);
      markConnectionSpedEnabled(b);
      const states: IceState[] = [];
      a.stateChanged.subscribe((state) => states.push(state));
      b.stateChanged.subscribe((state) => states.push(state));

      try {
        // Act: 両端で ICE を実行し、host ↔ host 経路で接続させる
        await Promise.all([a.connect(), b.connect()]);
        await vi.waitFor(
          () => {
            expect(selectsHostPath(a)).toBe(true);
            expect(selectsHostPath(b)).toBe(true);
          },
          { timeout: 5000 },
        );

        // Assert: 前提として、host 経路でデータが届く
        await expectDataFlows(a, b, "before the cut");
        const generation = a.generation;

        // Act: host ↔ host の経路を両方向とも遮断する（relay は通るまま）
        cutHostPath();

        // Assert: 認証済みの check と指名で両端が relay 経路へ移り、双方向にデータが届く
        await vi.waitFor(() => expect(selectsRelayPath(a)).toBe(true), {
          timeout: 6000,
          interval: 100,
        });
        await expectDataFlows(a, b, "a to b after the cut");
        await vi.waitFor(() => expect(selectsRelayPath(b)).toBe(true), {
          timeout: 5000,
        });
        expect(selectSamePath(a, b)).toBe(true);
        await expectDataFlows(b, a, "b to a after the cut");

        // Assert: ICE restart をせず、一度も failed を経ずに connected へ戻る
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
