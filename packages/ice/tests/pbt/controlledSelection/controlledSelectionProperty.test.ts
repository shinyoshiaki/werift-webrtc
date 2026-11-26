import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  propertyOptions,
  propertySeeds,
  seededRandom,
} from "../../../../pbt/src";
import type { CandidatePair } from "../../../src";
import { createNominationHarness } from "../../utils";

/**
 * Controlled selection model property: for a random sequence of the peer's
 * nominations (USE-CANDIDATE, NOMINATION values) and application data on
 * three valid pairs, the controlled agent uses the pair the rules pick (the
 * largest nomination, else the pair the peer sends data on).
 *
 * CI runs `WERIFT_ICE_CONTROLLED_SEEDS` (default 60) seeds of
 * `WERIFT_ICE_CONTROLLED_STEPS` (default 20) operations from
 * `WERIFT_ICE_CONTROLLED_SEED` (default 1). A failing title prints the replay
 * environment.
 */
const LOW = 100;
const MID = 1_000_000;
const HIGH = 2_000_000_000;

describe(
  "controlled agent: model property (which nominated pair is used)",
  propertyOptions(),
  () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const { cases, steps, replay, title } = propertySeeds(
      "WERIFT_ICE_CONTROLLED",
      {
        seeds: 60,
        steps: 20,
      },
    );

    test.each(cases)(
      title("the agent uses the nominated pair the rules pick"),
      async ({ seed }) => {
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
                nomination.set(
                  pair,
                  Math.max(nomination.get(pair) ?? 0, received),
                );
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
      },
    );
  },
);
