import type { WptAllowlistFile, WptResultRecord } from "./runner";

/**
 * The regression gate of `npm run wpt` (`wpt/baseline.json`).
 *
 * - The baseline lists subtests that passed in every one of repeated full runs
 *   (`selectStableBaseline`), so a subtest that only sometimes passes is not
 *   gated.
 * - A run regresses when a baseline subtest reports a lower status
 *   (PASS > SKIP > FAIL > TIMEOUT), or when a file that ran does not report
 *   it at all (a whole-file timeout or exception), so a timeout cannot hide
 *   a regression (`findBaselineRegressions`).
 * - A target whose regressions are all timeouts is rerun once, one at a time
 *   with longer timeouts, and judged by the rerun (`selectTimeoutRetryTargets`):
 *   the runner's per-file timeouts are short, so CPU load alone can time a file
 *   out. A FAIL is never rerun.
 */
export function findBaselineRegressions(
  baseline: readonly WptResultRecord[],
  results: readonly WptResultRecord[],
): WptResultRecord[] {
  const expectedByKey = new Map(
    baseline.map((result) => [resultKey(result), result.status]),
  );
  const regressions = results.filter((result) => {
    if (result.status === "SKIP") return false;
    const expected = expectedByKey.get(resultKey(result));
    return expected !== undefined && isRegression(expected, result.status);
  });

  const reported = new Set(results.map(resultKey));
  const ranTargets = new Set(results.map(targetKeyOf));
  for (const expected of baseline) {
    if (
      expected.status !== "SKIP" &&
      ranTargets.has(targetKeyOf(expected)) &&
      !reported.has(resultKey(expected))
    ) {
      regressions.push({
        file: expected.file,
        variant: expected.variant,
        subtest: expected.subtest,
        status: "TIMEOUT",
        message: `Not reported (baseline: ${expected.status}); the file timed out or aborted before this subtest finished.`,
      });
    }
  }
  return regressions;
}

/**
 * The baseline for repeated full runs: the subtests that are PASS in every
 * run, without the subtests the allowlist keeps out of the gate (a target with
 * `enabled: false`, or a name in its `baselineExclusions`). Runner pseudo
 * subtests (`[timeout]`, `[exception]`, ...) are never PASS.
 */
export function selectStableBaseline(
  runs: readonly (readonly WptResultRecord[])[],
  allowlist: WptAllowlistFile,
): WptResultRecord[] {
  if (runs.length === 0) return [];
  const passCount = new Map<string, number>();
  for (const run of runs) {
    for (const key of new Set(
      run.filter(({ status }) => status === "PASS").map(resultKey),
    )) {
      passCount.set(key, (passCount.get(key) ?? 0) + 1);
    }
  }
  const stable = new Map<string, WptResultRecord>();
  for (const result of runs[0]) {
    const key = resultKey(result);
    if (passCount.get(key) === runs.length && !isExcluded(result, allowlist)) {
      stable.set(key, {
        file: result.file,
        variant: result.variant,
        subtest: result.subtest,
        status: "PASS",
      });
    }
  }
  return [...stable.values()].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.variant.localeCompare(right.variant) ||
      left.subtest.localeCompare(right.subtest),
  );
}

function isExcluded(result: WptResultRecord, allowlist: WptAllowlistFile) {
  return allowlist.targets.some(
    (target) =>
      target.file === result.file &&
      (target.variant ?? "") === result.variant &&
      (!target.enabled ||
        (target.baselineExclusions ?? []).includes(result.subtest)),
  );
}

/**
 * The targets (`file::variant`) to rerun once: those whose every regression is
 * a TIMEOUT (a whole-file timeout under load reports its unfinished baseline
 * subtests as TIMEOUT). A target with a FAIL regression is not rerun, so a
 * failing subtest is reported from the first run.
 */
export function selectTimeoutRetryTargets(
  regressions: readonly WptResultRecord[],
): Set<string> {
  const byTarget = new Map<string, boolean>();
  for (const regression of regressions) {
    const key = targetKeyOf(regression);
    byTarget.set(
      key,
      (byTarget.get(key) ?? true) && regression.status === "TIMEOUT",
    );
  }
  return new Set(
    [...byTarget].filter(([, timeoutOnly]) => timeoutOnly).map(([key]) => key),
  );
}

/** `results` with the results of the targets in `keys` replaced by `rerun`. */
export function replaceTargetResults(
  results: readonly WptResultRecord[],
  rerun: readonly WptResultRecord[],
  keys: ReadonlySet<string>,
): WptResultRecord[] {
  return [
    ...results.filter((result) => !keys.has(targetKeyOf(result))),
    ...rerun,
  ].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.variant.localeCompare(right.variant) ||
      left.subtest.localeCompare(right.subtest),
  );
}

export function targetKeyOf(target: { file: string; variant?: string }) {
  return `${target.file}::${target.variant ?? ""}`;
}

function resultKey(
  result: Pick<WptResultRecord, "file" | "variant" | "subtest">,
) {
  return `${result.file}::${result.variant}::${result.subtest}`;
}

function isRegression(
  expected: WptResultRecord["status"],
  actual: WptResultRecord["status"],
) {
  return statusRank(actual) < statusRank(expected);
}

function statusRank(status: WptResultRecord["status"]) {
  switch (status) {
    case "PASS":
      return 3;
    case "SKIP":
      return 2;
    case "FAIL":
      return 1;
    case "TIMEOUT":
      return 0;
  }
}
