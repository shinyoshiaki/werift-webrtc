import { describe, expect, test } from "vitest";

import {
  propertyOptions,
  propertySeeds,
  seededRandom,
} from "../../../../pbt/src";
import { type CandidatePair, CandidatePairState } from "../../../src";
import { decideNomination } from "../../../src/nomination/regularNomination";

/**
 * decideNomination property: for a random checklist (pair states, forceTurn
 * pairs, end-of-candidates, times), the regular nomination rule nominates the
 * first valid pair exactly when its deadline passed, or both ends sent
 * end-of-candidates and nothing above it is still pending; otherwise it
 * waits for the deadline (none without a valid pair).
 *
 * CI runs `WERIFT_ICE_DECIDE_SEEDS` (default 200) seeds from
 * `WERIFT_ICE_DECIDE_SEED` (default 1). A failing title prints the replay
 * environment.
 */
describe(
  "decideNomination property (when regular nomination nominates)",
  propertyOptions(),
  () => {
    const S = CandidatePairState.SUCCEEDED;
    const F = CandidatePairState.FAILED;
    const P = CandidatePairState.IN_PROGRESS;
    /** Arrange: pairs in priority order (highest first) with these states; `unchecked` marks forceTurn host pairs. */
    const pairsOf = (states: CandidatePairState[]) =>
      states.map((state) => ({ state }) as CandidatePair);
    /** `DEFAULT_NOMINATION_DELAY_MS`. */
    const DELAY = 300;
    const base = {
      remoteCandidatesEnd: false,
      localCandidatesEnd: true,
      quietSince: 1000,
      delayMs: DELAY,
      now: 1000,
      preferred: undefined,
      preferredSince: undefined,
    };

    const { cases, replay, title } = propertySeeds("WERIFT_ICE_DECIDE", {
      seeds: 200,
      steps: 1,
    });
    test.each(cases)(
      title(
        "a random checklist nominates the first valid pair exactly when the rule allows",
      ),
      ({ seed }) => {
        // Arrange: seed から pair の状態・EOC・時刻を決める (preferred なし)。
        const random = seededRandom(seed);
        const pairs = pairsOf(
          [...Array(random.int(0, 6))].map(() =>
            random.pick([S, F, P, CandidatePairState.WAITING]),
          ),
        );
        const unchecked = new Set(pairs.filter(() => random.chance(0.2)));
        const input = {
          ...base,
          remoteCandidatesEnd: random.chance(0.5),
          localCandidatesEnd: random.chance(0.8),
          quietSince: random.chance(0.8) ? random.int(0, 2000) : undefined,
          delayMs: random.pick([0, 300, 1000]),
          now: random.int(0, 3000),
        };

        // Act: 規則を評価する。
        const decision = decideNomination({
          ...input,
          pairs,
          unchecked: (pair) => unchecked.has(pair),
        });

        // Assert: valid pair がなければ何もせず、あれば最初の valid pair を、deadline 到達か「両端 EOC かつ上位に未完了なし」のときだけ nominate する。
        const first = pairs.findIndex((pair) => pair.state === S);
        const deadline = (input.quietSince ?? input.now) + input.delayMs;
        const pendingAbove = pairs
          .slice(0, Math.max(first, 0))
          .some((pair) => pair.state !== F && !unchecked.has(pair));
        const now =
          input.now >= deadline ||
          (input.remoteCandidatesEnd &&
            input.localCandidatesEnd &&
            !pendingAbove);
        expect(decision, replay(seed)).toEqual(
          first === -1
            ? { action: "none" }
            : now
              ? { action: "nominate", pair: pairs[first] }
              : { action: "wait", deadline },
        );
      },
    );
  },
);
