import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { dirname, extname, resolve } from "path";
import { fileURLToPath } from "url";
import { mergeProcessCovs } from "@bcoe/v8-coverage";
import { transform as esbuildTransform } from "esbuild";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import {
  type CoverageTotals,
  extractCoverageTotals,
  findCoverageRegressions,
} from "./coverageLogic";
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
  const rawCoverageDir = await mkdtemp(resolve(tmpdir(), "werift-wpt-v8-"));

  try {
    const result = spawnSync(
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

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }

    const markdown = await readMarkdownReport();
    const mergedCoverage = await mergeRawCoverage(rawCoverageDir);
    const provider = await createCoverageProvider();
    await provider.clean();

    const coverageFilePath = resolve(
      provider.coverageFilesDirectory,
      "coverage-wpt.json",
    );
    await writeFile(coverageFilePath, JSON.stringify(mergedCoverage), "utf8");
    provider.coverageFiles.set("wpt", {
      ssr: {
        "wpt-runner": coverageFilePath,
      },
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
      process.exitCode = 1;
    }
  } finally {
    await rm(rawCoverageDir, { recursive: true, force: true });
  }
}

export async function createCoverageProvider(reportsDirectory = coverageDir) {
  const { V8CoverageProvider } = await import(
    "@vitest/coverage-v8/dist/provider.js"
  );
  const project = createProject();
  const provider = new V8CoverageProvider();
  provider.initialize({
    _coverageOptions: {
      allowExternal: false,
      clean: true,
      cleanOnRerun: true,
      exclude: [],
      excludeAfterRemap: false,
      // Preserve the previous all:false policy: measure only files observed by WPT.
      include: undefined,
      provider: "v8",
      reporter: [
        ["json-summary", { file: "coverage-summary.json" }],
        ["lcovonly", { file: "lcov.info" }],
        ["html", { subdir: "html" }],
      ],
      reportsDirectory: resolve(reportsDirectory),
      reportOnFailure: true,
      skipFull: false,
    },
    projects: [project],
    config: {
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
    version: provider.version,
  } as any);

  return provider;
}

function createProject() {
  const ssr = {
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
          typeof result.map === "string" ? JSON.parse(result.map) : result.map,
      };
    },
  };
  return {
    browser: undefined,
    config: {
      root: packageDir,
      environment: "node",
      experimental: { viteModuleRunner: true },
    },
    isBrowserEnabled: () => false,
    vite: { environments: { ssr } },
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
