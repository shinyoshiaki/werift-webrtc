import type { WptResultRecord, WptTarget } from "./runner";

/**
 * Opt-in per allowlist target: subtests that are not registered with the
 * harness at all (they would otherwise hold the whole file until the runner
 * timeout, e.g. waiting for an event werift does not fire). Each one is
 * reported as `SKIP` with its reason, so it stays visible but never counts
 * as a regression nor enters the baseline.
 */
export interface WptSkippedSubtest {
  name: string;
  reason: string;
}

/** Whether the harness should register the subtest `name` of `target`. */
export function createSubtestSelector(target: Pick<WptTarget, "skippedSubtests">) {
  const skipped = new Set(
    (target.skippedSubtests ?? []).map((subtest) => subtest.name),
  );
  return (name: string) => !skipped.has(name);
}

/** The SKIP records of the target's skipped subtests. */
export function skippedSubtestRecords(
  target: Pick<WptTarget, "file" | "variant" | "skippedSubtests">,
): WptResultRecord[] {
  return (target.skippedSubtests ?? []).map((subtest) => ({
    file: target.file,
    variant: target.variant ?? "",
    subtest: subtest.name,
    status: "SKIP",
    message: subtest.reason,
  }));
}
