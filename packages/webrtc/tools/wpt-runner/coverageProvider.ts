import { mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TraceMap, eachMapping } from "@jridgewell/trace-mapping";
import { transform } from "esbuild";
import { type CoverageMap, createCoverageMap } from "istanbul-lib-coverage";
import v8ToIstanbul from "v8-to-istanbul";

const { createContext } = require("istanbul-lib-report");
const { create } = require("istanbul-reports");

type ProcessCoverage = {
  result: Array<{
    url: string;
    functions: Parameters<ReturnType<typeof v8ToIstanbul>["applyCoverage"]>[0];
  }>;
};

// Keep the pre-AST V8 metrics used by coverage-baseline.json. WPT collects
// coverage outside Vitest, so it does not need Vitest's private provider API.
export async function convertCoverage(coverage: ProcessCoverage) {
  const coverageMap = createCoverageMap({});
  for (const { url, functions } of coverage.result) {
    const sourcePath = fileURLToPath(url);
    const originalSource = await readFile(sourcePath, "utf8");
    const result = await transform(originalSource, {
      format: "esm",
      loader: "ts",
      sourcefile: sourcePath,
      sourcemap: true,
      target: "es2022",
    });
    const map = JSON.parse(result.map);
    map.sources = map.sources.map(
      (source: string) => new URL(source, url).href,
    );
    const converter = v8ToIstanbul(url, 0, {
      source: result.code,
      originalSource,
      sourceMap: { sourcemap: map },
    });
    await converter.load();
    converter.applyCoverage(functions);
    const converted = converter.toIstanbul();
    // Preserve ignoreEmptyLines:true from the old provider: only mapped
    // source lines contribute to statement and line coverage.
    const mappedLines = new Set<number>();
    eachMapping(new TraceMap(map), (mapping) => {
      if (mapping.originalLine !== null) mappedLines.add(mapping.originalLine);
    });
    for (const file of Object.values(converted)) {
      for (const [id, location] of Object.entries(file.statementMap)) {
        if (!mappedLines.has(location.start.line)) {
          delete file.statementMap[id];
          delete file.s[id];
        }
      }
      for (const [id, branch] of Object.entries(file.branchMap)) {
        if (!mappedLines.has(branch.loc.start.line)) file.b[id] = [1];
      }
      for (const [id, fn] of Object.entries(file.fnMap)) {
        if (!mappedLines.has(fn.loc.start.line)) file.f[id] = 1;
      }
    }
    coverageMap.merge(converted);
  }
  return coverageMap;
}

export async function generateCoverageReports(
  coverageMap: CoverageMap,
  reportsDirectory: string,
) {
  await rm(reportsDirectory, { recursive: true, force: true });
  await mkdir(reportsDirectory, { recursive: true });
  const context = createContext({ dir: reportsDirectory, coverageMap });
  create("json-summary", { file: "coverage-summary.json" }).execute(context);
  create("lcovonly", { file: "lcov.info" }).execute(context);
  create("html", { subdir: "html" }).execute(context);
}
