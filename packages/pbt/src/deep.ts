/**
 * Deep property search in parallel, the same for every package: splits the
 * seeds of each property suite into shards and runs them as separate vitest
 * processes, `--jobs` (default: the CPU count) at a time, all suites in one
 * pool. A failed seed is replayed alone afterwards, so a failure caused by
 * CPU load is reported as flaky instead of failed. A vitest process that
 * ends abnormally (an exit code other than 0, e.g. an unhandled rejection
 * after the tests passed; a signal; no report) fails its shard even when every
 * test in its report passed; that shard is replayed alone too. Exit code 1
 * when a seed or a shard fails again when replayed alone.
 *
 * A package lists its suites in `tests/pbt/suites.ts` (a `DeepSearchConfig`
 * as default export) and runs them with `npm run pbt:deep`:
 *
 *   npm run pbt:deep                              # the default suites
 *   npm run pbt:deep -- --suite a,b --seeds 1000 --steps 50 --seed 1 --jobs 12
 *   npm run pbt:deep -- --list                    # the suites and their defaults
 *   npm run pbt:deep -- --dry-run                 # the shards, without running them
 *
 * A suite with a `prefix` is sharded by seed range: each shard sets
 * `<prefix>_SEED` / `_SEEDS` (and `_STEPS` with `--steps` or the suite's
 * `steps`) and selects the seed titles (`SEED_TITLE_PATTERN`). A suite whose
 * file also has fixed scenes or other shards gives its own `shards`. Every
 * shard is its own vitest process running one file with `--retry=0`.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SEED_TITLE_PATTERN } from "./seeds";

/** One vitest process: a file, a test-name pattern and the environment of its seeds. */
export type DeepShard = {
  label: string;
  file: string;
  pattern?: string;
  env: NodeJS.ProcessEnv;
};

/** What a suite's `shards` may read: the command-line options of the run. */
export type DeepContext = {
  /** `--seeds`, else the suite's `seeds`, else 300. */
  seeds: number;
  /** `--steps`, else the suite's `steps` (as a string), else undefined. */
  steps?: string;
  /** `--seed` (default 1): the first seed. */
  firstSeed: number;
  jobs: number;
  /** Any other `--<name> <value>` option (for example a suite's own count). */
  option: (name: string) => string | undefined;
  /** Seed ranges of about `size` seeds (default: at least `jobs * 3` shards). */
  ranges: (count: number, size?: number) => { first: number; count: number }[];
};

export type DeepSuite = {
  /** The property test file, relative to the package (`cwd`). */
  file: string;
  /** Seed variables `<prefix>_SEED(S)` / `_STEPS` (see `propertySeeds`). */
  prefix?: string;
  /** Seeds of the deep search (default 300). */
  seeds?: number;
  /** Steps per seed of the deep search (default: the test's own). */
  steps?: number;
  /** One line for `--list`. */
  description?: string;
  /** Shards replacing the seed ranges of `prefix` (fixed scenes, extra parts). */
  shards?: (context: DeepContext) => DeepShard[];
};

export type DeepSearchConfig = {
  /** The package directory the files are relative to (default: the working directory, as `npm run` sets it). */
  cwd?: string;
  /** Suites in the order the pool starts them (longest shards first). */
  suites: Record<string, DeepSuite>;
  /** The suites run without `--suite` (default: all). */
  defaultSuites?: string[];
  /** Environment added to every shard. */
  env?: NodeJS.ProcessEnv;
};

