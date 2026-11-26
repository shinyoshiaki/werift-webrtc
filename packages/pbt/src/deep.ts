/**
 * Deep property search in parallel, the same for every package: splits the
 * seeds of each property suite into shards and runs them as separate vitest
 * processes, `--jobs` (default: the CPU count) at a time, all suites in one
 * pool. A failed seed is replayed alone afterwards, so a failure caused by
 * CPU load is reported as flaky instead of failed. A vitest process that
 * ends abnormally (an exit code other than 0, e.g. an unhandled rejection
 * after the tests passed; a signal; no report) fails its shard even when every
 * test in its report passed; that shard is replayed alone too. A failure that
 * fails again alone is confirmed. Flaky needs the replay to pass the failed
 * test itself (by full name) or, for a shard replayed whole, every test its
 * first run ran: a test skipped on the replay is not a pass.
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
 * active worktree, which is rejected before anything runs, as is a directory
 * that is not a worktree root and a checkout whose commit contains this
 * worktree's HEAD; its dependencies installed or linked as for
 * `tools/negotiation-diff`). Every confirmed failure is replayed in the same
 * package of that worktree with the same file, title pattern and environment,
 * up to `--baseline-runs` (default 3) times. It is pre-existing, reported and
 * left out of the exit code, when the baseline reproduces every form observed
 * on this revision (the first run and the replay alone; `sameFailure`): for a
 * test, a failure of the same test (full name, so seed and replay environment
 * included) whose errors have the same `failureSignature`s (the whole cause:
 * name, message, expected and actual, the failing source line, `cause`); for
 * errors outside the test results (unhandled errors, failing files and
 * hooks), each of those errors by its `failureSignature`, never by the exit
 * code. Those errors are judged on their own, also when a test of the same
 * shard failed. A failure the baseline passes, or fails in another form,
 * stays confirmed, and so does one without a comparable cause: a signal, no
 * report, an exit code no error explains, or an error without a message. A
 * shard that ran no test (a wrong pattern of this revision) is never
 * compared. No known-flake list is kept: it would outlive the evidence, while
 * the baseline replay records the evidence in every run.
 *
 * Statistical failures: in a shard marked `DeepShard.statistical` (e.g. the
 * heap slope P3 of the webrtc leak property), a test failure whose errors are
 * all statistical assertions is judged only against a baseline: failed
 * `expect`s (`AssertionError`, no cause) whose message starts with
 * `STATISTICAL_FAILURE_MARKER` and whose rest matches the shard's
 * `DeepShard.statisticalVerdict` (`isStatisticalError`). Without `--baseline`
 * a confirmed one is reported as statistical and left out of the exit code;
 * with it, it is compared like any other failure (a baseline from before the
 * marker matches through `statisticalVerdict`), and the baseline must also
 * have gone at least as far past each threshold (`DeepShard.statisticalExcess`),
 * so a larger measurement is not hidden by a borderline one. Every other
 * failure of such a shard (an operation that threw, also with the marker's
 * text, a timeout, a hook, an unhandled error, a crash) is a normal failure.
 *
 * The output ends with `summary:` (confirmed / pre-existing / flaky /
 * statistical). Exit code 1 when a confirmed failure remains, 2 when
 * `--baseline` has no path (checked before anything runs) or the
 * baseline cannot be used.
 *
 * A suite with a `prefix` is sharded by seed range: each shard sets
 * `<prefix>_SEED` / `_SEEDS` (and `_STEPS` with `--steps` or the suite's
 * `steps`) and selects the seed titles (`SEED_TITLE_PATTERN`). A suite whose
 * file also has fixed scenes or other shards gives its own `shards`. Every
 * shard is its own vitest process running one file with `--retry=0`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { cpus, tmpdir } from "node:os";
import { dirname, join, relative, resolve as resolvePath } from "node:path";

import { reporterPath } from "./deepReporter.mjs";
import {
  failureSignature,
  isStatisticalError,
  type ReportedError,
  statisticalExcess,
  testSignature,
} from "./failureForm";
import { SEED_TITLE_PATTERN } from "./seeds";

/** One vitest process: a file, a test-name pattern and the environment of its seeds. */
export type DeepShard = {
  label: string;
  file: string;
  pattern?: string;
  env: NodeJS.ProcessEnv;
  /**
   * The shard has a statistical check (for example a heap slope against a
   * threshold) whose `expect` message starts with
   * `STATISTICAL_FAILURE_MARKER`. A failure of that assertion confirmed alone
   * (`isStatisticalError`: a failed `expect`, not an `Error` with the marker's
   * text) is judged only against `--baseline`; without it, it is reported as
   * statistical and left out of the exit code. Other failures count as usual.
   * It needs `statisticalVerdict`: without one, no failure is statistical.
   */
  statistical?: boolean;
  /**
   * The whole message of the statistical assertion without the marker,
   * anchored to that one assertion. A marked failure of this revision whose
   * rest does not match it is a normal failure; an unmarked one of a
   * `--baseline` from before the marker that matches it has the same form as
   * the marked one here.
   */
  statisticalVerdict?: RegExp;
  /**
   * How far a message of the statistical assertion (without the marker) went
   * past its thresholds, one number per check, larger is worse (default: every
   * number of the message in order). A baseline's failure is the same only
   * when none of these is smaller than here (`statisticalExcess`).
   */
  statisticalExcess?: (message: string) => number[] | undefined;
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
 * Why `--baseline` in `argv` names no path, or undefined when it is absent or
 * has one. Such a run must not go on as one without a comparison (its
 * statistical failures would leave the exit code): the option without a value,
 * with an empty one (an unset shell variable) or followed by another option,
 * and the `--baseline=<path>` form `parseDeepArgs` does not read.
 */
function baselineArgumentError(argv: readonly string[]) {
  const invalid = argv.some((arg, index) => {
    if (arg.startsWith("--baseline=")) return true;
    const value = argv[index + 1];
    return arg === "--baseline" && (!value || value.startsWith("--"));
  });
  return invalid
    ? "pbt:deep --baseline: no path given (pass --baseline <worktree root>, as two arguments)"
    : undefined;
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

/** How a failure was found: a failed test, a shard that ran no test, or errors outside the test results (or an abnormal end). */
type FailureKind = "test" | "ranNoTest" | "abnormal";

type Failure = {
  suite: string;
  /** The test's full name (the title of other kinds). */
  id: string;
  title: string;
  shard: DeepShard;
  kind: FailureKind;
  /** The distinct forms (`failureSignature`) observed on this revision. */
  forms: string[];
  /** Why the cause cannot be compared with a baseline (the failure stays confirmed). */
  uncomparable?: string;
  /** Every observed run failed only statistical assertions. */
  statistical: boolean;
  /** Per statistical form, the largest `statisticalExcess` observed on this revision. */
  excess?: Record<string, number[]>;
  /** What the baseline did when this failure was replayed there. */
  baseline?: string;
};

type TestFailure = {
  /** The full name (describe names and title). */
  id: string;
  title: string;
  /** `testSignature` of its errors. */
  signature?: string;
  /** Whether every error is a statistical assertion. */
  statistical: boolean;
  /** `statisticalExcess` of its errors (undefined: not all statistical). */
  excess?: number[];
};

/** One vitest process: its tests by status and how it ended. */
type ShardRun = {
  passed: number;
  /** The full names of the passed tests. */
  passedIds: string[];
  failed: TestFailure[];
  /** `failureSignature` of each error outside the test results (undefined: not comparable). */
  outside: (string | undefined)[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Whether the report was written and parsed. */
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
 * What a run shows besides its test results, or undefined when its test
 * results explain how it ended: errors outside the tests, or an end no error
 * explains (a signal, no report, an exit code other than 0 without a failed
 * test or other than 1), which has no comparable cause.
 */
function outsideProblem(run: ShardRun) {
  const reason =
    abnormalExit(run) ?? "vitest reported errors outside the test results";
  if (run.signal || !run.reported || run.exitCode === null) {
    return { reason, forms: [], uncomparable: reason };
  }
  if (run.outside.length > 0) {
    const forms = run.outside.filter((form) => form !== undefined);
    return {
      reason,
      forms,
      uncomparable:
        forms.length < run.outside.length
          ? "an error outside the test results has no message"
          : undefined,
    };
  }
  const explained =
    run.exitCode === 0 || (run.exitCode === 1 && run.failed.length > 0);
  return explained ? undefined : { reason, forms: [], uncomparable: reason };
}

/** The largest value of each position, or undefined when the lengths differ. */
function largest(values: number[][]) {
  const [first, ...rest] = values;
  if (!first || rest.some((v) => v.length !== first.length)) return undefined;
  return first.map((n, i) => Math.max(n, ...rest.map((v) => v[i])));
}

/**
 * Whether replays on the baseline reproduced `failure`: every form observed on
 * this revision appeared in one of `runs`, as errors of the same test (by full
 * name) or, for errors outside the tests, among the baseline's errors outside
 * the tests. A statistical form (`Failure.excess`) also needs the baseline to
 * have gone at least as far past each threshold as this revision did (the
 * largest excess of its same-form failures, position by position), so a worse
 * measurement is not hidden by a borderline one. False for a failure without
 * a comparable cause.
 */
export function sameFailure(
  failure: Pick<Failure, "id" | "kind" | "forms" | "uncomparable" | "excess">,
  runs: Pick<ShardRun, "failed" | "outside" | "signal" | "reported">[],
) {
  if (
    failure.kind === "ranNoTest" ||
    failure.uncomparable ||
    failure.forms.length === 0
  ) {
    return false;
  }
  return failure.forms.every((form) => {
    if (failure.kind !== "test") {
      return runs.some(
        (run) => run.reported && !run.signal && run.outside.includes(form),
      );
    }
    const same = runs.flatMap((run) =>
      run.failed.filter((t) => t.id === failure.id && t.signature === form),
    );
    if (same.length === 0) return false;
    const here = failure.excess?.[form];
    if (!here) return true;
    const there = largest(same.flatMap((t) => (t.excess ? [t.excess] : [])));
    return (
      there !== undefined &&
      there.length === here.length &&
      here.every((n, i) => n <= there[i])
    );
  });
}

/** Add the forms (and the excess of statistical forms) one more run showed to `failure`. */
function addForms(
  failure: Failure,
  {
    forms,
    uncomparable,
    excess,
  }: {
    forms: string[];
    uncomparable?: string;
    excess?: Record<string, number[]>;
  },
) {
  failure.forms = [...new Set([...failure.forms, ...forms])];
  failure.uncomparable ??= uncomparable;
  for (const [form, value] of Object.entries(excess ?? {})) {
    const seen = failure.excess?.[form];
    const worst = seen ? largest([seen, value]) : value;
    if (!worst) {
      failure.uncomparable ??=
        "a statistical form was measured with different checks";
      continue;
    }
    failure.excess = { ...failure.excess, [form]: worst };
  }
}

/** What one run of a failed test adds to its failure. */
const observed = (test: TestFailure) => ({
  forms: test.signature === undefined ? [] : [test.signature],
  uncomparable:
    test.signature === undefined
      ? "the test failed without an error message"
      : undefined,
  excess:
    test.signature !== undefined && test.excess
      ? { [test.signature]: test.excess }
      : undefined,
});

const firstLine = (form: string | undefined) =>
  form?.split("\n").find((line) => line.trim()) ?? "(no error message)";

/** A failure's forms for the output, each cut to its first lines. */
function printForms(failure: Failure, lines = 12) {
  for (const form of failure.forms) {
    const all = form.split("\n");
    console.log(`    error: ${all.slice(0, lines).join("\n      ")}`);
    if (all.length > lines) {
      console.log(`      … (${all.length - lines} more lines)`);
    }
  }
}

/** What a baseline replay did, for the report. */
const describeRun = (result: ShardRun, id?: string) => {
  const same = result.failed.find((t) => t.id === id);
  if (same) return `failed: ${firstLine(same.signature)}`;
  if (result.failed.length > 0) {
    return `failed: ${result.failed.map((t) => t.title).join(", ")}`;
  }
  if (result.outside.length > 0) {
    return `errors outside the tests: ${result.outside.map(firstLine).join(", ")}`;
  }
  const reason = abnormalExit(result);
  if (reason) return reason;
  return result.passed > 0 ? "passed" : "ran no test";
};

/**
 * A replay that ran a test, failed none, ended normally and passed every test
 * of `ids` (full names): the failed test itself, not only another test the
 * pattern also selects while it is skipped.
 */
const passedCleanly = (result: ShardRun, ids: readonly string[]) =>
  result.passed > 0 &&
  result.failed.length === 0 &&
  ids.every((id) => result.passedIds.includes(id)) &&
  !abnormalExit(result) &&
  !outsideProblem(result);

/** A package of one revision: its directory, its worktree root and its vitest. */
type Target = { cwd: string; root: string; vitest: string; commit?: string };

/** The nearest directory from `cwd` up with a `.git` entry. */
function worktreeRoot(cwd: string) {
  let root = resolvePath(cwd);
  while (!existsSync(join(root, ".git"))) {
    const parent = dirname(root);
    if (parent === root) {
      throw new Error(`pbt:deep: ${cwd} is not inside a worktree`);
    }
    root = parent;
  }
  return root;
}

/**
 * The package directory of `cwd` inside another worktree: `cwd`'s path
 * relative to its worktree root joined to `baselineRoot`.
 */
export function baselinePackageDir(baselineRoot: string, cwd: string) {
  return join(
    resolvePath(baselineRoot),
    relative(worktreeRoot(cwd), resolvePath(cwd)),
  );
}

/** `git -C <dir> <args>`: the exit status and the trimmed output. */
function git(dir: string, args: string[]) {
  const { status, stdout } = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
  });
  return { status, out: status === 0 ? stdout.trim() : undefined };
}

/** The commit checked out in `dir`, or undefined when git cannot read one. */
const headCommit = (dir: string) =>
  git(dir, ["rev-parse", "--verify", "HEAD^{commit}"]).out;

/**
 * Why the package `baselineCwd` of `baselineRoot` cannot be the baseline of
 * the package `cwd`, or undefined when it can. This checkout compared with
 * itself would repeat every failure and report it as pre-existing, so the
 * baseline must be the root of another worktree whose package is another
 * directory; real paths are compared, so a relative path or a symlink to this
 * checkout is the same one. Another checkout of this revision repeats them
 * too, so the baseline's commit must not contain this worktree's HEAD (the
 * same commit or a later one): only a revision before the change, such as
 * develop, can show that a failure was there before it. Both must be git
 * checkouts with a commit, or this cannot be checked.
 */
function baselineError(baselineRoot: string, baselineCwd: string, cwd: string) {
  if (!existsSync(join(baselineCwd, "package.json"))) {
    return `${baselineCwd} has no package.json (pass the root of a worktree made with git worktree add --detach)`;
  }
  if (!existsSync(join(baselineRoot, ".git"))) {
    return `${resolvePath(baselineRoot)} is not a worktree root (it has no .git; make one with git worktree add --detach)`;
  }
  if (realpathSync(baselineRoot) === realpathSync(worktreeRoot(cwd))) {
    return `${resolvePath(baselineRoot)} is this worktree (compare with another revision checked out with git worktree add --detach)`;
  }
  if (realpathSync(baselineCwd) === realpathSync(cwd)) {
    return `${baselineCwd} is the package of this worktree (the baseline needs its own checkout of the package)`;
  }
  const root = worktreeRoot(cwd);
  const head = headCommit(root);
  if (!head) {
    return `the commit of this worktree (${root}) cannot be read with git, so the baseline cannot be checked to be an earlier revision`;
  }
  const baselineHead = headCommit(baselineRoot);
  if (!baselineHead) {
    return `${resolvePath(baselineRoot)} has no commit git can read (make it with git worktree add --detach <dir> <rev>)`;
  }
  // 0: HEAD は比較元の祖先 (同じ commit を含む)。1: 祖先でない。128: 比較元にない commit。
  if (
    git(baselineRoot, ["merge-base", "--is-ancestor", head, baselineHead])
      .status === 0
  ) {
    return `${resolvePath(baselineRoot)} is at ${baselineHead.slice(0, 12)}, which contains this worktree's HEAD ${head.slice(0, 12)}, so the changes would be compared with themselves (check out the revision before them, e.g. develop)`;
  }
  return undefined;
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
  const argumentError = baselineArgumentError(argv);
  if (argumentError) {
    console.error(argumentError);
    return 2;
  }
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
  let baseline: Target | undefined;
  if (baselineRoot) {
    const baselineCwd = baselinePackageDir(baselineRoot, cwd);
    const error = baselineError(baselineRoot, baselineCwd, cwd);
    if (error) {
      console.error(`pbt:deep --baseline: ${error}`);
      return 2;
    }
    try {
      baseline = {
        cwd: baselineCwd,
        root: resolvePath(baselineRoot),
        vitest: vitestEntry(baselineCwd),
        commit: headCommit(baselineRoot),
      };
    } catch {
      console.error(
        `pbt:deep --baseline: vitest cannot be resolved from ${baselineCwd} (install or link the dependencies of the baseline worktree)`,
      );
      return 2;
    }
  }
  const current: Target = { cwd, root: worktreeRoot(cwd), vitest };
  const work = mkdtempSync(join(tmpdir(), "pbt-deep-"));

  /**
   * Run one vitest process; returns the titles of its tests by status and
   * how the process ended. `target` is the baseline when replaying there.
   */
  const run = (
    shard: DeepShard,
    id: string,
    extraPattern?: string,
    target: Target = current,
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
          `--reporter=${reporterPath}`,
          ...(pattern ? ["-t", pattern] : []),
        ],
        {
          cwd: target.cwd,
          env: {
            ...process.env,
            ...config.env,
            ...shard.env,
            PBT_DEEP_REPORT: output,
          },
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
          const report: {
            tests: {
              title: string;
              fullName: string;
              state: string;
              errors: ReportedError[];
            }[];
            outside: ReportedError[];
          } = JSON.parse(readFileSync(output, "utf8"));
          const passed = report.tests.filter((t) => t.state === "passed");
          resolve({
            passed: passed.length,
            passedIds: passed.map((t) => t.fullName),
            failed: report.tests
              .filter((t) => t.state === "failed")
              .map((t) => ({
                id: t.fullName,
                title: t.title,
                signature: testSignature(
                  t.errors,
                  target.root,
                  shard.statisticalVerdict,
                ),
                statistical:
                  t.errors.length > 0 &&
                  t.errors.every((error) =>
                    isStatisticalError(error, shard.statisticalVerdict),
                  ),
                excess: statisticalExcess(
                  t.errors,
                  shard.statisticalVerdict,
                  shard.statisticalExcess,
                ),
              })),
            outside: report.outside.map((error) =>
              failureSignature(error, target.root),
            ),
            exitCode,
            signal,
            reported: true,
          });
        } catch {
          resolve({
            passed: 0,
            passedIds: [],
            failed: [],
            outside: [],
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
      results[i].failed.map((test) => ({
        suite,
        id: test.id,
        title: test.title,
        shard: list[i].shard,
        kind: "test" as const,
        statistical: test.statistical,
        ...observed(test),
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
      if (
        result.reported &&
        result.passed + result.failed.length === 0 &&
        result.outside.length === 0
      ) {
        ranNoTest.add(i);
        confirmed.push({
          suite,
          id: `${list[i].shard.label}: ran no test`,
          title: `${list[i].shard.label}: ran no test`,
          shard: list[i].shard,
          kind: "ranNoTest",
          forms: [],
          statistical: false,
        });
      }
    }
    // 失敗は単独で再実行し、負荷による失敗 (flaky) と本当の失敗を分ける。単独で
    // 実行して通った (1 件以上実行し失敗なし、vitest も正常終了) ものだけが flaky。
    const flaky: Failure[] = [];
    // 単独の再実行でテストの結果の外に現れた問題 (分割ごと)。
    const replayProblems = new Map<
      DeepShard,
      NonNullable<ReturnType<typeof outsideProblem>>[]
    >();
    for (const failure of failures) {
      const again = await run(
        failure.shard,
        `${suite}-retry-${retries++}`,
        escapeRegExp(failure.title),
      );
      if (passedCleanly(again, [failure.id])) {
        flaky.push(failure);
        continue;
      }
      const problem = outsideProblem(again);
      if (problem) {
        replayProblems.set(failure.shard, [
          ...(replayProblems.get(failure.shard) ?? []),
          problem,
        ]);
      }
      const test = again.failed.find((t) => t.id === failure.id);
      if (test) {
        addForms(failure, observed(test));
        failure.statistical &&= test.statistical;
      } else {
        failure.uncomparable ??= `the replay alone did not report this test's failure (${describeRun(again)})`;
        failure.statistical = false;
      }
      confirmed.push(failure);
    }
    // テストの結果の外のエラー (未処理の rejection、ファイルや hook の失敗) と、
    // 説明のつかない終了 (シグナル、レポートなし) は、テストの失敗とは別に判定する。
    // 分割の題名の失敗がすべて flaky で終了コードの説明がつかないときも同じで、
    // 分割を丸ごと単独で再実行する。
    for (const i of indices) {
      if (ranNoTest.has(i)) continue;
      const first = results[i];
      const shard = list[i].shard;
      const explained = failures.some(
        (failure) => failure.shard === shard && confirmed.includes(failure),
      );
      const problem =
        outsideProblem(first) ??
        (!explained && abnormalExit(first)
          ? {
              reason: abnormalExit(first) as string,
              forms: [],
              uncomparable: "no error explains the exit code",
            }
          : undefined);
      const fromReplays = replayProblems.get(shard) ?? [];
      const reason = problem?.reason ?? fromReplays[0]?.reason;
      if (!reason) continue;
      const failure: Failure = {
        suite,
        id: `${shard.label}: ${reason}`,
        title: `${shard.label}: ${reason}`,
        shard,
        kind: "abnormal",
        forms: [],
        statistical: false,
      };
      for (const seen of fromReplays) addForms(failure, seen);
      if (problem) {
        const again = await run(shard, `${suite}-retry-${retries++}`);
        // 分割を丸ごと再実行して通ったと言えるのは、初回に実行したテストがすべて通ったときだけ。
        const ranFirst = [...first.passedIds, ...first.failed.map((t) => t.id)];
        if (passedCleanly(again, ranFirst) && fromReplays.length === 0) {
          flaky.push(failure);
          continue;
        }
        addForms(failure, problem);
        const repeated = outsideProblem(again);
        if (repeated) addForms(failure, repeated);
        // 初回になかったテストの失敗が出た再実行は、この異常と同じ原因とは言えない。
        if (
          again.failed.some((t) => !first.failed.some((f) => f.id === t.id))
        ) {
          failure.uncomparable ??=
            "the replay of the shard failed a test the first run passed";
        }
      }
      confirmed.push(failure);
    }
    // 確定した失敗を比較元で同じ env のまま最大 --baseline-runs 回再生する。同じ形で
    // 1 回でも失敗すれば以前からの失敗 (pre-existing) とし、終了コードに含めない。
    const preExisting: Failure[] = [];
    const statistical: Failure[] = [];
    for (const failure of [...confirmed]) {
      if (failure.kind === "ranNoTest") continue;
      if (!baseline) {
        // 統計的な判定 (heap slope など) の失敗だけは、比較元との比較でだけ判定する。
        if (
          failure.shard.statistical &&
          failure.shard.statisticalVerdict &&
          failure.statistical
        ) {
          confirmed.splice(confirmed.indexOf(failure), 1);
          statistical.push(failure);
        }
        continue;
      }
      if (failure.uncomparable) {
        failure.baseline = `not compared with the baseline: ${failure.uncomparable}`;
        continue;
      }
      const replays: ShardRun[] = [];
      const outcomes: string[] = [];
      for (let attempt = 0; attempt < baselineRuns; attempt++) {
        const result = await run(
          failure.shard,
          `${suite}-baseline-${retries++}`,
          failure.kind === "test" ? escapeRegExp(failure.title) : undefined,
          baseline,
        );
        replays.push(result);
        outcomes.push(describeRun(result, failure.id));
        if (sameFailure(failure, replays)) {
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
      printForms(failure);
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
      printForms(failure);
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
      `${totals.preExisting} pre-existing (${baseline ? `same failure on ${baseline.cwd} at ${baseline.commit?.slice(0, 12)}` : "no --baseline"}), ` +
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
