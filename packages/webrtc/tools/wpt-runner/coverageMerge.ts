import { resolve } from "path";
import { mergeProcessCovs } from "@bcoe/v8-coverage";
import { readFile, readdir, rm } from "fs/promises";

export const WPT_V8_COVERAGE_TEMP_PREFIX = "werift-wpt-v8-";

export type ProcessCoverage = {
  result: Array<Record<string, unknown> & { url?: unknown }>;
};

export function createEmptyProcessCoverage(): ProcessCoverage {
  return { result: [] };
}

export function isTargetSourceCoverageUrl(value: unknown, sourceDir: string) {
  if (typeof value !== "string" || !value.startsWith("file://")) {
    return false;
  }

  return value.startsWith(`file://${sourceDir}/`) && value.endsWith(".ts");
}

export function mergeFilteredProcessCoverage(
  merged: ProcessCoverage,
  payload: { result?: ProcessCoverage["result"] },
  isTargetUrl: (url: unknown) => boolean,
): ProcessCoverage {
  if (!payload.result) {
    return merged;
  }

  return mergeProcessCovs([
    merged,
    {
      result: payload.result.filter((entry) => isTargetUrl(entry.url)),
    },
  ]) as ProcessCoverage;
}

export async function consumeCoverageFiles(
  directoryPath: string,
  merged: ProcessCoverage,
  isTargetUrl: (url: unknown) => boolean,
): Promise<ProcessCoverage> {
  const coverageFiles = (await readdir(directoryPath))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();

  let next = merged;
  for (const fileName of coverageFiles) {
    const filePath = resolve(directoryPath, fileName);
    let payload: { result?: ProcessCoverage["result"] };
    try {
      payload = JSON.parse(await readFile(filePath, "utf8")) as {
        result?: ProcessCoverage["result"];
      };
    } catch {
      // V8 が書き込み中の不完全な JSON は次の tick で取り込む。
      continue;
    }

    next = mergeFilteredProcessCoverage(next, payload, isTargetUrl);
    await rm(filePath, { force: true });
  }

  return next;
}

export async function removeStaleCoverageTempDirs(
  tmpDir: string,
  prefix = WPT_V8_COVERAGE_TEMP_PREFIX,
) {
  const entries = await readdir(tmpDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) =>
        rm(resolve(tmpDir, entry.name), { recursive: true, force: true }),
      ),
  );
}
