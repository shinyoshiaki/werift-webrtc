import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";
import { expect, test } from "vitest";

import {
  convertCoverage,
  generateCoverageReports,
} from "../../tools/wpt-runner/coverageProvider";

test("WPT coverage provider maps TypeScript sources and writes reports", async () => {
  // Arrange: 本番レポートを変更しない一時ディレクトリを用意する。
  const directory = await mkdtemp(join(tmpdir(), "werift-wpt-provider-"));
  const sourcePath = resolve("src/utils.ts");
  const { code } = await transform(await readFile(sourcePath, "utf8"), {
    format: "esm",
    loader: "ts",
    sourcefile: sourcePath,
    target: "es2022",
    sourcemap: true,
  });
  try {
    // Act: 従来の変換方式で V8 計測結果を TypeScript に戻し、レポートを生成する。
    const coverage = await convertCoverage({
      result: [
        {
          url: pathToFileURL(sourcePath).href,
          functions: [
            {
              functionName: "",
              ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }],
              isBlockCoverage: true,
            },
          ],
        },
      ],
    });
    await generateCoverageReports(coverage, directory);
    const summary = JSON.parse(
      await readFile(join(directory, "coverage-summary.json"), "utf8"),
    );

    // Assert: ソースマップが .ts に戻り、計測対象が空になっていないことを確認する。
    expect(coverage.files()).toEqual([sourcePath]);
    expect(coverage.files().every((file) => file.endsWith(".ts"))).toBe(true);
    expect(summary.total.statements.total).toBeGreaterThan(0);
    expect(summary.total.statements.covered).toBeGreaterThan(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("WPT coverage excludes unmapped lines and preserves uncovered branches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "werift-wpt-lines-"));
  const sourcePath = join(directory, "fixture.ts");
  const source = `// A comment must not contribute to line coverage.
export function choose(value: boolean) {
  if (value) {
    return 1;
  }
  return 2;
}
`;
  await writeFile(sourcePath, source);
  const { code } = await transform(source, {
    format: "esm",
    loader: "ts",
    sourcefile: sourcePath,
    target: "es2022",
    sourcemap: true,
  });
  const uncoveredStart = code.indexOf("function choose");
  const uncoveredEnd = code.indexOf("\n}") + 2;
  try {
    // Act: 未実行の return 節を含む V8 結果を変換する。
    const coverage = await convertCoverage({
      result: [
        {
          url: pathToFileURL(sourcePath).href,
          functions: [
            {
              functionName: "",
              isBlockCoverage: true,
              ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }],
            },
            {
              functionName: "choose",
              isBlockCoverage: true,
              ranges: [
                {
                  startOffset: uncoveredStart,
                  endOffset: uncoveredEnd,
                  count: 0,
                },
              ],
            },
          ],
        },
      ],
    });
    const file = coverage.fileCoverageFor(sourcePath);
    // Assert: コメント行を除外しても、未実行の行と分岐は未カバーとして残る。
    expect(
      Object.values(file.statementMap).some(
        (location) => location.start.line === 1,
      ),
    ).toBe(false);
    expect(file.getLineCoverage()[6]).toBe(0);
    expect(file.toSummary().branches.pct).toBeLessThan(100);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
