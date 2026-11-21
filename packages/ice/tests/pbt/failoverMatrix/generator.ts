import { seededRandom } from "../../../../pbt/src";
import type { FailoverMatrixPhase } from "../../utils";

/** The role × mode × alternative-path combinations of the failover matrix (16). */
export const FAILOVER_MATRIX_COMBOS = ([true, false] as const).flatMap(
  (iceControlling) =>
    ([false, true] as const).flatMap((renomination) =>
      (
        [
          "other-socket-lower",
          "other-socket-upper",
          "same-socket-lower",
          "same-socket-upper",
        ] as FailoverMatrixPhase[]
      ).map((phase) => ({ iceControlling, renomination, phase })),
    ),
);

/**
 * Generator of the failover matrix property: seed `seed` takes combination
 * `(seed - 1) % 16` (so every 16 consecutive seeds cover each role × mode ×
 * position once) and draws how long the alternative path is down from
 * before the selection (0 a quarter of the time, else 1–90 s), how long the
 * agent runs after it came back before the selected path is cut (20–40 s,
 * at least one 16 s retry) and the jitter of the timers (`random`).
 */
export function drawFailoverMatrixCase(seed: number) {
  const random = seededRandom(seed);
  const combo =
    FAILOVER_MATRIX_COMBOS[(seed - 1) % FAILOVER_MATRIX_COMBOS.length];
  const altDownMs = random.chance(0.25) ? 0 : random.int(1_000, 90_000);
  return {
    ...combo,
    altDownMs,
    settleMs: random.int(20_000, 40_000),
    random,
  };
}
