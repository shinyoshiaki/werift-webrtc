/**
 * メモリリーク試験のレポート生成（JSON / CSV / Markdown）。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LeakAnalysis } from "./analyze";
import {
  type LeakVerdict,
  type MemorySample,
  ensureArtifactsDir,
  formatBytes,
  formatDuration,
} from "./heapUtils";
import type { ScenarioBudget } from "./scenarios";

export type ScenarioReport = {
  id: string;
  label: string;
  budget: ScenarioBudget;
  wallClockSeconds: number;
  equivalentSeconds: number;
  totalUnitsProcessed: number;
  samples: MemorySample[];
  snapshotPaths: string[];
  verdict: LeakVerdict;
  analysis?: LeakAnalysis;
  error?: string;
};

export type MemleakReport = {
  generatedAt: string;
  nodeVersion: string;
  gcExposed: boolean;
  targetHours: number;
  scenarios: ScenarioReport[];
};

export function writeReports(
  artifactsDir: string,
  report: MemleakReport,
): {
  jsonPath: string;
  csvPath: string;
  mdPath: string;
} {
  ensureArtifactsDir(artifactsDir);

  const jsonPath = join(artifactsDir, "report.json");
  const csvPath = join(artifactsDir, "report.csv");
  const mdPath = join(artifactsDir, "summary.md");

  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(csvPath, buildCsv(report), "utf8");
  writeFileSync(mdPath, buildMarkdown(report), "utf8");

  return { jsonPath, csvPath, mdPath };
}

function buildCsv(report: MemleakReport): string {
  const header = [
    "scenario",
    "cycle",
    "wallMs",
    "rss",
    "heapTotal",
    "heapUsed",
    "external",
    "arrayBuffers",
    "usedHeapSize",
    "activeTimerHandles",
    "snapshotPath",
  ].join(",");

  const rows: string[] = [header];
  for (const s of report.scenarios) {
    for (const sample of s.samples) {
      rows.push(
        [
          s.id,
          sample.cycle,
          sample.wallMs,
          sample.rss,
          sample.heapTotal,
          sample.heapUsed,
          sample.external,
          sample.arrayBuffers,
          sample.usedHeapSize,
          sample.activeTimerHandles,
          sample.snapshotPath ?? "",
        ].join(","),
      );
    }
  }
  return rows.join("\n") + "\n";
}

function buildMarkdown(report: MemleakReport): string {
  const lines: string[] = [];
  lines.push("# Memory Leak Test Summary");
  lines.push("");
  lines.push(`- Generated at: ${report.generatedAt}`);
  lines.push(`- Node.js: ${report.nodeVersion}`);
  lines.push(`- GC exposed (\`--expose-gc\`): ${report.gcExposed}`);
  lines.push(`- Target hours (equivalent): ${report.targetHours}`);
  lines.push("");

  for (const s of report.scenarios) {
    lines.push(`## ${s.label} (\`${s.id}\`)`);
    lines.push("");
    lines.push(
      s.verdict.leaked
        ? `**Result: FAIL (leak suspected)**`
        : s.error
          ? `**Result: ERROR**`
          : `**Result: PASS**`,
    );
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("| --- | --- |");
    lines.push(
      `| Wall clock | ${formatDuration(s.wallClockSeconds)} (${s.wallClockSeconds.toFixed(2)}s) |`,
    );
    lines.push(
      `| Equivalent time (workload) | ${formatDuration(s.equivalentSeconds)} (${s.equivalentSeconds.toFixed(2)}s) |`,
    );
    lines.push(
      `| Workload | ${s.totalUnitsProcessed} ${s.budget.unitName} (rate: ${s.budget.rateDescription}) |`,
    );
    lines.push(`| Iterations | ${s.budget.iterations} |`);
    lines.push(
      `| heapUsed slope | ${formatBytes(s.verdict.slopeBytesPerCycle)}/cycle (R²=${s.verdict.rSquared.toFixed(2)}) |`,
    );
    lines.push(
      `| Baseline median heapUsed | ${formatBytes(s.verdict.baselineMedian)} |`,
    );
    lines.push(
      `| Final median heapUsed | ${formatBytes(s.verdict.finalMedian)} |`,
    );
    lines.push(
      `| Margin | ${formatBytes(s.verdict.marginBytes)} (threshold slope ${formatBytes(s.verdict.thresholdSlope)}/cycle) |`,
    );
    if (s.verdict.reason) {
      lines.push(`| Verdict reason | ${s.verdict.reason} |`);
    }
    if (s.error) {
      lines.push(`| Error | ${s.error} |`);
    }
    lines.push("");

    if (s.analysis) {
      lines.push("### リーク箇所の分析");
      lines.push("");
      lines.push(s.analysis.summary);
      lines.push("");
      lines.push(`- Early snapshot: \`${s.analysis.earlySnapshot}\``);
      lines.push(`- Late snapshot: \`${s.analysis.lateSnapshot}\``);
      lines.push("");
      if (s.analysis.topIncreases.length > 0) {
        lines.push("| Class | Early | Late | Δ count | Δ self_size |");
        lines.push("| --- | ---: | ---: | ---: | ---: |");
        for (const d of s.analysis.topIncreases.slice(0, 15)) {
          lines.push(
            `| \`${d.name}\` | ${d.earlyCount} | ${d.lateCount} | +${d.delta} | ${formatBytes(d.selfSizeDelta)} |`,
          );
        }
        lines.push("");
      }
    }

    if (s.snapshotPaths.length > 0) {
      lines.push("### Snapshots");
      lines.push("");
      for (const p of s.snapshotPaths) {
        lines.push(`- \`${p}\``);
      }
      lines.push("");
    }

    lines.push(
      "> 実時間相当時間は「処理量 ÷ 想定レート」の換算値であり、実際の運用トラフィックと完全一致しない目安です。",
    );
    lines.push("");
  }

  lines.push("## How to interpret");
  lines.push("");
  lines.push(
    "1. **PASS** かつ equivalent time ≥ 3600s（`MEMLEAK_TARGET_HOURS=1`）なら、1 時間相当の処理量で有意なヒープ増加は検出されなかった。",
  );
  lines.push(
    "2. **FAIL** の場合は「リーク箇所の分析」の増加上位クラスを手がかりに、Chrome DevTools で `.heapsnapshot` を開きリテイナを確認する。",
  );
  lines.push("3. 詳細は `packages/webrtc/tests/memleak/README.md` を参照。");
  lines.push("");

  return lines.join("\n");
}
