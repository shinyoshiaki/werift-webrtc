/**
 * The deep property searches of `packages/webrtc` (`npm run pbt:deep`, run by
 * `packages/pbt`'s `runDeepSearch`; options in its `deep.ts`).
 *
 * Default suites (the deep searches of AGENTS.md Do 7):
 *   fuzz      tests/pbt/fuzz/negotiationTransactionProperty.test.ts, 300 seeds x 20 steps
 *   scenario  tests/pbt/scenario/negotiationScenarioProperty.test.ts, 300 seeds
 *   model     tests/pbt/model/negotiationModelProperty.test.ts, 300 seeds x 10 steps
 *   leak      tests/pbt/leak/negotiationLeakProperty.test.ts, 300 seeds x 10 steps
 *             (P1 and P2 with 6 cycles) and P3 (heap slope over 200 cycles)
 *             for `--heap-seeds` (default 4) seeds
 * Media suites (not in the default list; pass them with `--suite`):
 *   twcc      tests/pbt/twcc/twccProperty.test.ts, 300 seeds x 3000 steps
 *   bwe       tests/pbt/bwe/bweProperty.test.ts, 300 seeds x 3 phases
 *   sender    tests/pbt/sender/senderProperty.test.ts, 300 seeds x 300 steps
 *   receiver  tests/pbt/receiver/receiverProperty.test.ts, 300 seeds x 300 steps
 *   simulcastRtx tests/pbt/simulcastRtx/simulcastRtxProperty.test.ts, 300 seeds x 300 steps
 *
 *   npm run pbt:deep -- --suite twcc,bwe,sender,receiver,simulcastRtx
 * The heap slope verdict of P3 is statistical (`DeepShard.statistical`, the
 * `expect` marked with `STATISTICAL_FAILURE_MARKER` whose message matches
 * `HEAP_VERDICT`): its failure counts in the exit code only when the
 * `--baseline` revision does not fail the same verdict at least as far past
 * its thresholds (`heapVerdictExcess`); without `--baseline` it is reported
 * as statistical. Other failures of P3 (an operation that threw, a timeout, a
 * crash) and P1 / P2 always count.
 *
 * Before review, compare with develop so failures develop also has are
 * reported as pre-existing instead of failing the run:
 *   git worktree add --detach /tmp/werift-develop origin/develop
 *   # link or install the dependencies of the worktree (root and packages/*)
 *   npm run pbt:deep -- --baseline /tmp/werift-develop
 * The fixed scenes and regression seeds run once in their own shard. Every
 * shard is its own vitest process running one file, so the leak property's
 * process-wide measurements (active resources, heap) never mix with another
 * shard's.
 */
import type { DeepSearchConfig } from "../../../pbt/src";

const bytes = String.raw`-?\d+(?:\.\d+)? (?:B|KiB|MiB)`;
const slope = String.raw`slope ${bytes}/cycle \(R²=-?\d+\.\d+\) exceeds ${bytes}/cycle`;
const margin = String.raw`final median ${bytes} exceeds baseline ${bytes} \+ margin ${bytes}`;

/**
 * The whole message of the P3 heap verdict without
 * `STATISTICAL_FAILURE_MARKER` (`DeepShard.statisticalVerdict`): the cycle's
 * templates, a reason of `detectLeak` (tests/memleak) and `toBe(false)`. A
 * marked failure of this revision is statistical only when the rest matches
 * it, and a `--baseline` revision from before the marker fails it in this
 * form without the marker.
 */
export const HEAP_VERDICT = new RegExp(
  String.raw`^\[.*\]: (?:${slope}(?: and ${margin})?|${margin}): expected true to be false // Object\.is equality$`,
);

const unit = { B: 1, KiB: 1024, MiB: 1024 * 1024 } as const;
const toBytes = (value: string, name: string) =>
  Number(value) * unit[name as keyof typeof unit];
const amount = String.raw`(-?\d+(?:\.\d+)?) (B|KiB|MiB)`;

/**
 * How far a heap verdict (`HEAP_VERDICT`) went past its thresholds, in bytes
 * (`DeepShard.statisticalExcess`): the slope over its threshold and the final
 * median over baseline + margin, for each check the reason names. A
 * `--baseline` failure of the same verdict hides this one only when neither
 * is smaller there.
 */
export function heapVerdictExcess(message: string) {
  const excess: number[] = [];
  const s = message.match(
    new RegExp(
      String.raw`slope ${amount}/cycle \(R²=[^)]*\) exceeds ${amount}/cycle`,
    ),
  );
  if (s) excess.push(toBytes(s[1], s[2]) - toBytes(s[3], s[4]));
  const m = message.match(
    new RegExp(
      String.raw`final median ${amount} exceeds baseline ${amount} \+ margin ${amount}`,
    ),
  );
  if (m) {
    excess.push(
      toBytes(m[1], m[2]) - toBytes(m[3], m[4]) - toBytes(m[5], m[6]),
    );
  }
  return excess.length > 0 ? excess : undefined;
}

