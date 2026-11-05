import { spawn } from "child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  type CoverageTotals,
  extractCoverageTotals,
  findCoverageRegressions,
} from "./coverageLogic";
import {
  consumeCoverageFiles,
  createEmptyProcessCoverage,
  isTargetSourceCoverageUrl,
  removeStaleCoverageTempDirs,
  WPT_V8_COVERAGE_TEMP_PREFIX,
} from "./coverageMerge";
import { convertCoverage, generateCoverageReports } from "./coverageProvider";
import {
  defaultMarkdownReportPath,
  defaultReportPath,
  formatMarkdownReport,
  type WptRunReport,
} from "./runner";

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(toolDir, "..", "..");
const repoRoot = resolve(packageDir, "..", "..");
const coverageDir = resolve(repoRoot, "coverage", "webrtc-wpt");
const coverageSummaryPath = resolve(coverageDir, "coverage-summary.json");
const coverageBaselinePath = resolve(
  packageDir,
  "wpt",
  "coverage-baseline.json",
);
const sourceDir = resolve(packageDir, "src");

/**
 * GCC / selectable BWE algorithm sources are public API (barrel-exported) so
 * they load during WPT, but allowlisted upstream WPT does not exercise them.
 * Including ~350 mostly-uncovered functions dilutes the WPT coverage ratchet
 * without reflecting WebRTC WPT surface regressions. Unit tests + package/e2e
 * sims cover GCC; keep WPT coverage focused on the default media stack.
 */
function isWptCoverageTargetPath(filePath: string) {
  if (!filePath.startsWith(sourceDir) || !filePath.endsWith(".ts")) {
    return false;
  }
  const relative = filePath.slice(sourceDir.length).replaceAll("\\", "/");
  // Exclude GCC files because allowlisted WPT does not exercise these APIs.
  if (relative.includes("/media/sender/estimators/gcc/")) {
    return false;
  }
  return true;
}

async function main() {
  await removeStaleCoverageTempDirs(tmpdir(), WPT_V8_COVERAGE_TEMP_PREFIX);
  const rawCoverageDir = await mkdtemp(
    resolve(tmpdir(), WPT_V8_COVERAGE_TEMP_PREFIX),
  );
  const isTargetUrl = (url: unknown) =>
    isTargetSourceCoverageUrl(url, sourceDir) &&
    typeof url === "string" &&
    isWptCoverageTargetPath(url.slice("file://".length));
  let mergedCoverage = createEmptyProcessCoverage();
  let exitCode = 0;

  try {
    const status = await runWptAndConsumeCoverage(rawCoverageDir, async () => {
      mergedCoverage = await consumeCoverageFiles(
        rawCoverageDir,
        mergedCoverage,
        isTargetUrl,
      );
    });
    await warnUnreadableCoverageFiles(rawCoverageDir);

    if (status !== 0) {
      exitCode = status;
      return;
    }

    mergedCoverage = await consumeCoverageFiles(
      rawCoverageDir,
      mergedCoverage,
      isTargetUrl,
    );
    const markdown = await readMarkdownReport();
    const coverageMap = await convertCoverage(mergedCoverage);
    coverageMap.filter((filePath) => isWptCoverageTargetPath(filePath));
    await generateCoverageReports(coverageMap, coverageDir);
    await mkdir(dirname(defaultMarkdownReportPath), { recursive: true });
    await writeFile(defaultMarkdownReportPath, markdown, "utf8");

    const summary = JSON.parse(await readFile(coverageSummaryPath, "utf8")) as {
      total: {
        branches: { pct: number };
        functions: { pct: number };
        lines: { pct: number };
        statements: { pct: number };
      };
    };
    const totals = extractCoverageTotals(summary);
    await updateBaselineIfRequested(totals);

    const baseline = JSON.parse(
      await readFile(coverageBaselinePath, "utf8"),
    ) as {
      totals: Partial<CoverageTotals>;
    };
    const regressions = findCoverageRegressions(totals, baseline.totals);

    if (regressions.length > 0) {
      for (const regression of regressions) {
        console.error(
          `${regression.metric} coverage regressed: ${regression.current.toFixed(2)} < ${regression.baseline.toFixed(2)}`,
        );
      }
      exitCode = 1;
    }
  } finally {
    await rm(rawCoverageDir, { recursive: true, force: true });
  }

  process.exitCode = exitCode;
}

async function warnUnreadableCoverageFiles(directoryPath: string) {
  for (const fileName of (await readdir(directoryPath)).filter((name) =>
    name.endsWith(".json"),
  )) {
    try {
      JSON.parse(await readFile(resolve(directoryPath, fileName), "utf8"));
    } catch (error) {
      // A worker may leave a truncated dump when it is terminated by WPT.
      console.warn(
        `[wpt:coverage] skip unreadable coverage dump ${fileName}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

async function runWptAndConsumeCoverage(
  rawCoverageDir: string,
  consume: () => Promise<void>,
) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--import",
      resolve(repoRoot, "tools/node-ts/register.mjs"),
      "tools/wpt-runner/run.ts",
    ],
    {
      cwd: packageDir,
      env: {
        ...process.env,
        NODE_V8_COVERAGE: rawCoverageDir,
        WPT_USE_WORKERS: "1",
      },
      stdio: "inherit",
    },
  );

  let consumeChain = Promise.resolve();
  const scheduleConsume = () => {
    consumeChain = consumeChain.then(consume).catch((error) => {
      console.error(error);
    });
  };
  const timer = setInterval(scheduleConsume, 1_000);

  try {
    return await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        resolve(signal ? 1 : (code ?? 1));
      });
    });
  } finally {
    clearInterval(timer);
    scheduleConsume();
    await consumeChain;
  }
}

async function updateBaselineIfRequested(totals: CoverageTotals) {
  const updateBaseline =
    process.argv.includes("--update-baseline") ||
    process.env.WPT_UPDATE_COVERAGE_BASELINE === "1";

  if (!updateBaseline) {
    return;
  }

  await mkdir(dirname(coverageBaselinePath), { recursive: true });
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

async function readMarkdownReport() {
  try {
    return await readFile(defaultMarkdownReportPath, "utf8");
  } catch {
    const report = JSON.parse(
      await readFile(defaultReportPath, "utf8"),
    ) as WptRunReport;
    return formatMarkdownReport(report);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
