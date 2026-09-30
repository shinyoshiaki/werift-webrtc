import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createCoverageProvider } from "../../tools/wpt-runner/coverage";

test("WPT coverage provider maps TypeScript sources and writes reports", async () => {
  // Arrange: 本番レポートを変更しない一時ディレクトリを用意する。
  const directory = await mkdtemp(join(tmpdir(), "werift-wpt-provider-"));
  try {
    // Act: 現行 provider で未実行の TypeScript を変換し、レポートを生成する。
    const provider = await createCoverageProvider(directory);
    await provider.clean();
    const coverage = await provider.generateCoverage({ allTestsRun: true });
    await provider.generateReports(coverage, true);
    await provider.cleanAfterRun();
    const summary = JSON.parse(
      await readFile(join(directory, "coverage-summary.json"), "utf8"),
    );

    // Assert: ソースマップが .ts に戻り、計測対象が空になっていないことを確認する。
    expect(coverage.files().length).toBeGreaterThan(0);
    expect(coverage.files().every((file) => file.endsWith(".ts"))).toBe(true);
    expect(summary.total.statements.total).toBeGreaterThan(0);
    expect(summary.total.statements.covered).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
