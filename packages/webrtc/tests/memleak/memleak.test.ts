/**
 * メモリリーク自動試験。
 *
 * 主要ユースケースを N サイクル繰り返し、ヒープ増加トレンドと
 * スナップショット比較でリークを検出する。
 *
 * 既定スイートからは除外され、`npm run memleak` でのみ実行する。
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { compareClassCounts } from "./analyze";
import {
  type MemleakEnv,
  type MemorySample,
  clearSyntheticLeak,
  detectLeak,
  forceGcAndSettle,
  hasGcExposed,
  linearRegressionSlope,
  median,
  readMemleakEnv,
} from "./heapUtils";
import {
  type MemleakReport,
  type ScenarioReport,
  writeReports,
} from "./report";
import { buildEnvBanner, runScenario } from "./runner";
import {
  RATES,
  computeBudgets,
  createAllScenarios,
  createSyntheticLeakScenario,
} from "./scenarios";

const env = readMemleakEnv();
const scenarioReports: ScenarioReport[] = [];

beforeAll(async () => {
  // Arrange: GC 露出とアーティファクト先を確認
  console.log(`[memleak] ${buildEnvBanner(env)}`);
  if (!hasGcExposed()) {
    console.warn(
      "[memleak] global.gc is not exposed. Run with --expose-gc (vitest poolOptions.execArgv or NODE_OPTIONS).",
    );
  }
  clearSyntheticLeak();
  await forceGcAndSettle();
});

afterAll(() => {
  // 全シナリオ結果をレポート化
  const report: MemleakReport = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    gcExposed: hasGcExposed(),
    targetHours: env.targetHours,
    scenarios: scenarioReports,
  };
  const paths = writeReports(env.artifactsDir, report);
  console.log(
    `[memleak] reports written: ${paths.jsonPath}, ${paths.csvPath}, ${paths.mdPath}`,
  );
  clearSyntheticLeak();
});

describe("memleak unit: detection helpers", () => {
  test("linearRegressionSlope detects positive trend", () => {
    // Act: 単調増加系列の傾きを計算
    const xs = [0, 1, 2, 3, 4];
    const ys = [100, 200, 300, 400, 500];
    const slope = linearRegressionSlope(xs, ys);
    // Assert: 1 ステップあたり 100 増加
    expect(slope).toBeCloseTo(100, 5);
  });

  test("detectLeak passes on stable heap samples", () => {
    // Arrange: ウォームアップ後もほぼ一定の heapUsed
    const samples: MemorySample[] = Array.from({ length: 20 }, (_, i) => ({
      cycle: i,
      wallMs: i * 10,
      rss: 50_000_000,
      heapTotal: 20_000_000,
      heapUsed: 10_000_000 + (i % 3) * 1_000,
      external: 0,
      arrayBuffers: 0,
      heapSizeLimit: 4_000_000_000,
      totalHeapSize: 20_000_000,
      usedHeapSize: 10_000_000,
      activeTimerHandles: 2,
    }));

    // Act
    const verdict = detectLeak(samples, {
      warmup: 5,
      slopeThresholdBytes: 64 * 1024,
      marginRatio: 0.25,
    });

    // Assert: 安定系列はリークなし
    expect(verdict.leaked).toBe(false);
  });

  test("detectLeak fails on growing heap samples (synthetic leak case)", () => {
    // Arrange: サイクルごとに 200KiB 増加する合成リーク系列
    const samples: MemorySample[] = Array.from({ length: 20 }, (_, i) => ({
      cycle: i,
      wallMs: i * 10,
      rss: 50_000_000 + i * 200_000,
      heapTotal: 20_000_000 + i * 200_000,
      heapUsed: 10_000_000 + i * 200 * 1024,
      external: 0,
      arrayBuffers: 0,
      heapSizeLimit: 4_000_000_000,
      totalHeapSize: 20_000_000,
      usedHeapSize: 10_000_000 + i * 200 * 1024,
      activeTimerHandles: 2,
    }));

    // Act
    const verdict = detectLeak(samples, {
      warmup: 5,
      slopeThresholdBytes: 64 * 1024,
      marginRatio: 0.25,
    });

    // Assert: 増加系列はリークとして検出される
    expect(verdict.leaked).toBe(true);
    expect(verdict.reason).toBeTruthy();
    expect(verdict.slopeBytesPerCycle).toBeGreaterThan(64 * 1024);
    expect(verdict.rSquared).toBeGreaterThan(0.9);
  });

  test("detectLeak ignores noisy short slopes without R² support", () => {
    // Arrange: 中央値は安定だが中盤だけ跳ねる短系列（誤検知になりやすいパターン）
    const heap = [
      10_000_000, 10_100_000, 12_000_000, 10_050_000, 10_020_000, 10_080_000,
    ];
    const samples: MemorySample[] = heap.map((heapUsed, i) => ({
      cycle: i,
      wallMs: i * 10,
      rss: 50_000_000,
      heapTotal: 20_000_000,
      heapUsed,
      external: 0,
      arrayBuffers: 0,
      heapSizeLimit: 4_000_000_000,
      totalHeapSize: 20_000_000,
      usedHeapSize: heapUsed,
      activeTimerHandles: 2,
    }));

    // Act
    const verdict = detectLeak(samples, {
      warmup: 0,
      slopeThresholdBytes: 64 * 1024,
      marginRatio: 0.25,
      minSamplesForSlope: 8,
    });

    // Assert: サンプル不足により傾き判定はスキップされ、マージンも未超過
    expect(verdict.leaked).toBe(false);
  });

  test("compareClassCounts ranks growing constructors", () => {
    // Arrange: 早期/後期のクラス別カウント
    const early = new Map([
      [
        "RTCPeerConnection",
        { name: "RTCPeerConnection", count: 2, selfSize: 200 },
      ],
      ["Buffer", { name: "Buffer", count: 10, selfSize: 1000 }],
    ]);
    const late = new Map([
      [
        "RTCPeerConnection",
        { name: "RTCPeerConnection", count: 12, selfSize: 1200 },
      ],
      ["Buffer", { name: "Buffer", count: 11, selfSize: 1100 }],
      ["Timeout", { name: "Timeout", count: 5, selfSize: 500 }],
    ]);

    // Act
    const deltas = compareClassCounts(early, late);

    // Assert: RTCPeerConnection の増加が上位
    expect(deltas[0].name).toBe("RTCPeerConnection");
    expect(deltas[0].delta).toBe(10);
    expect(deltas.find((d) => d.name === "Timeout")?.delta).toBe(5);
  });

  test("median helper", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("memleak unit: budget (1 hour equivalent)", () => {
  test("default targetHours=1 yields 1h-equivalent budgets", () => {
    // Arrange
    const e = readMemleakEnv({
      targetHours: 1,
      iterations: 50,
      // 明示オーバーライドを消す
      mediaFrames: undefined,
      dcMessages: undefined,
      connCycles: undefined,
    });

    // Act
    const budgets = computeBudgets(e);

    // Assert: 1 時間相当の総処理量
    expect(budgets.media.totalUnits).toBe(RATES.mediaFps * 3600);
    expect(budgets.media.equivalentSeconds).toBe(3600);
    expect(budgets.media.unitsPerCycle).toBe(
      Math.ceil((RATES.mediaFps * 3600) / 50),
    );

    expect(budgets.datachannel.totalUnits).toBe(RATES.dcMessagesPerSec * 3600);
    expect(budgets.datachannel.equivalentSeconds).toBe(3600);

    expect(budgets.connection.totalUnits).toBe(60);
    expect(budgets.connection.equivalentSeconds).toBe(3600);
    expect(budgets.connection.iterations).toBe(60);
  });
});

describe("memleak scenarios", () => {
  // 実行時間が長いためシナリオごとに十分な timeout を与える
  const scenarioTimeoutMs = Number(
    process.env.MEMLEAK_TEST_TIMEOUT_MS ?? 30 * 60 * 1000,
  );

  const scenarios = createAllScenarios(env);

  for (const scenario of scenarios) {
    test(
      `${scenario.id}: ${scenario.label}`,
      async () => {
        // Arrange: シナリオと環境は createAllScenarios / readMemleakEnv 済み
        console.log(
          `[memleak] start ${scenario.id} iterations=${scenario.budget.iterations} units/cycle=${scenario.budget.unitsPerCycle} equivalent=${scenario.budget.equivalentSeconds}s`,
        );

        // Act: N サイクル実行 + 定期サンプリング/スナップショット
        const report = await runScenario(scenario, env);
        scenarioReports.push(report);

        console.log(
          `[memleak] done ${scenario.id} wall=${report.wallClockSeconds.toFixed(1)}s equiv=${report.equivalentSeconds.toFixed(1)}s leaked=${report.verdict.leaked} units=${report.totalUnitsProcessed}`,
        );

        // Assert: 実行エラーがないこと
        expect(report.error, report.error).toBeUndefined();

        // Assert: サンプルとスナップショットが取得されていること
        expect(report.samples.length).toBeGreaterThan(0);
        expect(report.snapshotPaths.length).toBeGreaterThan(0);

        // Assert: 実時間相当が目標に達していること（targetHours>0 のとき）
        if (env.targetHours > 0) {
          const minEquivalent = env.targetHours * 3600 * 0.99;
          expect(report.equivalentSeconds).toBeGreaterThanOrEqual(
            minEquivalent,
          );
        }

        // Assert: ヒープ増加トレンドが閾値以内（リークなし）
        expect(
          report.verdict.leaked,
          report.verdict.reason ?? "leak detected",
        ).toBe(false);
      },
      scenarioTimeoutMs,
    );
  }
});

describe("memleak synthetic leak verification", () => {
  test("injected heap growth is detected and analyzed", async () => {
    // Arrange: 意図的リークを注入する短縮シナリオ
    const leakEnv: MemleakEnv = {
      ...env,
      iterations: 15,
      warmup: 2,
      snapshotInterval: 3,
      // 合成リークは 1MB/cycle 規模で明確に増やす
      slopeThresholdBytes: 64 * 1024,
      marginRatio: 0.15,
      analyzeMode: "always",
      injectLeakBytes: 1024 * 1024,
      targetHours: 0,
      artifactsDir: env.artifactsDir,
    };
    clearSyntheticLeak();
    const scenario = createSyntheticLeakScenario(leakEnv);

    // Act
    const report = await runScenario(scenario, leakEnv);
    scenarioReports.push(report);
    clearSyntheticLeak();

    // Assert: 合成リークが検出されること
    expect(report.verdict.leaked).toBe(true);
    expect(report.snapshotPaths.length).toBeGreaterThanOrEqual(2);

    // Assert: 分析結果がレポートに含まれ、合成クラスの増加が抽出されること
    expect(report.analysis).toBeTruthy();
    expect(report.analysis!.topIncreases.length).toBeGreaterThan(0);
    const names = report.analysis!.topIncreases.map((d) => d.name);
    console.log(
      `[memleak] synthetic analysis top: ${names.slice(0, 8).join(", ")}`,
    );
    expect(
      names.some(
        (n) =>
          n.includes("MemleakSyntheticChunk") ||
          n === "string" ||
          n === "Array",
      ),
      `expected synthetic growth in analysis, got: ${names.slice(0, 10).join(", ")}`,
    ).toBe(true);
    expect(report.analysis!.summary.length).toBeGreaterThan(0);
  }, 120_000);
});
