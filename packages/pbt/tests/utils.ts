import { join } from "node:path";

import { vi } from "vitest";

import { type DeepSearchConfig, runDeepSearch } from "../src";

/** The fixture files of `tests/fixtures/deep` (`<name>.fixture.ts`). */
export type DeepFixture = "passing" | "failing" | "unhandled";

/** The directory of the fixtures, with their own vitest config. */
const fixtureDir = join(__dirname, "fixtures", "deep");

/**
 * Run `runDeepSearch` over real vitest processes: one suite per fixture, each
 * one shard running its file. Resolves the exit code and the lines the runner
 * printed (captured, not shown).
 */
export async function runFixtureDeepSearch(fixtures: DeepFixture[]) {
  const config: DeepSearchConfig = {
    cwd: fixtureDir,
    suites: Object.fromEntries(
      fixtures.map((name) => [
        name,
        {
          file: `${name}.fixture.ts`,
          shards: () => [
            { label: `${name} shard`, file: `${name}.fixture.ts`, env: {} },
          ],
        },
      ]),
    ),
  };
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(args.join(" "));
  });
  try {
    const exit = await runDeepSearch(config, ["--jobs", "2"]);
    return { exit, lines, output: lines.join("\n") };
  } finally {
    log.mockRestore();
  }
}
