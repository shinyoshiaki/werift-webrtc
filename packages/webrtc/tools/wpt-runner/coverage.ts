import { mergeProcessCovs } from "@bcoe/v8-coverage";
import { V8CoverageProvider } from "@vitest/coverage-v8/dist/provider.js";
import { transform as esbuildTransform } from "esbuild";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, extname, resolve } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  extractCoverageTotals,
  findCoverageRegressions,
  type CoverageTotals,
} from "./coverageLogic";

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(toolDir, "..", "..");
const repoRoot = resolve(packageDir, "..", "..");
const coverageDir = resolve(repoRoot, "coverage", "webrtc-wpt");
const coverageSummaryPath = resolve(coverageDir, "coverage-summary.json");
const coverageBaselinePath = resolve(packageDir, "wpt", "coverage-baseline.json");
const sourceDir = resolve(packageDir, "src");

async function main() {
  const rawCoverageDir = await mkdtemp(resolve(tmpdir(), "werift-wpt-v8-"));

  try {
    const result = spawnSync("npx", ["tsx", "tools/wpt-runner/run.ts"], {
      cwd: packageDir,
      env: {
        ...process.env,
        NODE_V8_COVERAGE: rawCoverageDir,
        WPT_USE_WORKERS: "1",
      },
      stdio: "inherit",
    });

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }

    const mergedCoverage = await mergeRawCoverage(rawCoverageDir);
    const provider = createCoverageProvider();
    await provider.clean();

    const coverageFilePath = resolve(provider.coverageFilesDirectory, "coverage-wpt.json");
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
  } finally {
    await rm(rawCoverageDir, { recursive: true, force: true });
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
          map: typeof result.map === "string" ? JSON.parse(result.map) : result.map,
        };
      },
    },
  };
}

async function mergeRawCoverage(directoryPath: string) {
  let merged = { result: [] as Array<Record<string, unknown>> };
  const coverageFiles = (await readdir(directoryPath))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();

  for (const fileName of coverageFiles) {
    const payload = JSON.parse(
      await readFile(resolve(directoryPath, fileName), "utf8"),
    ) as { result?: Array<Record<string, unknown>> };
    if (!payload.result) {
      continue;
    }
    merged = mergeProcessCovs([
      merged,
      {
        result: payload.result.filter((entry) => isTargetSourceUrl(entry.url)),
      },
    ]);
  }

  return merged;
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

function isTargetSourceUrl(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("file://")) {
    return false;
  }

  return value.startsWith(`file://${sourceDir}/`) && value.endsWith(".ts");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
