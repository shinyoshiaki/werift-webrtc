/**
 * ヒープ計測・スナップショット取得・GC 強制・サンプリングの共通ユーティリティ。
 * memleak 試験の Arrange 用ヘルパは本ファイルに集約する。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { memoryUsage } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { getHeapStatistics, writeHeapSnapshot } from "node:v8";

/** 1 サイクル終了時のメモリサンプル */
export type MemorySample = {
  cycle: number;
  wallMs: number;
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  heapSizeLimit: number;
  totalHeapSize: number;
  usedHeapSize: number;
  activeTimerHandles: number;
  snapshotPath?: string;
};

export type LeakVerdict = {
  leaked: boolean;
  reason?: string;
  slopeBytesPerCycle: number;
  rSquared: number;
  baselineMedian: number;
  finalMedian: number;
  marginBytes: number;
  thresholdSlope: number;
  samplesUsed: number;
};

export type MemleakEnv = {
  iterations: number;
  snapshotInterval: number;
  warmup: number;
  targetHours: number;
  slopeThresholdBytes: number;
  marginRatio: number;
  analyzeMode: "on-fail" | "always" | "never";
  artifactsDir: string;
  mediaFrames?: number;
  dcMessages?: number;
  connCycles?: number;
  /** 合成リーク検証用: サイクルごとに保持する Buffer サイズ (bytes) */
  injectLeakBytes: number;
};

export function readMemleakEnv(
  overrides: Partial<MemleakEnv> = {},
): MemleakEnv {
  const num = (key: string, fallback: number) => {
    const raw = process.env[key];
    if (raw == null || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  const analyzeRaw = (process.env.MEMLEAK_ANALYZE ?? "on-fail").toLowerCase();
  const analyzeMode: MemleakEnv["analyzeMode"] =
    analyzeRaw === "always" ||
    analyzeRaw === "never" ||
    analyzeRaw === "on-fail"
      ? analyzeRaw
      : "on-fail";

  const artifactsDir =
    process.env.MEMLEAK_ARTIFACTS_DIR ??
    join(process.cwd(), "artifacts", "memleak");

  const base: MemleakEnv = {
    iterations: Math.max(1, Math.floor(num("MEMLEAK_ITERATIONS", 50))),
    snapshotInterval: Math.max(
      1,
      Math.floor(num("MEMLEAK_SNAPSHOT_INTERVAL", 10)),
    ),
    warmup: Math.max(0, Math.floor(num("MEMLEAK_WARMUP", 10))),
    targetHours: Math.max(0, num("MEMLEAK_TARGET_HOURS", 1)),
    // 既定は GC ゆらぎを踏まえて余裕を持たせる（64KiB は短サイクルで誤検知しやすい）
    slopeThresholdBytes: num("MEMLEAK_SLOPE_THRESHOLD", 256 * 1024),
    marginRatio: num("MEMLEAK_MARGIN_RATIO", 0.3),
    analyzeMode,
    artifactsDir,
    injectLeakBytes: Math.max(
      0,
      Math.floor(num("MEMLEAK_INJECT_LEAK_BYTES", 0)),
    ),
  };

  if (process.env.MEMLEAK_MEDIA_FRAMES) {
    base.mediaFrames = Math.max(0, Math.floor(num("MEMLEAK_MEDIA_FRAMES", 0)));
  }
  if (process.env.MEMLEAK_DC_MESSAGES) {
    base.dcMessages = Math.max(0, Math.floor(num("MEMLEAK_DC_MESSAGES", 0)));
  }
  if (process.env.MEMLEAK_CONN_CYCLES) {
    base.connCycles = Math.max(1, Math.floor(num("MEMLEAK_CONN_CYCLES", 1)));
  }

  return { ...base, ...overrides };
}

/** 強制 GC + 非同期クリーンアップの 1 巡待ち */
export async function forceGcAndSettle(settleMs = 20): Promise<void> {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (typeof gc === "function") {
    gc();
    // 2 回目で最終化待ちオブジェクトも回収しやすくする
    gc();
  }
  await delay(settleMs);
  // イベントループ上の microtask / nextTick を消化
  await new Promise<void>((r) => setImmediate(r));
}

export function countActiveTimerHandles(): number {
  const handles = (
    process as NodeJS.Process & {
      _getActiveHandles?: () => unknown[];
    }
  )._getActiveHandles?.();
  if (!handles) return -1;
  return handles.filter((handle) => {
    const name = (handle as { constructor?: { name?: string } })?.constructor
      ?.name;
    return name === "Timeout" || name === "Immediate";
  }).length;
}

export function sampleMemory(cycle: number, wallMs: number): MemorySample {
  const mu = memoryUsage();
  const hs = getHeapStatistics();
  return {
    cycle,
    wallMs,
    rss: mu.rss,
    heapTotal: mu.heapTotal,
    heapUsed: mu.heapUsed,
    external: mu.external,
    arrayBuffers: mu.arrayBuffers,
    heapSizeLimit: hs.heap_size_limit,
    totalHeapSize: hs.total_heap_size,
    usedHeapSize: hs.used_heap_size,
    activeTimerHandles: countActiveTimerHandles(),
  };
}

export function ensureArtifactsDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function takeHeapSnapshot(
  artifactsDir: string,
  scenarioId: string,
  cycle: number,
  tag = "cycle",
): string {
  ensureArtifactsDir(artifactsDir);
  const fileName = `${scenarioId}-${tag}-${String(cycle).padStart(4, "0")}.heapsnapshot`;
  const path = join(artifactsDir, fileName);
  return writeHeapSnapshot(path);
}

export function shouldTakeSnapshot(
  cycle: number,
  iterations: number,
  interval: number,
  force: boolean,
): boolean {
  if (force) return true;
  if (cycle === 0 || cycle === iterations - 1) return true;
  return (cycle + 1) % interval === 0;
}

/** 単純線形回帰: y ≈ a + b*x の傾き b と決定係数 R² を返す */
export function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number; rSquared: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, rSquared: 0 };
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumXX += xs[i] * xs[i];
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) {
    return { slope: 0, intercept: sumY / n, rSquared: 0 };
  }
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const meanY = sumY / n;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const fitted = intercept + slope * xs[i];
    ssTot += (ys[i] - meanY) ** 2;
    ssRes += (ys[i] - fitted) ** 2;
  }
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, rSquared };
}

