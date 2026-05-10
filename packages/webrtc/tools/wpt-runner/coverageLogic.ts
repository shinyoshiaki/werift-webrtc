const COVERAGE_DECIMAL_PLACES = 2;
export const COVERAGE_METRICS = [
  "statements",
  "branches",
  "functions",
  "lines",
] as const;

export type CoverageMetric = (typeof COVERAGE_METRICS)[number];
export type CoverageTotals = Record<CoverageMetric, number>;
export type CoverageSummary = {
  total: Record<CoverageMetric, { pct: number }>;
};

export function roundCoverage(value: number) {
  return Number(value.toFixed(COVERAGE_DECIMAL_PLACES));
}

export function normalizeCoverageTotals(totals: CoverageTotals) {
  return Object.fromEntries(
    COVERAGE_METRICS.map((metric) => [metric, roundCoverage(totals[metric])]),
  ) as CoverageTotals;
}

export function extractCoverageTotals(summary: CoverageSummary) {
  return normalizeCoverageTotals({
    statements: summary.total.statements.pct,
    branches: summary.total.branches.pct,
    functions: summary.total.functions.pct,
    lines: summary.total.lines.pct,
  });
}

export function findCoverageRegressions(
  current: CoverageTotals,
  baseline: Partial<CoverageTotals>,
) {
  return COVERAGE_METRICS.filter((metric) => {
    const baselineValue = baseline[metric];
    return typeof baselineValue === "number" && current[metric] < baselineValue;
  }).map((metric) => ({
    metric,
    current: current[metric],
    baseline: baseline[metric] as number,
  }));
}
