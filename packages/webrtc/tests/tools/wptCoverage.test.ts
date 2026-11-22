import { readdir, rm } from "fs/promises";
import { expect, test } from "vitest";

import {
  extractCoverageTotals,
  findCoverageRegressions,
  roundCoverage,
} from "../../tools/wpt-runner/coverageLogic";
import {
  consumeCoverageFiles,
  createEmptyProcessCoverage,
  isTargetSourceCoverageUrl,
  mergeFilteredProcessCoverage,
  removeStaleCoverageTempDirs,
} from "../../tools/wpt-runner/coverageMerge";
import {
  createCoverageTempDir,
  createNamedCoverageTempDir,
  createScriptCoverage,
  writeCoverageJson,
  writePartialCoverageJson,
} from "./wptCoverageArrange";

test("coverage ratchet fails when rounded coverage falls below the baseline", () => {
  const baseline = {
    statements: 53.72,
    branches: 73.71,
    functions: 58.07,
    lines: 53.71,
  };
  const summary = {
    total: {
      statements: { pct: 53.714 },
      branches: { pct: 73.71 },
      functions: { pct: 58.07 },
      lines: { pct: 53.71 },
    },
  };

  // 実行: coverage summary を baseline 比較用の小数第2位へ正規化する。
  const totals = extractCoverageTotals(summary);
  const regressions = findCoverageRegressions(totals, baseline);

  // 検証: baseline を 0.01pt でも下回った指標は回帰として検出される。
  expect(totals).toEqual({
    statements: 53.71,
    branches: 73.71,
    functions: 58.07,
    lines: 53.71,
  });
  expect(regressions).toEqual([
    {
      metric: "statements",
      current: 53.71,
      baseline: 53.72,
    },
  ]);
});

test("coverage rounding is fixed to two decimal places before baseline updates", () => {
  // 実行: baseline 保存前の coverage 値を丸め規則へ通す。
  const rounded = roundCoverage(58.075);

  // 検証: baseline に保存される coverage は常に小数第2位へ固定される。
  expect(rounded).toBe(58.08);
});

test("consumeCoverageFiles keeps only target source coverage and deletes complete dumps", async () => {
  const sourceDir = "/workspace/packages/webrtc/src";
  const directoryPath = await createCoverageTempDir("werift-wpt-merge-test-");
  try {
    await writeCoverageJson(directoryPath, "coverage-1.json", {
      result: [
        createScriptCoverage(`file://${sourceDir}/peerConnection.ts`, 1),
        createScriptCoverage("file:///other/ignored.ts", 4),
      ],
    });
    await writeCoverageJson(directoryPath, "coverage-2.json", {
      result: [
        createScriptCoverage(`file://${sourceDir}/peerConnection.ts`, 2),
      ],
    });
    await writePartialCoverageJson(directoryPath, "coverage-partial.json");

    // 実行: 完成済み dump だけを取り込み、対象 source 以外は捨てる。
    const merged = await consumeCoverageFiles(
      directoryPath,
      createEmptyProcessCoverage(),
      (url) => isTargetSourceCoverageUrl(url, sourceDir),
    );

    // 検証: 対象 TS だけが残り、不完全 JSON は次の消費まで残る。
    expect(merged.result).toHaveLength(1);
    expect(merged.result[0]?.url).toBe(`file://${sourceDir}/peerConnection.ts`);
    expect(await readdir(directoryPath)).toEqual(["coverage-partial.json"]);
  } finally {
    await rm(directoryPath, { force: true, recursive: true });
  }
});

test("incremental coverage merge matches a single combined merge", () => {
  const sourceDir = "/workspace/packages/webrtc/src";
  const isTargetUrl = (url: unknown) =>
    isTargetSourceCoverageUrl(url, sourceDir);
  const first = {
    result: [createScriptCoverage(`file://${sourceDir}/transport/dtls.ts`, 1)],
  };
  const second = {
    result: [createScriptCoverage(`file://${sourceDir}/transport/dtls.ts`, 3)],
  };

  // 実行: 同じ dump を逐次 merge した場合と一括 merge した場合を比較する。
  const incremental = mergeFilteredProcessCoverage(
    mergeFilteredProcessCoverage(
      createEmptyProcessCoverage(),
      first,
      isTargetUrl,
    ),
    second,
    isTargetUrl,
  );
  const combined = mergeFilteredProcessCoverage(
    createEmptyProcessCoverage(),
    { result: [...first.result, ...second.result] },
    isTargetUrl,
  );

  // 検証: 取り込み順が違っても同一 script の coverage は同じ結果になる。
  expect(incremental).toEqual(combined);
});

test("removeStaleCoverageTempDirs deletes only leftover V8 coverage directories", async () => {
  const parentDir = await createCoverageTempDir("werift-wpt-tmp-parent-");
  try {
    const staleDir = await createNamedCoverageTempDir(
      parentDir,
      "werift-wpt-v8-stale",
    );
    const keepDir = await createNamedCoverageTempDir(parentDir, "other-temp");
    await writeCoverageJson(staleDir, "coverage-stale.json", { result: [] });
    await writeCoverageJson(keepDir, "keep.json", { result: [] });

    // 実行: 失敗後に残った werift-wpt-v8-* だけを掃除し、他の一時ディレクトリは残す。
    await removeStaleCoverageTempDirs(parentDir);

    // 検証: coverage 用 leftover は消え、無関係な一時ディレクトリは残る。
    expect(await readdir(parentDir)).toEqual(["other-temp"]);
    expect(await readdir(keepDir)).toEqual(["keep.json"]);
  } finally {
    await rm(parentDir, { force: true, recursive: true });
  }
});
