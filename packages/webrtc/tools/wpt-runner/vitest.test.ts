import { expect, test } from "vitest";

import { runSelectedWpt } from "./runner";

test(
  "allowlisted upstream WPT cases",
  async () => {
    const report = await runSelectedWpt({
      compareWithBaseline: true,
    });

    expect(report.regressions).toEqual([]);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.timedOut).toBe(0);
  },
  120_000,
);
