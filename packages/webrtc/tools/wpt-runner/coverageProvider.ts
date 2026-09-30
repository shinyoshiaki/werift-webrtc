import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { transform as esbuildTransform } from "esbuild";

const packageDir = resolve(__dirname, "..", "..");
const coverageDir = resolve(packageDir, "..", "..", "coverage", "webrtc-wpt");

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
