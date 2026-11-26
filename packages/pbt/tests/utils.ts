import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { vi } from "vitest";

import { type DeepSearchConfig, runDeepSearch } from "../src";

/** The fixture files of `tests/fixtures/deep` (`<name>.fixture.ts`). */
export type DeepFixture = "passing" | "failing" | "unhandled";

/** The directory of the fixtures, with their own vitest config. */
const fixtureDir = join(__dirname, "fixtures", "deep");

/** The worktree root of this checkout (the nearest directory with `.git`). */
const worktreeRoot = () => {
  let dir = fixtureDir;
  while (!existsSync(join(dir, ".git"))) dir = dirname(dir);
  return dir;
};

/** Fixture sources of a baseline revision; a fixture not listed keeps this revision's file. */
export type BaselineFixtures = Partial<Record<DeepFixture, string>>;

/** A fixture whose single test passes. */
export const passingSource = (title: string) =>
  `import { expect, test } from "vitest";\n\ntest(${JSON.stringify(title)}, () => {\n  expect(1 + 1).toBe(2);\n});\n`;

/** A fixture whose single test fails by throwing `message`. */
export const throwingSource = (title: string, message: string) =>
  `import { test } from "vitest";\n\ntest(${JSON.stringify(title)}, () => {\n  throw new Error(${JSON.stringify(message)});\n});\n`;

/**
 * A baseline worktree for `--baseline`: a temporary directory (inside the
 * package, so the fixtures resolve vitest from the same node_modules) holding
 * the fixture directory at the same path relative to its root, with
 * `overrides` replacing fixture files.
 */
function makeBaselineWorktree(overrides: BaselineFixtures) {
  const root = mkdtempSync(join(__dirname, "fixtures", ".baseline-"));
  const dir = join(root, relative(worktreeRoot(), fixtureDir));
  mkdirSync(dir, { recursive: true });
  // フィクスチャと vitest の設定だけを写す (vitest のキャッシュは写さない)。
  for (const file of readdirSync(fixtureDir).filter((f) => /\.m?ts$/.test(f))) {
    cpSync(join(fixtureDir, file), join(dir, file));
  }
  // vitest の解決とパッケージの確認に使う package.json を置く。
  writeFileSync(join(dir, "package.json"), '{ "private": true }\n');
  for (const [name, source] of Object.entries(overrides)) {
    writeFileSync(join(dir, `${name}.fixture.ts`), source);
  }
  return root;
}

/**
 * Run `runDeepSearch` over real vitest processes: one suite per fixture, each
 * one shard running its file. Resolves the exit code and the lines the runner
 * printed (captured, not shown). `baseline` creates a baseline worktree and
 * passes it with `--baseline` (`--baseline-runs 1` unless `argv` sets it);
 * `statistical` marks fixtures whose shard is statistical.
 */
export async function runFixtureDeepSearch(
  fixtures: DeepFixture[],
  {
    baseline,
    statistical = [],
    argv = [],
  }: {
    baseline?: BaselineFixtures;
    statistical?: DeepFixture[];
    argv?: string[];
  } = {},
) {
  const config: DeepSearchConfig = {
    cwd: fixtureDir,
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
            },
          ],
        },
      ]),
    ),
  };
  const baselineRoot = baseline ? makeBaselineWorktree(baseline) : undefined;
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
    if (baselineRoot) rmSync(baselineRoot, { recursive: true, force: true });
  }
}
