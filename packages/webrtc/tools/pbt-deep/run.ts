/**
 * Deep property search in parallel: splits the seeds of each property test
 * into shards and runs them as
 * separate vitest processes, `--jobs` (default: the CPU count) at a time,
 * all suites in one pool. A failed seed is replayed
 * alone afterwards, so a failure caused by CPU load (the traffic checks have
 * a 2 s budget) is reported as flaky instead of failed.
 *
 *   npm run pbt:deep                         # every suite, the review depth
 *   npm run pbt:deep -- --suite model --seeds 1000 --jobs 12
 *
 * Suites (defaults = the deep searches of AGENTS.md Do 7):
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
 *
 *   npm run pbt:deep -- --suite twcc,bwe,sender
 * The fixed scenes and regression seeds run once in their own shard. Every
 * shard is its own vitest process running one file, so the leak property's
 * process-wide measurements (active resources, heap) never mix with another
 * shard's.
 * Exit code 1 when a seed fails again when replayed alone.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";

type Suite = "fuzz" | "scenario" | "model" | "leak" | MediaSuite;
type MediaSuite = "twcc" | "bwe" | "sender";

/** Media property tests: one file, seeds from `<prefix>_SEED(S)` (tests/pbt/shared/seeds.ts). */
const mediaSuites: Record<MediaSuite, { file: string; prefix: string }> = {
  twcc: { file: "tests/pbt/twcc/twccProperty.test.ts", prefix: "WERIFT_TWCC" },
  bwe: { file: "tests/pbt/bwe/bweProperty.test.ts", prefix: "WERIFT_BWE" },
  sender: {
    file: "tests/pbt/sender/senderProperty.test.ts",
    prefix: "WERIFT_SENDER",
  },
};
type Shard = {
  label: string;
  file: string;
  pattern?: string;
  env: NodeJS.ProcessEnv;
};
type Failure = { suite: Suite; title: string; shard: Shard };

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const suites = (option("suite") ?? "fuzz,scenario,model,leak").split(
  ",",
) as Suite[];
const jobs = Number(option("jobs") ?? cpus().length);
const seedsOption = option("seeds");
const stepsOption = option("steps");
const firstSeed = Number(option("seed") ?? 1);
const heapSeeds = Number(option("heap-seeds") ?? 4);
/** vitest's own entry (its package.json is exported; vitest.mjs sits beside it). */
const vitest = join(
  dirname(require.resolve("vitest/package.json")),
  "vitest.mjs",
);
const cwd = join(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "pbt-deep-"));

/** Seed ranges of about `size` seeds each, at least `jobs * 3` shards for balance (or `size` given). */
function ranges(count: number, fixedSize?: number) {
  const size = fixedSize ?? Math.max(1, Math.ceil(count / (jobs * 3)));
  const out: { first: number; count: number }[] = [];
  for (let offset = 0; offset < count; offset += size) {
    out.push({
      first: firstSeed + offset,
      count: Math.min(size, count - offset),
    });
  }
  return out;
}

function shards(suite: Suite): Shard[] {
  const seeds = Number(seedsOption ?? 300);
  switch (suite) {
    case "fuzz": {
      const file = "tests/pbt/fuzz/negotiationTransactionProperty.test.ts";
      const steps = stepsOption ?? "20";
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
          pattern: "^negotiation transaction property seed ",
          env: {
            WERIFT_NEGOTIATION_FUZZ_SEED: String(first),
            WERIFT_NEGOTIATION_FUZZ_SEEDS: String(count),
            WERIFT_NEGOTIATION_FUZZ_STEPS: steps,
          },
        })),
      ];
    }
    case "scenario": {
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
            ...(stepsOption
              ? { WERIFT_NEGOTIATION_SCENARIO_STEPS: stepsOption }
              : {}),
          },
        })),
      ];
    }
    case "twcc":
    case "bwe":
    case "sender": {
      const { file, prefix } = mediaSuites[suite];
      return ranges(seeds).map(({ first, count }) => ({
        label: `${suite} seeds ${first}-${first + count - 1}`,
        file,
        pattern: ": seed \\d+ \\(replay",
        env: {
          [`${prefix}_SEED`]: String(first),
          [`${prefix}_SEEDS`]: String(count),
          ...(stepsOption ? { [`${prefix}_STEPS`]: stepsOption } : {}),
        },
      }));
    }
    case "model": {
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
            ...(stepsOption
              ? { WERIFT_NEGOTIATION_MODEL_STEPS: stepsOption }
              : {}),
          },
        })),
      ];
    }
    case "leak": {
      const file = "tests/pbt/leak/negotiationLeakProperty.test.ts";
      const steps = stepsOption ?? "10";
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
            WERIFT_NEGOTIATION_LEAK_STEPS: steps,
            WERIFT_NEGOTIATION_LEAK_CYCLES: "6",
          },
        })),
        // P3 (heap slope) は 1 seed を 1 プロセスで実行する (heap を他の seed と混ぜない)。
        ...ranges(heapSeeds, 1).map(({ first }) => ({
          label: `leak heap seed ${first}`,
          file,
          pattern: "heap seed \\d+ ",
          env: {
            WERIFT_NEGOTIATION_LEAK_SEED: String(first),
            WERIFT_NEGOTIATION_LEAK_SEEDS: "1",
            WERIFT_NEGOTIATION_LEAK_HEAP: "1",
          },
        })),
      ];
    }
  }
}

