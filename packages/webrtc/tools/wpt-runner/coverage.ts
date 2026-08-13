import { spawn } from "child_process";
import { tmpdir } from "os";
import { dirname, extname, resolve } from "path";
import { fileURLToPath } from "url";
import { V8CoverageProvider } from "@vitest/coverage-v8/dist/provider.js";
import { transform as esbuildTransform } from "esbuild";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import {
  type CoverageTotals,
  extractCoverageTotals,
  findCoverageRegressions,
} from "./coverageLogic";
import {
  WPT_V8_COVERAGE_TEMP_PREFIX,
  consumeCoverageFiles,
  createEmptyProcessCoverage,
  isTargetSourceCoverageUrl,
  removeStaleCoverageTempDirs,
} from "./coverageMerge";
import {
  type WptRunReport,
  defaultMarkdownReportPath,
  defaultReportPath,
  formatMarkdownReport,
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
const tsconfigPath = resolve(packageDir, "tsconfig.json");

async function main() {
  await removeStaleCoverageTempDirs(tmpdir(), WPT_V8_COVERAGE_TEMP_PREFIX);
  const rawCoverageDir = await mkdtemp(
    resolve(tmpdir(), WPT_V8_COVERAGE_TEMP_PREFIX),
  );
  const isTargetUrl = (url: unknown) =>
    isTargetSourceCoverageUrl(url, sourceDir);
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
    const provider = createCoverageProvider();
    await provider.clean();

    const coverageFilePath = resolve(
      provider.coverageFilesDirectory,
      "coverage-wpt.json",
    );
    await writeFile(coverageFilePath, JSON.stringify(mergedCoverage), "utf8");
    provider.coverageFiles.set("wpt", {
      browser: {},
      ssr: {
        "wpt-runner": coverageFilePath,
      },
      web: {},
    });

    const coverageMap = await provider.generateCoverage({ allTestsRun: true });
    coverageMap.filter((filePath) => {
      return filePath.startsWith(sourceDir) && filePath.endsWith(".ts");
    });
    await provider.generateReports(coverageMap, true);
    await provider.cleanAfterRun();
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

async function runWptAndConsumeCoverage(
  rawCoverageDir: string,
  consume: () => Promise<void>,
) {
  const child = spawn(
    "npx",
    ["tsx", "--tsconfig", tsconfigPath, "tools/wpt-runner/run.ts"],
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

function createCoverageProvider() {
  const project = createProject();
  const provider = new V8CoverageProvider();
  provider.initialize({
    config: {
      coverage: {
        all: false,
        allowExternal: false,
        clean: true,
        cleanOnRerun: true,
        exclude: [],
        excludeAfterRemap: false,
        extension: [".ts"],
        ignoreEmptyLines: true,
        include: ["src/**/*.ts"],
        provider: "v8",
        reporter: [
          ["json-summary", { file: "coverage-summary.json" }],
          ["lcovonly", { file: "lcov.info" }],
          ["html", { subdir: "html" }],
        ],
        reportsDirectory: resolve(coverageDir),
        reportOnFailure: true,
        skipFull: false,
      },
      root: packageDir,
      shard: undefined,
    },
    getProjectByName() {
      return project;
    },
    getRootProject() {
      return project;
    },
    logger: {
      error: console.error,
      log: console.log,
      warn: console.warn,
    },
    server: {
      config: {
        configFile: undefined,
      },
    },
    version: "3.0.5",
    vitenode: {
      fetchCache: new Map(),
    },
  } as any);

  return provider;
}

function createProject() {
  const fetchCache = new Map();
  return {
    browser: undefined,
    config: {
      root: packageDir,
    },
    vitenode: {
      fetchCache,
      fetchCaches: {
        browser: fetchCache,
        ssr: fetchCache,
        web: fetchCache,
      },
      async transformRequest(filePath: string) {
        const source = await readFile(filePath, "utf8");
        const result = await esbuildTransform(source, {
          format: "esm",
          loader: resolveLoader(filePath),
          sourcefile: filePath,
          sourcemap: true,
          target: "es2022",
        });

        return {
          code: result.code,
          map:
            typeof result.map === "string"
              ? JSON.parse(result.map)
              : result.map,
        };
      },
    },
  };
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

function resolveLoader(filePath: string) {
  switch (extname(filePath)) {
    case ".ts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".mts":
      return "ts";
    case ".cts":
      return "ts";
    case ".js":
      return "js";
    default:
      return "ts";
  }
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
