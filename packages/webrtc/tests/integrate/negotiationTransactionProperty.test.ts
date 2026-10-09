import {
  createFuzzSession,
  expectFuzzSessionAlive,
  fuzzDescriptionPool,
  fuzzEpisode,
  fuzzRemoteMutation,
  fuzzRemoteRejection,
  seededRandom,
} from "./negotiationTransactionUtils";

/**
 * Property test: random operation sequences (offer / pranswer / answer /
 * rollback / replacement, ICE restart, BUNDLE split/merge, new m-lines,
 * end-of-candidates, routing-key mutations, invalid extmap remaps, the
 * description pool: saved offers / answers applied later or again, where a
 * refused application must change nothing, and the remote peer rejecting an
 * application, audio or video m-line in its offer or answer). After
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
const randomSeeds = [...Array(seedCount)].map((_, index) => firstSeed + index);
const longRegressionSeeds = process.env.WERIFT_NEGOTIATION_FUZZ_SEED
  ? []
  : [254, 302, 1385];

/**
 * Replay one seed: `steps` random operations, each followed by live traffic.
 * `pool` interleaves description-pool and remote-rejection episodes, each
 * drawn from its own random stream, so the main operations of a seed stay
 * the same; regression seeds replay without them.
 */
async function playSeed(seed: number, steps: number, pool = true) {
  // Arrange: RTX と header extension を持つ双方向 session と、seed 固定の乱数。
  const ctx = await createFuzzSession();
  const rng = seededRandom(seed);
  const poolRng = seededRandom(seed * 7919 + 13);
  const rejectionRng = seededRandom(seed * 104729 + 7);
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

      // Act: 保存した description の再利用 episode (拒否される操作は状態を変えない)。
      if (pool && poolRng.chance(0.5)) {
        await fuzzDescriptionPool(ctx, poolRng);
        // Assert: 再利用 episode の後も双方向に通信できる。
        await expectFuzzSessionAlive(ctx, `seed${seed}-step${index}-pool`);
      }

      // Act: 相手が application・audio・video のどれかの m-line を拒否する episode。
      if (pool && rejectionRng.chance(0.3)) {
        await fuzzRemoteRejection(ctx, rejectionRng);
        // Assert: 拒否の後も残りの経路は双方向に通信できる。
        await expectFuzzSessionAlive(ctx, `seed${seed}-step${index}-rejection`);
      }
    }
  } catch (error) {
    // DOMException の message は getter だけなので、seed と操作列を足した Error で包む。
    throw new Error(
      `${String(error)}\nseed ${seed} operations:\n  ${ctx.log.join("\n  ")}`,
      { cause: error },
    );
  } finally {
    await ctx.session.close();
  }
}

describe("negotiation transaction property", () => {
  test.each(randomSeeds)(
    "seed %i keeps both peers consistent and the session alive",
    (seed) => playSeed(seed, stepCount),
    60_000,
  );

  test.each(
    process.env.WERIFT_NEGOTIATION_FUZZ_SEED
      ? []
      : regressionSeeds.filter((seed) => !randomSeeds.includes(seed)),
  )(
    "regression seed %i keeps both peers consistent and the session alive",
    (seed) => playSeed(seed, stepCount, false),
    60_000,
  );

  test.each(longRegressionSeeds)(
    "regression seed %i (20 steps) keeps both peers consistent and the session alive",
    (seed) => playSeed(seed, 20, false),
    120_000,
  );
});