const config: DeepSearchConfig = {
  defaultSuites: ["fuzz", "scenario", "model", "leak"],
  env: {
    WERIFT_NEGOTIATION_MODEL_SHRINK: "0",
    WERIFT_NEGOTIATION_LEAK_SHRINK: "0",
  },
  // 1 分割あたりの時間が長い順 (leak、20 step の fuzz、…) に並べ、最後に待つ時間を減らす。
  suites: {
    leak: {
      file: "tests/pbt/leak/negotiationLeakProperty.test.ts",
      steps: 10,
      description:
        "P1 / P2 (6 cycles) per seed, P3 heap slope for --heap-seeds seeds",
      shards: ({ seeds, steps, ranges, option }) => {
        const file = "tests/pbt/leak/negotiationLeakProperty.test.ts";
        const heapSeeds = Number(option("heap-seeds") ?? 4);
        return [
          {
            label: "leak fixed scenes",
            file,
            pattern: "fixed: |close timing: ",
            env: { WERIFT_NEGOTIATION_LEAK_SEEDS: "0" },
          },
          ...ranges(seeds).map(({ first, count }) => ({
            label: `leak seeds ${first}-${first + count - 1}`,
            file,
            pattern: "seed \\d+ \\(replay",
            env: {
              WERIFT_NEGOTIATION_LEAK_SEED: String(first),
              WERIFT_NEGOTIATION_LEAK_SEEDS: String(count),
              WERIFT_NEGOTIATION_LEAK_STEPS: steps ?? "10",
              WERIFT_NEGOTIATION_LEAK_CYCLES: "6",
            },
          })),
          // P3 (heap slope) は 1 seed を 1 プロセスで実行する (heap を他の seed と混ぜない)。
          // 閾値の判定 (STATISTICAL_FAILURE_MARKER の assertion) の失敗だけは
          // 統計的なものとして、--baseline の比較でだけ判定する。
          ...ranges(heapSeeds, 1).map(({ first }) => ({
            label: `leak heap seed ${first}`,
            file,
            pattern: "heap seed \\d+ ",
            env: {
              WERIFT_NEGOTIATION_LEAK_SEED: String(first),
              WERIFT_NEGOTIATION_LEAK_SEEDS: "1",
              WERIFT_NEGOTIATION_LEAK_HEAP: "1",
            },
            statistical: true,
            statisticalVerdict: HEAP_VERDICT,
            statisticalExcess: heapVerdictExcess,
          })),
        ];
      },
    },
    fuzz: {
      file: "tests/pbt/fuzz/negotiationTransactionProperty.test.ts",
      steps: 20,
      shards: ({ seeds, steps, ranges }) => {
        const file = "tests/pbt/fuzz/negotiationTransactionProperty.test.ts";
        return [
          // 回帰 seed は FUZZ_SEED を指定しない実行にだけ含まれる。
          {
            label: "fuzz regressions",
            file,
            pattern: "regression seed",
            env: {},
          },
          ...ranges(seeds).map(({ first, count }) => ({
            label: `fuzz seeds ${first}-${first + count - 1}`,
            file,
            // Vitest 5 joins describe and test names with " > " (Vitest 4: " ").
            pattern: "^negotiation transaction property (> )?seed ",
            env: {
              WERIFT_NEGOTIATION_FUZZ_SEED: String(first),
              WERIFT_NEGOTIATION_FUZZ_SEEDS: String(count),
              WERIFT_NEGOTIATION_FUZZ_STEPS: steps ?? "20",
            },
          })),
        ];
      },
    },
    model: {
      file: "tests/pbt/model/negotiationModelProperty.test.ts",
      shards: ({ seeds, steps, ranges }) => {
        const file = "tests/pbt/model/negotiationModelProperty.test.ts";
        return [
          {
            label: "model fixed scenes",
            file,
            pattern: "fixed: ",
            env: { WERIFT_NEGOTIATION_MODEL_SEEDS: "0" },
          },
          ...ranges(seeds).map(({ first, count }) => ({
            label: `model seeds ${first}-${first + count - 1}`,
            file,
            pattern: " seed \\d+ \\(replay",
            env: {
              WERIFT_NEGOTIATION_MODEL_SEED: String(first),
              WERIFT_NEGOTIATION_MODEL_SEEDS: String(count),
              ...(steps ? { WERIFT_NEGOTIATION_MODEL_STEPS: steps } : {}),
            },
          })),
        ];
      },
    },
    scenario: {
      file: "tests/pbt/scenario/negotiationScenarioProperty.test.ts",
      shards: ({ seeds, steps, ranges }) => {
        const file = "tests/pbt/scenario/negotiationScenarioProperty.test.ts";
        return [
          { label: "scenario fixed scenes", file, pattern: "fixed: ", env: {} },
          ...ranges(seeds).map(({ first, count }) => ({
            label: `scenario seeds ${first}-${first + count - 1}`,
            file,
            pattern: " seed \\d+$",
            env: {
              WERIFT_NEGOTIATION_SCENARIO_SEED: String(first),
              WERIFT_NEGOTIATION_SCENARIO_SEEDS: String(count),
              ...(steps ? { WERIFT_NEGOTIATION_SCENARIO_STEPS: steps } : {}),
            },
          })),
        ];
      },
    },
    sender: {
      file: "tests/pbt/sender/senderProperty.test.ts",
      prefix: "WERIFT_SENDER",
    },
    receiver: {
      file: "tests/pbt/receiver/receiverProperty.test.ts",
      prefix: "WERIFT_RECEIVER",
    },
    simulcastRtx: {
      file: "tests/pbt/simulcastRtx/simulcastRtxProperty.test.ts",
      prefix: "WERIFT_SIMULCAST_RTX",
    },
    bwe: { file: "tests/pbt/bwe/bweProperty.test.ts", prefix: "WERIFT_BWE" },
    twcc: {
      file: "tests/pbt/twcc/twccProperty.test.ts",
      prefix: "WERIFT_TWCC",
    },
  },
};

export default config;
