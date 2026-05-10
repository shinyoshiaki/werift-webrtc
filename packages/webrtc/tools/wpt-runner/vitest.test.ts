import { expect, test } from "vitest";

import { runSelectedWpt } from "./runner";

test(
  "upstream WebRTC WPT cases do not regress from the recorded baseline",
  async () => {
    const report = await runSelectedWpt({
      compareWithBaseline: true,
    });

    expect(report.regressions).toEqual([]);
    expect(report.summary.total).toBeGreaterThan(0);
  },
  600_000,
);
