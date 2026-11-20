/**
 * Which seeds a property test runs and how to replay one, the same for every
 * package. A property with prefix `P` runs `P_SEEDS` seeds (its CI default)
 * starting at `P_SEED` (default 1), with `P_STEPS` operations per seed. The
 * deep search (`npm run pbt:deep`, `runDeepSearch`) shards a property by
 * setting the same variables.
 */
export function propertySeeds(
  prefix: string,
  defaults: { seeds: number; steps?: number },
) {
  const env = process.env;
  const count = Number(env[`${prefix}_SEEDS`] ?? defaults.seeds);
  const steps = Number(env[`${prefix}_STEPS`] ?? defaults.steps ?? 1);
  const first = Number(env[`${prefix}_SEED`] ?? 1);
  const seeds = [...Array(count)].map((_, index) => first + index);
  /**
   * Environment that replays one seed with the same steps. Pass `"$seed"`
   * inside a `test.each` title to let vitest fill in the seed.
   */
  const replay = (seed: number | string) =>
    `${prefix}_SEED=${seed} ${prefix}_SEEDS=1 ${prefix}_STEPS=${steps}`;
  return {
    seeds,
    steps,
    /** `test.each` rows, one per seed: `{ seed }` (the title reads `$seed`). */
    cases: seeds.map((seed) => ({ seed })),
    /** True when `P_SEED` picks the seeds (a replay or a deep-search shard). */
    seedSelected: env[`${prefix}_SEED`] !== undefined,
    replay,
    /**
     * The title of one seed of a claim, in the form the deep search selects
     * (`SEED_TITLE_PATTERN`): `<claim>: seed $seed (replay: <environment>)`.
     * For `test.each(cases)`.
     */
    title: (claim: string) =>
      `${claim}: seed $seed (replay: ${replay("$seed")})`,
  };
}

/** The test-name pattern (vitest `-t`) of every seed title made by `propertySeeds().title`. */
export const SEED_TITLE_PATTERN = ": seed \\d+ \\(replay";

/**
 * Options of a deterministic property (pure, or fake timers), given to its
 * `describe` (or test): no retry (a seed that fails once is a
 * counterexample; a retry would hide it), and the timeout.
 */
export const propertyOptions = (timeout?: number) => ({
  retry: 0,
  ...(timeout === undefined ? {} : { timeout }),
});
