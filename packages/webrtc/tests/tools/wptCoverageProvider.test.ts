import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";
import { expect, test } from "vitest";

import { createCoverageProvider } from "../../tools/wpt-runner/coverageProvider";

test("WPT coverage provider maps TypeScript sources and writes reports", async () => {
  // Arrange: 本番レポートを変更しない一時ディレクトリを用意する。
  const directory = await mkdtemp(join(tmpdir(), "werift-wpt-provider-"));
  const sourcePath = resolve("src/utils.ts");
  const { code } = await transform(await readFile(sourcePath, "utf8"), {
    format: "esm",
    loader: "ts",
    sourcefile: sourcePath,
    target: "es2022",
  });
  try {
    // Act: 現行 provider で V8 計測結果を TypeScript に戻し、レポートを生成する。
    const provider = await createCoverageProvider(directory);
    await provider.clean();
    provider.onAfterSuiteRun({
      coverage: {
        result: [
          {
            scriptId: "1",
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
      },
      environment: "ssr",
      projectName: "wpt",
      testFiles: [sourcePath],
    });
    const coverage = await provider.generateCoverage({ allTestsRun: true });
    await provider.generateReports(coverage, true);
    await provider.cleanAfterRun();
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
