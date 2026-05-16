import { expect, test } from "vitest";

import {
  extractCoverageTotals,
  findCoverageRegressions,
  roundCoverage,
} from "../../tools/wpt-runner/coverageLogic";

test("coverage ratchet fails when rounded coverage falls below the baseline", () => {
  const baseline = {
    statements: 53.72,
    branches: 73.71,
    functions: 58.07,
    lines: 53.71,
  };
  const summary = {
    total: {
      statements: { pct: 53.714 },
      branches: { pct: 73.71 },
      functions: { pct: 58.07 },
      lines: { pct: 53.71 },
    },
  };

  // 実行: coverage summary を baseline 比較用の小数第2位へ正規化する。
  const totals = extractCoverageTotals(summary);
  const regressions = findCoverageRegressions(totals, baseline);

  // 検証: baseline を 0.01pt でも下回った指標は回帰として検出される。
  expect(totals).toEqual({
    statements: 53.71,
    branches: 73.71,
    functions: 58.07,
    lines: 53.71,
  });
  expect(regressions).toEqual([
    {
      metric: "statements",
      current: 53.71,
      baseline: 53.72,
    },
  ]);
});

test("coverage rounding is fixed to two decimal places before baseline updates", () => {
  // 実行: baseline 保存前の coverage 値を丸め規則へ通す。
  const rounded = roundCoverage(58.075);

  // 検証: baseline に保存される coverage は常に小数第2位へ固定される。
  expect(rounded).toBe(58.08);
});
