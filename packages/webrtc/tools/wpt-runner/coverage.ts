import { mkdir, readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createCoverageMap } from "istanbul-lib-coverage";
import { createContext } from "istanbul-lib-report";
import reports from "istanbul-reports";
import {
  extractCoverageTotals,
  findCoverageRegressions,
  type CoverageSummary,
  type CoverageTotals,
} from "./coverageLogic";

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(toolDir, "..", "..");
const repoRoot = resolve(packageDir, "..", "..");
const packageCoverageDir = resolve(packageDir, "coverage");
const packageCoverageFinalPath = resolve(packageCoverageDir, "coverage-final.json");
const coverageDir = resolve(repoRoot, "coverage", "webrtc-wpt");
const coverageSummaryPath = resolve(coverageDir, "coverage-summary.json");
const coverageBaselinePath = resolve(packageDir, "wpt", "coverage-baseline.json");
const sourceDir = `${resolve(packageDir, "src")}/`;

async function main() {
  const result = spawnSync(
    "npx",
    ["vitest", "run", "--coverage", "--config", "vitest.wpt.config.mts"],
    {
      cwd: packageDir,
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  await mkdir(coverageDir, { recursive: true });
  const rawCoverage = JSON.parse(
    await readFile(packageCoverageFinalPath, "utf8"),
  ) as Record<string, unknown>;
  const coverageMap = createCoverageMap(
    Object.fromEntries(
      Object.entries(rawCoverage).filter(([filePath]) => {
        return filePath.startsWith(sourceDir) && filePath.endsWith(".ts");
      }),
    ),
  );
  const reportContext = createContext({
    dir: coverageDir,
    coverageMap,
  });

  reports.create("json-summary", { file: "coverage-summary.json" }).execute(reportContext);
  reports.create("lcovonly", { file: "lcov.info" }).execute(reportContext);
  reports.create("html", { subdir: "html" }).execute(reportContext);

  const summary = JSON.parse(
    await readFile(coverageSummaryPath, "utf8"),
  ) as CoverageSummary;
  const totals = extractCoverageTotals(summary);

  const updateBaseline =
    process.argv.includes("--update-baseline") ||
    process.env.WPT_UPDATE_COVERAGE_BASELINE === "1";

  if (updateBaseline) {
    await writeFile(
      coverageBaselinePath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          totals,
        },
        null,
        2,
      )}\n`,
    );
  }

  const baseline = JSON.parse(await readFile(coverageBaselinePath, "utf8")) as {
    totals: Partial<CoverageTotals>;
  };
  const regressions = findCoverageRegressions(totals, baseline.totals);

  if (regressions.length > 0) {
    for (const regression of regressions) {
      console.error(
        `${regression.metric} coverage regressed: ${regression.current.toFixed(2)} < ${regression.baseline.toFixed(2)}`,
      );
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