/** 単純線形回帰の傾きのみ（ユニットテスト互換） */
export function linearRegressionSlope(xs: number[], ys: number[]): number {
  return linearRegression(xs, ys).slope;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/** 移動中央値（窓幅 window、両端は利用可能データのみ） */
export function movingMedian(values: number[], window = 5): number[] {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(values.length, i + half + 1);
    return median(values.slice(start, end));
  });
}

/**
 * ウォームアップ後の heapUsed トレンドからリークを判定する。
 * - 線形回帰の傾きが thresholdSlope を超え、かつ R² が十分高い（一貫した増加）
 * - または最終中央値が ベースライン中央値 * (1 + marginRatio) を超える
 *
 * 短サイクルでの GC ゆらぎによる誤検知を抑えるため、傾き判定には
 * 最小サンプル数と R² 閾値を要求する。
 */
export function detectLeak(
  samples: MemorySample[],
  options: {
    warmup: number;
    slopeThresholdBytes: number;
    marginRatio: number;
    minSamplesForSlope?: number;
    minRSquared?: number;
  },
): LeakVerdict {
  const minSamplesForSlope = options.minSamplesForSlope ?? 8;
  const minRSquared = options.minRSquared ?? 0.6;

  const afterWarmup = samples.filter((s) => s.cycle >= options.warmup);
  if (afterWarmup.length < 3) {
    return {
      leaked: false,
      reason: "insufficient samples after warmup",
      slopeBytesPerCycle: 0,
      rSquared: 0,
      baselineMedian: 0,
      finalMedian: 0,
      marginBytes: 0,
      thresholdSlope: options.slopeThresholdBytes,
      samplesUsed: afterWarmup.length,
    };
  }

  const smoothed = movingMedian(
    afterWarmup.map((s) => s.heapUsed),
    5,
  );
  const xs = afterWarmup.map((s) => s.cycle);
  const { slope, rSquared } = linearRegression(xs, smoothed);

  // ベースラインと最終を重ならない窓で取り、短系列で同一中央値になる誤判定を避ける
  const windowSize = Math.min(5, Math.max(1, Math.floor(smoothed.length / 2)));
  const baselineWindow = smoothed.slice(0, windowSize);
  const finalWindow = smoothed.slice(smoothed.length - windowSize);
  const baselineMedian = median(baselineWindow);
  const finalMedian = median(finalWindow);
  const marginBytes = baselineMedian * options.marginRatio;

  const slopeLeak =
    afterWarmup.length >= minSamplesForSlope &&
    rSquared >= minRSquared &&
    slope > options.slopeThresholdBytes;
  const marginLeak = finalMedian > baselineMedian + marginBytes;

  let reason: string | undefined;
  if (slopeLeak && marginLeak) {
    reason = `slope ${formatBytes(slope)}/cycle (R²=${rSquared.toFixed(2)}) exceeds ${formatBytes(options.slopeThresholdBytes)}/cycle and final median ${formatBytes(finalMedian)} exceeds baseline ${formatBytes(baselineMedian)} + margin ${formatBytes(marginBytes)}`;
  } else if (slopeLeak) {
    reason = `slope ${formatBytes(slope)}/cycle (R²=${rSquared.toFixed(2)}) exceeds ${formatBytes(options.slopeThresholdBytes)}/cycle`;
  } else if (marginLeak) {
    reason = `final median ${formatBytes(finalMedian)} exceeds baseline ${formatBytes(baselineMedian)} + margin ${formatBytes(marginBytes)}`;
  }

  return {
    leaked: slopeLeak || marginLeak,
    reason,
    slopeBytesPerCycle: slope,
    rSquared,
    baselineMedian,
    finalMedian,
    marginBytes,
    thresholdSlope: options.slopeThresholdBytes,
    samplesUsed: afterWarmup.length,
  };
}

