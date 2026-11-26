import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { vi } from "vitest";

import { type DeepSearchConfig, runDeepSearch } from "../src";

/** The fixture files of `tests/fixtures/deep` (`<name>.fixture.ts`). */
export type DeepFixture = "passing" | "failing" | "unhandled";

/** The directory of the fixtures, with their own vitest config. */
const fixtureDir = join(__dirname, "fixtures", "deep");

/** Fixture sources replacing files of a revision; a fixture not listed keeps this checkout's file. */
export type FixtureSources = Partial<Record<DeepFixture, string>>;

/** A fixture whose single test passes. */
export const passingSource = (title: string) =>
  `import { expect, test } from "vitest";\n\ntest(${JSON.stringify(title)}, () => {\n  expect(1 + 1).toBe(2);\n});\n`;

/**
 * A fixture with one test (default title: `a failing fixture`) running `body`.
 * `setup` is module-level code (hooks, helpers).
 */
export const testSource = (
  body: string,
  { title = "a failing fixture", setup = "", timeout = 5_000 } = {},
) =>
  `import { existsSync, writeFileSync } from "node:fs";
import { afterAll, expect, test } from "vitest";

${setup}
test(${JSON.stringify(title)}, async () => {
  ${body}
}, ${timeout});
`;

/** A fixture whose single test fails by throwing `message`. */
export const throwingSource = (title: string, message: string) =>
  testSource(`throw new Error(${JSON.stringify(message)});`, { title });

/** A statement leaving an unhandled rejection with `message` behind. */
export const rejection = (message: string) =>
  `void Promise.reject(new Error(${JSON.stringify(message)}));`;

/** A temporary worktree: its root and the fixture package in it. */
export type Checkout = { root: string; dir: string };

/**
 * `git <args>` in `dir`, without the user's identity, signing or hooks;
 * throws when it fails.
 */
export function git(dir: string, ...args: string[]) {
  const result = spawnSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=pbt",
      "-c",
      "user.email=pbt@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Commit every file of the checkout at `root` with `message`. */
export function commitAll(root: string, message: string) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
}

/**
 * A temporary worktree (inside the package, so the fixtures resolve vitest
 * from the same node_modules): a git repository of its own with one commit,
 * holding the fixtures in `deep/`, with `overrides` replacing fixture files.
 * Each one is another repository with its own commit, so none contains the
 * commit of another.
 */
function makeWorktree(overrides: FixtureSources) {
  const root = mkdtempSync(join(__dirname, "fixtures", ".worktree-"));
  const dir = join(root, "deep");
  mkdirSync(dir);
  git(root, "init", "-q");
  // フィクスチャと vitest の設定だけを写す (vitest のキャッシュは写さない)。
  for (const file of readdirSync(fixtureDir).filter((f) => /\.m?ts$/.test(f))) {
    cpSync(join(fixtureDir, file), join(dir, file));
  }
  // vitest の解決とパッケージの確認に使う package.json を置く。
  writeFileSync(join(dir, "package.json"), '{ "private": true }\n');
  for (const [name, source] of Object.entries(overrides)) {
    writeFileSync(join(dir, `${name}.fixture.ts`), source);
  }
  // 同じフィクスチャでも別の commit にする (同じ内容・時刻の commit は同じ hash になる)。
  commitAll(root, `fixtures of ${root}`);
  return { root, dir };
}

/**
 * Run `runDeepSearch` over real vitest processes: one suite per fixture, each
 * one shard running its file. Resolves the exit code and the lines the runner
 * printed (captured, not shown). The run uses a temporary worktree where
 * `current` replaces fixture files. `baseline` creates a second one and passes
 * it with `--baseline` (`--baseline-runs 1` unless `argv` sets it);
 * `statistical` marks fixtures whose shard is statistical, and every shard gets
 * `statisticalVerdict` and `statisticalExcess`.
 */
export async function runFixtureDeepSearch(
  fixtures: DeepFixture[],
  {
    current = {},
    baseline,
    statistical = [],
    statisticalVerdict,
    statisticalExcess,
    argv = [],
  }: {
    current?: FixtureSources;
    baseline?: FixtureSources;
    statistical?: DeepFixture[];
    statisticalVerdict?: RegExp;
    statisticalExcess?: (message: string) => number[] | undefined;
    argv?: string[];
  } = {},
) {
  const checkout = makeWorktree(current);
  const config: DeepSearchConfig = {
    cwd: checkout.dir,
    suites: Object.fromEntries(
      fixtures.map((name) => [
        name,
        {
          file: `${name}.fixture.ts`,
          shards: () => [
            {
              label: `${name} shard`,
              file: `${name}.fixture.ts`,
              env: {},
              statistical: statistical.includes(name),
              statisticalVerdict,
              statisticalExcess,
            },
          ],
        },
      ]),
    ),
  };
  const baselineRoot = baseline ? makeWorktree(baseline).root : undefined;
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  const log = vi.spyOn(console, "log").mockImplementation(capture);
  const error = vi.spyOn(console, "error").mockImplementation(capture);
  try {
    // 先に現れた option が優先されるので、argv を前に置く。
    const exit = await runDeepSearch(config, [
      ...argv,
      "--jobs",
      "2",
      ...(baselineRoot
        ? ["--baseline", baselineRoot, "--baseline-runs", "1"]
        : []),
    ]);
    return { exit, lines, output: lines.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
    for (const root of [checkout.root, baselineRoot]) {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }
}

/**
 * Run `src/cli.ts` as `npm run pbt:deep` does (node with the type-stripping
 * hook) over one fixture in a temporary worktree, with `argv` as the last
 * arguments; a function may arrange paths in the worktree before returning
 * them.
 */
export function runFixtureCli(
  fixture: DeepFixture,
  argv: string[] | ((checkout: Checkout) => string[]) = [],
) {
  const checkout = makeWorktree({});
  const { root, dir } = checkout;
  const file = `${fixture}.fixture.ts`;
  writeFileSync(
    join(dir, "suites.mjs"),
    `export default { suites: { ${fixture}: { file: "${file}", shards: () => [{ label: "${fixture} shard", file: "${file}", env: {} }] } } };\n`,
  );
  try {
    return spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--import",
        join(__dirname, "../../../tools/node-ts/register.mjs"),
        join(__dirname, "../src/cli.ts"),
        "suites.mjs",
        ...(typeof argv === "function" ? argv(checkout) : argv),
      ],
      { cwd: dir, encoding: "utf8" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