/** Run one vitest process; returns the titles of its tests by status. */
function run(shard: Shard, id: string, extraPattern?: string) {
  const output = join(work, `${id}.json`);
  const pattern = extraPattern ?? shard.pattern;
  return new Promise<{ passed: number; failed: string[] }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        vitest,
        "run",
        shard.file,
        "--retry=0",
        "--reporter=json",
        `--outputFile=${output}`,
        ...(pattern ? ["-t", pattern] : []),
      ],
      {
        cwd,
        env: {
          ...process.env,
          ...shard.env,
          WERIFT_NEGOTIATION_MODEL_SHRINK: "0",
          WERIFT_NEGOTIATION_LEAK_SHRINK: "0",
        },
        stdio: "ignore",
      },
    );
    child.on("exit", () => {
      try {
        const report = JSON.parse(readFileSync(output, "utf8"));
        const results = report.testResults.flatMap(
          (file: { assertionResults: { status: string; title: string }[] }) =>
            file.assertionResults,
        );
        resolve({
          passed: results.filter(
            (r: { status: string }) => r.status === "passed",
          ).length,
          failed: results
            .filter((r: { status: string }) => r.status === "failed")
            .map((r: { title: string }) => r.title),
        });
      } catch {
        resolve({
          passed: 0,
          failed: [`${shard.label}: no report (the process crashed)`],
        });
      }
    });
  });
}

/** Run `tasks` with at most `limit` at a time. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number) {
  const results: T[] = [];
  let next = 0;
  await Promise.all(
    [...Array(Math.min(limit, tasks.length))].map(async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]();
      }
    }),
  );
  return results;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function main() {
  const started = Date.now();
  // 全 suite の分割を 1 つの pool に入れ、suite の境目で待たない。1 分割あたりの
  // 時間が長い順 (20 step の fuzz、…) に並べ、最後に待つ時間を減らす。
  const order: Suite[] = [
    "leak",
    "fuzz",
    "model",
    "scenario",
    "sender",
    "bwe",
    "twcc",
  ];
  const list = order
    .filter((suite) => suites.includes(suite))
    .flatMap((suite) => shards(suite).map((shard) => ({ suite, shard })));
  const finished: number[] = [];
  const results = await pool(
    list.map(({ suite, shard }, index) => async () => {
      const result = await run(shard, `${suite}-${index}`);
      finished[index] = Date.now();
      return result;
    }),
    jobs,
  );
  let exit = 0;
  for (const suite of suites) {
    const indices = [...list.keys()].filter((i) => list[i].suite === suite);
    const failures: Failure[] = indices.flatMap((i) =>
      results[i].failed.map((title) => ({
        suite,
        title,
        shard: list[i].shard,
      })),
    );
    const passed = indices.reduce((sum, i) => sum + results[i].passed, 0);
    // テスト名のパターンが合わず何も実行しなかった分割は失敗として扱う。
    for (const i of indices) {
      if (results[i].passed + results[i].failed.length === 0) {
        failures.push({
          suite,
          title: `${list[i].shard.label}: ran no test`,
          shard: list[i].shard,
        });
      }
    }
    // 失敗は単独で再実行し、負荷による失敗 (flaky) と本当の失敗を分ける。
    const confirmed: Failure[] = [];
    const flaky: Failure[] = [];
    for (const [index, failure] of failures.entries()) {
      const again = await run(
        failure.shard,
        `${suite}-retry-${index}`,
        escapeRegExp(failure.title),
      );
      // 単独で実行して通った (1 件以上実行し失敗なし) ものだけが flaky。何も実行
      // しない分割やプロセスの異常終了は、そのまま失敗として扱う。
      const passedAlone = again.passed > 0 && again.failed.length === 0;
      (passedAlone ? flaky : confirmed).push(failure);
    }
    const last = Math.max(...indices.map((i) => finished[i]));
    console.log(
      `${suite}: ${indices.length} shards, ${passed + failures.length} tests, ${passed} passed, ` +
        `${confirmed.length} failed, ${flaky.length} flaky, done at ${((last - started) / 1000).toFixed(0)}s`,
    );
    for (const failure of confirmed) {
      console.log(`  FAILED ${failure.title}`);
      console.log(`    env: ${JSON.stringify(failure.shard.env)}`);
    }
    for (const failure of flaky) {
      console.log(`  flaky (passed alone) ${failure.title}`);
    }
    if (confirmed.length) exit = 1;
  }
  console.log(
    `total ${((Date.now() - started) / 1000).toFixed(0)}s (${jobs} jobs)`,
  );
  rmSync(work, { recursive: true, force: true });
  process.exit(exit);
}

main();