export function formatBytes(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  if (abs >= 1024) return `${(n / 1024).toFixed(2)} KiB`;
  return `${n.toFixed(0)} B`;
}

export function formatDuration(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
  }
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m ${s}s`;
  }
  return `${seconds.toFixed(2)}s`;
}

/**
 * 合成リーク保持用（検証シナリオ専用）。
 * Node Buffer は external/arrayBuffers 側に載り heapUsed に出にくいため、
 * 名前付きクラスのインスタンスを V8 ヒープ上に保持して heapUsed を増やす。
 * スナップショット解析でもコンストラクタ名で追跡できるようにする。
 *
 * 同一内容の巨大文字列は V8 が共有（intern）し heapUsed が増えないため、
 * プレフィックス付きのユニークな断片を複数保持する。
 */
export class MemleakSyntheticChunk {
  readonly pieces: string[];
  constructor(seq: number, byteSize: number) {
    const pieceChars = 256;
    const count = Math.max(1, Math.ceil(byteSize / (pieceChars * 2)));
    this.pieces = Array.from({ length: count }, (_, i) => {
      const prefix = `L${seq}_${i}_`;
      return prefix + "x".repeat(Math.max(0, pieceChars - prefix.length));
    });
  }
}

const injectedLeakHold: MemleakSyntheticChunk[] = [];

export function injectSyntheticLeak(bytes: number): void {
  if (bytes <= 0) return;
  injectedLeakHold.push(
    new MemleakSyntheticChunk(injectedLeakHold.length, bytes),
  );
}

export function clearSyntheticLeak(): void {
  injectedLeakHold.length = 0;
}

export function hasGcExposed(): boolean {
  return (
    typeof (globalThis as typeof globalThis & { gc?: () => void }).gc ===
    "function"
  );
}
