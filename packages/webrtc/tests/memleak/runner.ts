/**
 * シナリオを N サイクル実行し、サンプリング・スナップショット・判定・分析を行うランナー。
 */
import { type LeakAnalysis, compareSnapshots } from "./analyze";
import {
  type MemleakEnv,
  type MemorySample,
  detectLeak,
  ensureArtifactsDir,
  forceGcAndSettle,
  hasGcExposed,
  sampleMemory,
  shouldTakeSnapshot,
  takeHeapSnapshot,
} from "./heapUtils";
import type { ScenarioReport } from "./report";
import type { Scenario } from "./scenarios";

export async function runScenario(
  scenario: Scenario,
  env: MemleakEnv,
): Promise<ScenarioReport> {
  ensureArtifactsDir(env.artifactsDir);

  const samples: MemorySample[] = [];
  const snapshotPaths: string[] = [];
  let totalUnits = 0;
  let error: string | undefined;
  const wallStart = Date.now();

  const iterations = scenario.budget.iterations;

  for (let cycle = 0; cycle < iterations; cycle++) {
    try {
      const result = await scenario.runCycle(cycle);
      totalUnits += result.unitsProcessed;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      // 失敗時もスナップショットを残して原因調査できるようにする
      await forceGcAndSettle();
      const snap = takeHeapSnapshot(
        env.artifactsDir,
        scenario.id,
        cycle,
        "error",
      );
      snapshotPaths.push(snap);
      const sample = sampleMemory(cycle, Date.now() - wallStart);
      sample.snapshotPath = snap;
      samples.push(sample);
      break;
    }

    // close 後の非同期クリーンアップを消化してから計測
    await forceGcAndSettle(50);

    const forceSnap = false;
    const takeSnap = shouldTakeSnapshot(
      cycle,
      iterations,
      env.snapshotInterval,
      forceSnap,
    );

    let snapshotPath: string | undefined;
    if (takeSnap) {
      snapshotPath = takeHeapSnapshot(env.artifactsDir, scenario.id, cycle);
      snapshotPaths.push(snapshotPath);
    }

    const sample = sampleMemory(cycle, Date.now() - wallStart);
    sample.snapshotPath = snapshotPath;
    samples.push(sample);
  }

  const wallClockSeconds = (Date.now() - wallStart) / 1000;
  const equivalentSeconds =
    totalUnits > 0 && scenario.budget.totalUnits > 0
      ? (totalUnits / scenario.budget.totalUnits) *
        scenario.budget.equivalentSeconds
      : scenario.budget.equivalentSeconds;

  const verdict = detectLeak(samples, {
    warmup: Math.min(env.warmup, Math.max(0, samples.length - 3)),
    slopeThresholdBytes: env.slopeThresholdBytes,
    marginRatio: env.marginRatio,
  });

  let analysis: LeakAnalysis | undefined;
  const shouldAnalyze =
    env.analyzeMode === "always" ||
    (env.analyzeMode === "on-fail" && verdict.leaked);

  if (shouldAnalyze && snapshotPaths.length >= 2) {
    try {
      analysis = compareSnapshots(
        snapshotPaths[0],
        snapshotPaths[snapshotPaths.length - 1],
      );
    } catch (e) {
      // 解析失敗はレポートに理由を残し、本体判定は維持する
      analysis = {
        earlySnapshot: snapshotPaths[0],
        lateSnapshot: snapshotPaths[snapshotPaths.length - 1],
        topIncreases: [],
        summary: `analyze failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return {
    id: scenario.id,
    label: scenario.label,
    budget: {
      ...scenario.budget,
      totalUnits,
      equivalentSeconds: scenario.budget.equivalentSeconds,
    },
    wallClockSeconds,
    equivalentSeconds,
    totalUnitsProcessed: totalUnits,
    samples,
    snapshotPaths,
    verdict,
    analysis,
    error,
    expectedLeak: scenario.expectedLeak,
  };
}

export function buildEnvBanner(env: MemleakEnv): string {
  return [
    `Node ${process.version}`,
    `gc=${hasGcExposed()}`,
    `iterations=${env.iterations}`,
    `targetHours=${env.targetHours}`,
    `snapshotInterval=${env.snapshotInterval}`,
    `warmup=${env.warmup}`,
    `analyze=${env.analyzeMode}`,
    `artifacts=${env.artifactsDir}`,
  ].join(" ");
}
