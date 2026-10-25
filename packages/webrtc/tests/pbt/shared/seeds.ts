/**
 * Shared by every property test of tests/pbt: which seeds a run uses and how
 * to replay one. A suite with prefix `P` runs `P_SEEDS` seeds (the suite's CI
 * default) starting at `P_SEED` (default 1), with `P_STEPS` operations per
 * seed. `npm run pbt:deep` shards suites by setting the same variables.
 */
export function propertySeeds(
  prefix: string,
  defaults: { seeds: number; steps: number },
) {
  const env = process.env;
  const count = Number(env[`${prefix}_SEEDS`] ?? defaults.seeds);
  const steps = Number(env[`${prefix}_STEPS`] ?? defaults.steps);
  const first = Number(env[`${prefix}_SEED`] ?? 1);
  return {
    seeds: [...Array(count)].map((_, index) => first + index),
    steps,
    /** True when `P_SEED` picks the seeds (a replay or a deep-search shard). */
    seedSelected: env[`${prefix}_SEED`] !== undefined,
    /**
     * Environment that replays one seed with the same steps. Pass `"$seed"`
     * inside a `test.each` title to let vitest fill in the seed.
     */
    replay: (seed: number | string) =>
      `${prefix}_SEED=${seed} ${prefix}_SEEDS=1 ${prefix}_STEPS=${steps}`,
  };
}
