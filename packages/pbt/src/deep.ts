/**
 * Deep property search in parallel, the same for every package: splits the
 * seeds of each property suite into shards and runs them as separate vitest
 * processes, `--jobs` (default: the CPU count) at a time, all suites in one
 * pool. A failed seed is replayed alone afterwards, so a failure caused by
 * CPU load is reported as flaky instead of failed. A vitest process that
 * ends abnormally (an exit code other than 0, e.g. an unhandled rejection
 * after the tests passed; a signal; no report) fails its shard even when every
 * test in its report passed; that shard is replayed alone too. A failure that
 * fails again alone is confirmed.
 *
 * A package lists its suites in `tests/pbt/suites.ts` (a `DeepSearchConfig`
 * as default export) and runs them with `npm run pbt:deep`:
 *
 *   npm run pbt:deep                              # the default suites
 *   npm run pbt:deep -- --suite a,b --seeds 1000 --steps 50 --seed 1 --jobs 12
 *   npm run pbt:deep -- --list                    # the suites and their defaults
 *   npm run pbt:deep -- --dry-run                 # the shards, without running them
 *   npm run pbt:deep -- --baseline /tmp/werift-develop [--baseline-runs 3]
 *
 * Baseline comparison (`--baseline <worktree root>`): the root of another
 * revision checked out with `git worktree add --detach <dir> <rev>` (never the
 * active worktree; its dependencies installed or linked as for
 * `tools/negotiation-diff`). Every confirmed failure is replayed in the same
 * package of that worktree with the same file, title pattern and environment,
 * up to `--baseline-runs` (default 3) times. It is pre-existing, reported and
 * left out of the exit code, when the baseline fails in the same form at
 * least once (`sameFailure`): for a test, a failure under the same title
 * (seed and replay environment included) whose message has the same
 * `failureSignature` (first line, numbers as `<n>`); for a shard that ended
 * abnormally, the same `abnormalExit` reason. A failure the baseline passes,
 * or fails in another form, stays confirmed. A shard that ran no test (a
 * wrong pattern of this revision) is never compared. No known-flake list is
 * kept: it would outlive the evidence, while the baseline replay records the
 * evidence in every run.
 *
 * Statistical shards (`DeepShard.statistical`, e.g. the heap slope P3 of the
 * webrtc leak property) are judged only against a baseline: without
 * `--baseline` a confirmed failure of one is reported as statistical and left
 * out of the exit code; with it, it is compared like any other failure.
 *
 * The output ends with `summary:` (confirmed / pre-existing / flaky /
 * statistical). Exit code 1 when a confirmed failure remains, 2 when the
 * baseline cannot be used.
 *
 * A suite with a `prefix` is sharded by seed range: each shard sets
 * `<prefix>_SEED` / `_SEEDS` (and `_STEPS` with `--steps` or the suite's
 * `steps`) and selects the seed titles (`SEED_TITLE_PATTERN`). A suite whose
 * file also has fixed scenes or other shards gives its own `shards`. Every
 * shard is its own vitest process running one file with `--retry=0`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, tmpdir } from "node:os";
import { dirname, join, relative, resolve as resolvePath } from "node:path";

import { SEED_TITLE_PATTERN } from "./seeds";

/** One vitest process: a file, a test-name pattern and the environment of its seeds. */
export type DeepShard = {
  label: string;
  file: string;
  pattern?: string;
  env: NodeJS.ProcessEnv;
  /**
   * A statistical check (for example a heap slope against a threshold): a
   * failure confirmed alone is judged only against `--baseline`; without it,
   * it is reported as statistical and left out of the exit code.
   */
  statistical?: boolean;
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

/** How a failure was found: a failed test title, a shard that ran no test, or a shard that ended abnormally. */
type FailureKind = "test" | "ranNoTest" | "abnormal";

type Failure = {
  suite: string;
  title: string;
  shard: DeepShard;
  kind: FailureKind;
  /**
   * The forms of the failure on this revision (`failureSignature` of the
   * first run and of the replay alone, or the abnormal-exit reason).
   */
  signatures: string[];
  /** What the baseline did when this failure was replayed there. */
  baseline?: string;
};

/** One vitest process: its tests by status and how it ended. */
type ShardRun = {
  passed: number;
  /** Titles of the failed tests. */
  failed: string[];
  /** `failureSignature` of each failed title. */
  messages: Record<string, string>;
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

/**
 * The form of a test failure that `--baseline` compares: the first non-empty
 * line of the first failure message, without ANSI colors, with every number
 * replaced by `<n>` (a heap slope of 16.01 and of 16.20 KiB/cycle, a timeout
 * after 5012 or 5034 ms are the same check failing). The test title, which
 * carries the seed and its replay environment, is compared separately.
 */
export function failureSignature(message: string | undefined) {
  const line =
    (message ?? "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI color codes
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.replace(/\d+(?:\.\d+)?/g, "<n>");
}

/**
 * Whether a replay of `failure` on the baseline failed in the same form: a
 * failed test under the same title whose `failureSignature` is one of the
 * failure's, or (for a shard that ended abnormally) the same abnormal-exit
 * reason.
 */
export function sameFailure(
  failure: Pick<Failure, "title" | "kind" | "signatures">,
  baseline: Pick<
    ShardRun,
    "failed" | "messages" | "exitCode" | "signal" | "reported"
  >,
) {
  if (failure.kind === "abnormal") {
    const reason = abnormalExit(baseline);
    return reason !== undefined && failure.signatures.includes(reason);
  }
  if (failure.kind !== "test" || !baseline.failed.includes(failure.title)) {
    return false;
  }
  return failure.signatures.includes(baseline.messages[failure.title] ?? "");
}

/** What a baseline replay did, for the report. */
const describeRun = (result: ShardRun, title?: string) => {
  if (title && result.failed.includes(title)) {
    return `failed: ${result.messages[title]}`;
  }
  if (result.failed.length > 0) return `failed: ${result.failed.join(", ")}`;
  const reason = abnormalExit(result);
  if (reason) return reason;
  return result.passed > 0 ? "passed" : "ran no test";
};

/** A replay that ran a test, failed none and ended normally. */
const passedCleanly = (result: ShardRun) =>
  result.passed > 0 && result.failed.length === 0 && !abnormalExit(result);

/**
 * The package directory of `cwd` inside another worktree: `cwd`'s path
 * relative to its worktree root (the nearest directory with a `.git` entry)
 * joined to `baselineRoot`.
 */
export function baselinePackageDir(baselineRoot: string, cwd: string) {
  let root = resolvePath(cwd);
  while (!existsSync(join(root, ".git"))) {
    const parent = dirname(root);
    if (parent === root) {
      throw new Error(`pbt:deep --baseline: ${cwd} is not inside a worktree`);
    }
    root = parent;
  }
  return join(resolvePath(baselineRoot), relative(root, resolvePath(cwd)));
}

/** vitest's own entry for a package directory (its package.json is exported; vitest.mjs sits beside it). */
const vitestEntry = (cwd: string) =>
  join(
    dirname(
      createRequire(join(cwd, "package.json")).resolve("vitest/package.json"),
    ),
    "vitest.mjs",
  );

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
        `${suite}\t${shard.label}\t${shard.file}\t${shard.pattern ?? ""}\t${JSON.stringify(shard.env)}${shard.statistical ? "\tstatistical" : ""}`,
      );
    }
    return 0;
  }
  const cwd = config.cwd ?? process.cwd();
  const vitest = vitestEntry(cwd);
  // 比較元 (--baseline) の同じパッケージと、その vitest を実行前に確かめる。
  const baselineRoot = option("baseline");
  const baselineRuns = Number(option("baseline-runs") ?? 3);
  let baseline: { cwd: string; vitest: string } | undefined;
  if (baselineRoot) {
    const baselineCwd = baselinePackageDir(baselineRoot, cwd);
    if (!existsSync(join(baselineCwd, "package.json"))) {
      console.error(
        `pbt:deep --baseline: ${baselineCwd} has no package.json (pass the root of a worktree made with git worktree add --detach)`,
      );
      return 2;
    }
    try {
      baseline = { cwd: baselineCwd, vitest: vitestEntry(baselineCwd) };
    } catch {
      console.error(
        `pbt:deep --baseline: vitest cannot be resolved from ${baselineCwd} (install or link the dependencies of the baseline worktree)`,
      );
      return 2;
    }
  }
  const work = mkdtempSync(join(tmpdir(), "pbt-deep-"));

  /**
   * Run one vitest process; returns the titles of its tests by status and
   * how the process ended. `target` is the baseline when replaying there.
   */
  const run = (
    shard: DeepShard,
    id: string,
    extraPattern?: string,
    target: { cwd: string; vitest: string } = { cwd, vitest },
  ) => {
    const output = join(work, `${id}.json`);
    const pattern = extraPattern ?? shard.pattern;
    return new Promise<ShardRun>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          target.vitest,
          "run",
          shard.file,
          "--retry=0",
          "--reporter=json",
          `--outputFile=${output}`,
          ...(pattern ? ["-t", pattern] : []),
        ],
        {
          cwd: target.cwd,
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
        type Result = {
          status: string;
          title: string;
          failureMessages?: string[];
        };
        try {
          const report = JSON.parse(readFileSync(output, "utf8"));
          const results: Result[] = report.testResults.flatMap(
            (file: { assertionResults: Result[] }) => file.assertionResults,
          );
          const failed = results.filter((r) => r.status === "failed");
          resolve({
            passed: results.filter((r) => r.status === "passed").length,
            failed: failed.map((r) => r.title),
            messages: Object.fromEntries(
              failed.map((r) => [
                r.title,
                failureSignature(r.failureMessages?.[0]),
              ]),
            ),
            exitCode,
            signal,
            reported: true,
          });
        } catch {
          resolve({
            passed: 0,
            failed: [],
            messages: {},
            exitCode,
            signal,
            reported: false,
          });
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
  const totals = { confirmed: 0, preExisting: 0, flaky: 0, statistical: 0 };
  let retries = 0;
  for (const suite of [...new Set(list.map((item) => item.suite))]) {
    const indices = [...list.keys()].filter((i) => list[i].suite === suite);
    const failures: Failure[] = indices.flatMap((i) =>
      results[i].failed.map((title) => ({
        suite,
        title,
        shard: list[i].shard,
        kind: "test" as const,
        signatures: [results[i].messages[title]],
      })),
    );
    const passed = indices.reduce((sum, i) => sum + results[i].passed, 0);
    const tests =
      passed + indices.reduce((sum, i) => sum + results[i].failed.length, 0);
    // テスト名のパターンが合わず何も実行しなかった分割は失敗として扱う
    // (パターンの誤りで、再実行しても同じなので確定。比較元とは突き合わせない)。
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
          kind: "ranNoTest",
          signatures: [],
        });
      }
    }
    // 失敗は単独で再実行し、負荷による失敗 (flaky) と本当の失敗を分ける。単独で
    // 実行して通った (1 件以上実行し失敗なし、vitest も正常終了) ものだけが flaky。
    const flaky: Failure[] = [];
    for (const failure of failures) {
      const again = await run(
        failure.shard,
        `${suite}-retry-${retries++}`,
        escapeRegExp(failure.title),
      );
      if (passedCleanly(again)) {
        flaky.push(failure);
        continue;
      }
      const message = again.messages[failure.title];
      if (message !== undefined && !failure.signatures.includes(message)) {
        failure.signatures.push(message);
      }
      confirmed.push(failure);
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
        kind: "abnormal",
        signatures: [reason],
      };
      const again = await run(list[i].shard, `${suite}-retry-${retries++}`);
      (passedCleanly(again) ? flaky : confirmed).push(failure);
    }
    // 確定した失敗を比較元で同じ env のまま最大 --baseline-runs 回再生する。同じ形で
    // 1 回でも失敗すれば以前からの失敗 (pre-existing) とし、終了コードに含めない。
    const preExisting: Failure[] = [];
    const statistical: Failure[] = [];
    for (const failure of [...confirmed]) {
      if (failure.kind === "ranNoTest") continue;
      if (!baseline) {
        // 統計的な判定 (heap slope など) は比較元との比較でだけ判定する。
        if (failure.shard.statistical) {
          confirmed.splice(confirmed.indexOf(failure), 1);
          statistical.push(failure);
        }
        continue;
      }
      const outcomes: string[] = [];
      for (let attempt = 0; attempt < baselineRuns; attempt++) {
        const result = await run(
          failure.shard,
          `${suite}-baseline-${retries++}`,
          failure.kind === "test" ? escapeRegExp(failure.title) : undefined,
          baseline,
        );
        outcomes.push(describeRun(result, failure.title));
        if (sameFailure(failure, result)) {
          failure.baseline = `failed the same way on the baseline (attempt ${attempt + 1}): ${outcomes.at(-1)}`;
          confirmed.splice(confirmed.indexOf(failure), 1);
          preExisting.push(failure);
          break;
        }
      }
      failure.baseline ??= `baseline: ${outcomes.join("; ")}`;
    }
    const last = Math.max(...indices.map((i) => finished[i]));
    console.log(
      `${suite}: ${indices.length} shards, ${tests} tests, ${passed} passed, ` +
        `${confirmed.length} failed, ${preExisting.length} pre-existing, ${flaky.length} flaky, ` +
        `${statistical.length} statistical, done at ${((last - started) / 1000).toFixed(0)}s`,
    );
    for (const failure of confirmed) {
      console.log(`  FAILED ${failure.title}`);
      console.log(`    env: ${JSON.stringify(failure.shard.env)}`);
      if (failure.signatures[0]) {
        console.log(`    error: ${failure.signatures[0]}`);
      }
      if (failure.baseline) console.log(`    ${failure.baseline}`);
    }
    for (const failure of preExisting) {
      console.log(`  pre-existing ${failure.title}`);
      console.log(`    env: ${JSON.stringify(failure.shard.env)}`);
      console.log(`    ${failure.baseline}`);
    }
    for (const failure of flaky) {
      console.log(`  flaky (passed alone) ${failure.title}`);
    }
    for (const failure of statistical) {
      console.log(
        `  statistical (judged only with --baseline) ${failure.title}`,
      );
      console.log(`    env: ${JSON.stringify(failure.shard.env)}`);
      if (failure.signatures[0]) {
        console.log(`    error: ${failure.signatures[0]}`);
      }
    }
    totals.confirmed += confirmed.length;
    totals.preExisting += preExisting.length;
    totals.flaky += flaky.length;
    totals.statistical += statistical.length;
  }
  console.log(
    `total ${((Date.now() - started) / 1000).toFixed(0)}s (${jobs} jobs)`,
  );
  console.log(
    `summary: ${totals.confirmed} confirmed (exit code), ` +
      `${totals.preExisting} pre-existing (${baseline ? `same failure on ${baseline.cwd}` : "no --baseline"}), ` +
      `${totals.flaky} flaky (passed alone), ` +
      `${totals.statistical} statistical (not judged without --baseline)`,
  );
  rmSync(work, { recursive: true, force: true });
  return totals.confirmed > 0 ? 1 : 0;
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