/** `--name value` options of `argv`. */
export function parseDeepArgs(argv: readonly string[]) {
  return (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
}

/**
 * Seed ranges from `first` of about `size` seeds each; without `size`, at
 * least `jobs * 3` ranges so the pool stays balanced.
 */
export function seedRanges(
  count: number,
  { first, jobs, size }: { first: number; jobs: number; size?: number },
) {
  const each = size ?? Math.max(1, Math.ceil(count / (jobs * 3)));
  const out: { first: number; count: number }[] = [];
  for (let offset = 0; offset < count; offset += each) {
    out.push({ first: first + offset, count: Math.min(each, count - offset) });
  }
  return out;
}

/** The seed-range shards of a suite with a `prefix`. */
export function prefixShards(
  name: string,
  suite: DeepSuite,
  context: DeepContext,
): DeepShard[] {
  const { prefix } = suite;
  if (!prefix) {
    throw new Error(`pbt:deep suite ${name} needs a prefix or its own shards`);
  }
  return context.ranges(context.seeds).map(({ first, count }) => ({
    label: `${name} seeds ${first}-${first + count - 1}`,
    file: suite.file,
    pattern: SEED_TITLE_PATTERN,
    env: {
      [`${prefix}_SEED`]: String(first),
      [`${prefix}_SEEDS`]: String(count),
      ...(context.steps ? { [`${prefix}_STEPS`]: context.steps } : {}),
    },
  }));
}

/** Every shard of the selected suites, in the config's order. */
export function planDeepSearch(
  config: DeepSearchConfig,
  argv: readonly string[],
  jobs: number,
) {
  const option = parseDeepArgs(argv);
  const names = Object.keys(config.suites);
  const selected = (
    option("suite")?.split(",") ??
    config.defaultSuites ??
    names
  ).filter(Boolean);
  for (const name of selected) {
    if (!config.suites[name]) {
      throw new Error(
        `unknown pbt:deep suite ${name} (suites: ${names.join(", ")})`,
      );
    }
  }
  const firstSeed = Number(option("seed") ?? 1);
  return names
    .filter((name) => selected.includes(name))
    .flatMap((name) => {
      const suite = config.suites[name];
      const steps = option("steps") ?? suite.steps?.toString();
      const context: DeepContext = {
        seeds: Number(option("seeds") ?? suite.seeds ?? 300),
        steps,
        firstSeed,
        jobs,
        option,
        ranges: (count, size) =>
          seedRanges(count, { first: firstSeed, jobs, size }),
      };
      const shards = suite.shards
        ? suite.shards(context)
        : prefixShards(name, suite, context);
      return shards.map((shard) => ({ suite: name, shard }));
    });
}

type Failure = { suite: string; title: string; shard: DeepShard };

/** One vitest process: its tests by status and how it ended. */
type ShardRun = {
  passed: number;
  /** Titles of the failed tests. */
  failed: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Whether the JSON report was written and parsed. */
  reported: boolean;
};

/**
 * Why a vitest process ended abnormally, or undefined when it exited 0 with
 * its report. vitest exits 1 for an error outside the test results (an
 * unhandled rejection or exception, a failing hook or file) even when every
 * test in the report passed, so the exit code and signal are checked besides
 * the report.
 */
export function abnormalExit({
  exitCode,
  signal,
  reported,
}: Pick<ShardRun, "exitCode" | "signal" | "reported">): string | undefined {
  if (signal) return `vitest was killed by ${signal}`;
  if (exitCode !== 0) {
    return exitCode === null
      ? "vitest could not be started"
      : `vitest exited with code ${exitCode} (an error outside the test results, e.g. an unhandled rejection)`;
  }
  if (!reported) return "vitest wrote no report";
  return undefined;
}

/** A replay that ran a test, failed none and ended normally. */
const passedCleanly = (result: ShardRun) =>
  result.passed > 0 && result.failed.length === 0 && !abnormalExit(result);

/** Run every shard of the selected suites; resolves the exit code. */
export async function runDeepSearch(
  config: DeepSearchConfig,
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const option = parseDeepArgs(argv);
  if (argv.includes("--list")) {
    for (const [name, suite] of Object.entries(config.suites)) {
      const isDefault = (config.defaultSuites ?? [name]).includes(name);
      console.log(
        `${name}${isDefault ? "" : " (not default)"}  ${suite.file}, ${suite.seeds ?? 300} seeds${suite.steps ? ` x ${suite.steps} steps` : ""}${suite.description ? `: ${suite.description}` : ""}`,
      );
    }
    return 0;
  }
  const jobs = Number(option("jobs") ?? cpus().length);
  const list = planDeepSearch(config, argv, jobs);
  if (argv.includes("--dry-run")) {
    for (const { suite, shard } of list) {
      console.log(
        `${suite}\t${shard.label}\t${shard.file}\t${shard.pattern ?? ""}\t${JSON.stringify(shard.env)}`,
      );
    }
    return 0;
  }
  const cwd = config.cwd ?? process.cwd();
  const require = createRequire(join(cwd, "package.json"));
  /** vitest's own entry (its package.json is exported; vitest.mjs sits beside it). */
  const vitest = join(
    dirname(require.resolve("vitest/package.json")),
    "vitest.mjs",
  );
  const work = mkdtempSync(join(tmpdir(), "pbt-deep-"));

  /**
   * Run one vitest process; returns the titles of its tests by status and
   * how the process ended.
   */
  const run = (shard: DeepShard, id: string, extraPattern?: string) => {
    const output = join(work, `${id}.json`);
    const pattern = extraPattern ?? shard.pattern;
    return new Promise<ShardRun>((resolve) => {
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
          env: { ...process.env, ...config.env, ...shard.env },
          stdio: "ignore",
        },
      );
      let settled = false;
      const settle = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (settled) return;
        settled = true;
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
            exitCode,
            signal,
            reported: true,
          });
        } catch {
          resolve({ passed: 0, failed: [], exitCode, signal, reported: false });
        }
      };
      child.on("exit", settle);
      // The process could not be started (no exit event follows).
      child.on("error", () => settle(null, null));
    });
  };

  const started = Date.now();
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
  for (const suite of [...new Set(list.map((item) => item.suite))]) {
    const indices = [...list.keys()].filter((i) => list[i].suite === suite);
    const failures: Failure[] = indices.flatMap((i) =>
      results[i].failed.map((title) => ({
        suite,
        title,
        shard: list[i].shard,
      })),
    );
    const passed = indices.reduce((sum, i) => sum + results[i].passed, 0);
    const tests =
      passed + indices.reduce((sum, i) => sum + results[i].failed.length, 0);
    // テスト名のパターンが合わず何も実行しなかった分割は失敗として扱う
    // (パターンの誤りで、再実行しても同じなので確定)。
    const confirmed: Failure[] = [];
    const ranNoTest = new Set<number>();
    for (const i of indices) {
      const result = results[i];
      if (result.reported && result.passed + result.failed.length === 0) {
        ranNoTest.add(i);
        confirmed.push({
          suite,
          title: `${list[i].shard.label}: ran no test`,
          shard: list[i].shard,
        });
      }
    }
    // 失敗は単独で再実行し、負荷による失敗 (flaky) と本当の失敗を分ける。単独で
    // 実行して通った (1 件以上実行し失敗なし、vitest も正常終了) ものだけが flaky。
    const flaky: Failure[] = [];
    let retries = 0;
    for (const failure of failures) {
      const again = await run(
        failure.shard,
        `${suite}-retry-${retries++}`,
        escapeRegExp(failure.title),
      );
      (passedCleanly(again) ? flaky : confirmed).push(failure);
    }
    // テストの結果に現れない異常終了 (assertion の後の未処理の rejection、
    // シグナル、レポートなし) は、その分割の題名の失敗がすべて flaky だったとき
    // にも説明がつかないので、分割を丸ごと単独で再実行して判定する。
    for (const i of indices) {
      const reason = abnormalExit(results[i]);
      const explained = failures.some(
        (failure) =>
          failure.shard === list[i].shard && confirmed.includes(failure),
      );
      if (!reason || explained || ranNoTest.has(i)) continue;
      const failure: Failure = {
        suite,
        title: `${list[i].shard.label}: ${reason}`,
        shard: list[i].shard,
      };
      const again = await run(list[i].shard, `${suite}-retry-${retries++}`);
      (passedCleanly(again) ? flaky : confirmed).push(failure);
    }
    const last = Math.max(...indices.map((i) => finished[i]));
    console.log(
      `${suite}: ${indices.length} shards, ${tests} tests, ${passed} passed, ` +
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
  return exit;
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
