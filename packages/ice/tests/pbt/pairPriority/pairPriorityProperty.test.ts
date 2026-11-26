import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  propertyOptions,
  propertySeeds,
  seededRandom,
} from "../../../../pbt/src";
import { type CandidatePair, compareCandidatePairPriority } from "../../../src";
import { createNominationHarness } from "../../utils";

/**
 * Pair priority property (RFC 8445 §6.1.2.3): `compareCandidatePairPriority`
 * has the sign of the exact 64-bit formula for random candidate priorities
 * (1 to 2^31 - 1, ties included), and the checklist is sorted by it.
 *
 * CI runs `WERIFT_ICE_PAIR_PRIORITY_SEEDS` (default 20) seeds of
 * `WERIFT_ICE_PAIR_PRIORITY_STEPS` (default 50) comparisons from
 * `WERIFT_ICE_PAIR_PRIORITY_SEED` (default 1). A failing title prints the
 * replay environment.
 */
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
describe("pair priority (RFC 8445 §6.1.2.3)", propertyOptions(), () => {
  /** The exact 64-bit pair priority, as BigInt. */
  const exact = (local: number, remote: number, controlling: boolean) => {
    const [g, d] = controlling ? [local, remote] : [remote, local];
    return (
      (1n << 32n) * BigInt(Math.min(g, d)) +
      2n * BigInt(Math.max(g, d)) +
      (g > d ? 1n : 0n)
    );
  };
  const { cases, steps, replay, title } = propertySeeds(
    "WERIFT_ICE_PAIR_PRIORITY",
    {
      seeds: 20,
      steps: 50,
    },
  );

  test.each(cases)(
    title(
      "compareCandidatePairPriority and the checklist order follow the exact formula",
    ),
    async ({ seed }) => {
      // Arrange: seed から候補 priority を決める (RFC 8445 §5.1.2.1 の範囲 1〜2^31-1、同値を含む)。
      const random = seededRandom(seed);
      const priority = () =>
        random.chance(0.3)
          ? random.pick([1, 2, 126, 2 ** 24, 2 ** 31 - 1])
          : random.int(1, 2 ** 31);
      for (let step = 0; step < steps; step++) {
        const [al, ar, bl, br] = [
          priority(),
          priority(),
          priority(),
          priority(),
        ];
        const controlling = random.chance(0.5);
        const diff = exact(al, ar, controlling) - exact(bl, br, controlling);

        // Act: 比較関数で 2 つの pair を比べる。
        const compared = compareCandidatePairPriority(
          { priority: al },
          { priority: ar },
          { priority: bl },
          { priority: br },
          controlling,
        );

        // Assert: 正確な 64 bit 値の大小と同じ符号になる。
        expect(
          Math.sign(compared),
          `${replay(seed)} ${[al, ar, bl, br, controlling]}`,
        ).toBe(diff > 0n ? 1 : diff < 0n ? -1 : 0);
      }

      // Arrange: 異なる priority の local 2 つ × remote 2 つの checklist。
      const locals = [random.int(1, 2 ** 30), random.int(2 ** 30, 2 ** 31)];
      const h = createNominationHarness({ localPriorities: locals });
      try {
        // Act: remote 候補を 2 つ trickle して 4 pair を作る。
        const all = [
          ...(await h.addRemotePairs(random.int(1, 2 ** 30))),
          ...(await h.addRemotePairs(random.int(2 ** 30, 2 ** 31))),
        ];

        // Assert: checklist は正確な pair priority の降順に並ぶ。
        const key = (pair: CandidatePair) =>
          exact(
            pair.localCandidate.priority,
            pair.remoteCandidate.priority,
            true,
          );
        expect(h.connection.checkList, replay(seed)).toEqual(
          [...all].sort((a, b) => (key(b) > key(a) ? 1 : -1)),
        );
      } finally {
        await h.connection.close();
      }
    },
  );
});
