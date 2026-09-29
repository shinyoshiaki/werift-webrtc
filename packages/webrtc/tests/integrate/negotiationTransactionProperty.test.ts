import {
  createFuzzSession,
  expectFuzzSessionAlive,
  fuzzEpisode,
  fuzzRemoteMutation,
  seededRandom,
} from "./negotiationTransactionUtils";

/**
 * Property test: random operation sequences (offer / pranswer / answer /
 * rollback / replacement, ICE restart, BUNDLE split/merge, new m-lines,
 * end-of-candidates, routing-key mutations, invalid extmap remaps). After
 * every operation both peers satisfy the negotiation invariants; after every
 * episode the committed session carries RTP and DataChannel traffic.
 *
 * CI runs a fixed set of seeds. For a deeper local search:
 *   WERIFT_NEGOTIATION_FUZZ_SEEDS=200 WERIFT_NEGOTIATION_FUZZ_STEPS=20 npx vitest run tests/integrate/negotiationTransactionProperty.test.ts
 * A failure names its seed and the operations; WERIFT_NEGOTIATION_FUZZ_SEED
 * replays from that seed.
 */
const seedCount = Number(process.env.WERIFT_NEGOTIATION_FUZZ_SEEDS ?? 6);
const stepCount = Number(process.env.WERIFT_NEGOTIATION_FUZZ_STEPS ?? 8);
const firstSeed = Number(process.env.WERIFT_NEGOTIATION_FUZZ_SEED ?? 1);
/**
 * Seeds (with the default 8 steps unless noted) that exposed bugs fixed in
 * this change; CI keeps replaying them:
 *   3 old-ufrag check relabelled a live candidate, 6 pranswer restart
 *   credentials regenerated, 17 fallback DTLS role overwrote a split owner,
 *   19 stale check selected a discarded pair, 28 answer gave a direction to
 *   an unanswered transceiver / unapplied createOffer MIDs; 254, 302 (20
 *   steps) stale m-line index from repeated unapplied offers, 1385 (20
 *   steps) srflx dropped after restart.
 */
const regressionSeeds = [3, 4, 6, 17, 19, 28];
const seeds = [
  ...new Set([
    ...[...Array(seedCount)].map((_, index) => firstSeed + index),
    ...(process.env.WERIFT_NEGOTIATION_FUZZ_SEED ? [] : regressionSeeds),
  ]),
];
const longRegressionSeeds = process.env.WERIFT_NEGOTIATION_FUZZ_SEED
  ? []
  : [254, 302, 1385];

/** Replay one seed: `steps` random operations, each followed by live traffic. */
async function playSeed(seed: number, steps: number) {
  // Arrange: RTX と header extension を持つ双方向 session と、seed 固定の乱数。
  const ctx = await createFuzzSession();
  const rng = seededRandom(seed);
  try {
    for (let index = 0; index < steps; index++) {
      // Act: 交渉 episode か、remote 側だけの routing key 変更をランダムに行う
      // (各操作の後に両 peer の invariant を検査する)。
      if (rng.chance(0.7)) {
        await fuzzEpisode(ctx, rng);
      } else {
        await fuzzRemoteMutation(ctx, rng);
      }

      // Assert: 確定した session は video・audio・DataChannel とも双方向に通信できる。
      await expectFuzzSessionAlive(ctx, `seed${seed}-step${index}`);
    }
  } catch (error) {
    (error as Error).message +=
      `\nseed ${seed} operations:\n  ${ctx.log.join("\n  ")}`;
    throw error;
  } finally {
    await ctx.session.close();
  }
}

describe("negotiation transaction property", () => {
  test.each(seeds)(
    "seed %i keeps both peers consistent and the session alive",
    (seed) => playSeed(seed, stepCount),
    60_000,
  );

  test.each(longRegressionSeeds)(
    "regression seed %i (20 steps) keeps both peers consistent and the session alive",
    (seed) => playSeed(seed, 20),
    120_000,
  );
});
