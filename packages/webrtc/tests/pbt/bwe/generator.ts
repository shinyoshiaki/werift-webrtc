import type { GccPhase, GccScenario } from "../../media/gccSimulation";
import type { SeededRandom } from "../shared/random";

/**
 * Generators of the bandwidth-estimator property test
 * (`bweProperty.test.ts`). Every value is drawn from the seed's stream.
 */

/**
 * A GCC scenario of `phases` phases: application min / start / max bitrates
 * and, per phase, a random bottleneck (capacity, delay, queue, loss), a fixed
 * or estimate-following source, and sometimes a TWCC feedback stall.
 */
export function randomGccScenario(
  rng: SeededRandom,
  phases: number,
  seed: number,
): GccScenario {
  const minBps = Math.round(rng.between(30_000, 200_000));
  const maxBps = Math.round(rng.between(600_000, 4_000_000));
  const startBps = Math.round(rng.between(minBps, maxBps));
  return {
    startBps,
    minBps,
    maxBps,
    seed,
    phases: Array.from(
      { length: phases },
      (): GccPhase => ({
        durationMs: Math.round(rng.between(1_000, 4_000)),
        link: {
          capacityBps: rng.between(100_000, 5_000_000),
          baseDelayMs: rng.between(5, 200),
          queueLimitBytes: rng.between(5_000, 100_000),
          lossRate: rng.chance(0.3) ? rng.between(0, 0.3) : 0,
        },
        source: rng.chance(0.5) ? "follow" : rng.between(50_000, 6_000_000),
        feedback: !rng.chance(0.15),
      }),
    ),
  };
}

/**
 * A constant-rate packet stream all received through a bottleneck that
 * stretches (or compresses) the send spacing by `stretch`.
 */
export function randomConstantRateStream(rng: SeededRandom) {
  return {
    packets: rng.int(20, 60),
    sizeBytes: rng.int(200, 1_400),
    intervalMs: rng.int(2, 42),
    stretch: rng.between(0.8, 2.3),
  };
}

/** Bitrate updates drawn from a few values, so many repeat the previous one. */
export function randomBitrateUpdates(rng: SeededRandom, count: number) {
  return Array.from({ length: count }, () =>
    rng.pick([0, 100_000, 200_000, 300_000]),
  );
}
