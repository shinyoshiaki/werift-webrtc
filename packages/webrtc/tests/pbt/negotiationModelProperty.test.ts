import {
  type CaseMeta,
  describeCases,
  negotiationCase,
} from "../negotiation/harness/negotiationCase";
import {
  type Scene,
  generateScene,
  runScene,
  shrinkScene,
} from "./modelPropertyUtils";
import { MODEL_SCENES } from "./modelScenes";

/**
 * Model property of the negotiation transaction: whatever the operations,
 * after every description operation both peers keep the invariants, every
 * negotiated stream and DataChannel carries traffic (`c.expectTraffic()`)
 * and the oracles of `modelOracles.ts` hold (JSEP transition, rollback to
 * the transaction's start, events, idempotent re-application and creation,
 * trickle, commit of directions and codecs, committed DataChannels); every
 * scene ends with `expectSessionContinues`.
 *
 * - Fixed scenes (`modelScenes.ts`): regressions as short operation lists.
 * - Random scenes (`modelPropertyUtils.ts`): a start state and operations
 *   drawn by a seed. A failure prints the seed and the operations and, unless
 *   `WERIFT_NEGOTIATION_MODEL_SHRINK=0`, the smallest failing scene found by
 *   dropping operations (paste it into `modelScenes.ts`).
 *
 * CI runs `WERIFT_NEGOTIATION_MODEL_SEEDS` (default 4) seeds of
 * `WERIFT_NEGOTIATION_MODEL_STEPS` (default 10) operations from
 * `WERIFT_NEGOTIATION_MODEL_SEED` (default 1).
 */
const seedCount = Number(process.env.WERIFT_NEGOTIATION_MODEL_SEEDS ?? 4);
const stepCount = Number(process.env.WERIFT_NEGOTIATION_MODEL_STEPS ?? 10);
const firstSeed = Number(process.env.WERIFT_NEGOTIATION_MODEL_SEED ?? 1);
const shrink = process.env.WERIFT_NEGOTIATION_MODEL_SHRINK !== "0";
const seeds = [...Array(seedCount).keys()].map((i) => ({
  seed: firstSeed + i,
}));
const meta: CaseMeta = {
  ref: "2.1-5 2.1-10 2.1-11 2.1-T2 2.1-T8; property: model",
  traffic: true,
  // 失敗したときの縮小 (操作を 1 つずつ外して再実行) の時間を含める。
  timeout: shrink ? 300_000 : 60_000,
};

describeCases(
  "negotiation model property: every operation keeps the invariants, the traffic and the JSEP model",
  () => {
    for (const scene of MODEL_SCENES) {
      negotiationCase(
        `fixed: ${scene.name}`,
        { ref: scene.ref, traffic: true },
        async (c) => {
          // Arrange / Act: 固定の開始状態から操作列を順に実行する。
          // Assert: 各記述操作の後に invariant・通信・オラクルを検査する (ハーネス)。
          await runScene(c, scene);
        },
      );
    }

    negotiationCase.for(seeds)(
      `seed $seed (replay: WERIFT_NEGOTIATION_MODEL_SEED=$seed WERIFT_NEGOTIATION_MODEL_SEEDS=1 WERIFT_NEGOTIATION_MODEL_STEPS=${stepCount})`,
      meta,
      async (c, { seed }) => {
        // Arrange / Act: seed から開始状態と操作列を引き、順に実行する。
        // Assert: 各記述操作の後に invariant・通信・オラクルを検査する (ハーネス)。
        const scene: Scene = { start: "connected", ops: [] };
        try {
          await generateScene(c, seed, stepCount, scene);
          // 通信と継続確認も縮小の対象にするため、本体の中で終える。
          await c.end();
        } catch (error) {
          if (!shrink || !(error instanceof Error)) throw error;
          const small = await shrinkScene(`seed ${seed}`, meta, scene, 180_000);
          throw new Error(
            `${error.message}\nsmallest failing scene: ${JSON.stringify(small)}`,
            { cause: error },
          );
        }
      },
    );
  },
);
