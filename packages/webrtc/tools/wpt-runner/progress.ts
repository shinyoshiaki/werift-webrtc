import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, resolve } from "path";

import type { WptResultRecord, WptRunReport } from "./runner";

const packageDir = process.cwd();

export const defaultProgressPath = resolve(packageDir, "wpt", "progress.md");
export const defaultProgressStatePath = resolve(
  packageDir,
  "wpt",
  "progress.state.json",
);

const progressStateStart = "<!-- wpt-progress-state:start";
const progressStateEnd = "wpt-progress-state:end -->";

export type WptProgressTargetStatus = "active" | "done" | "excluded";

export interface WptProgressSubtestState {
  excluded: boolean;
  exclusionReason?: string;
  failedAttempts: number;
  lastError?: string;
  latestStatus: WptResultRecord["status"];
  name: string;
}

export interface WptProgressTargetState {
  effectivePass: number;
  effectiveTotal: number;
  excludedSubtests: number;
  fail: number;
  file: string;
  pass: number;
  status: WptProgressTargetStatus;
  subtests: WptProgressSubtestState[];
  successRate: number;
  timeout: number;
  total: number;
  variant: string;
}

export interface WptProgressAttemptLogEntry {
  file: string;
  filter: string;
  latestError?: string;
  latestStatus: WptResultRecord["status"];
  runId: string;
  subtest: string;
  timestamp: string;
  variant: string;
}

export interface WptProgressState {
  attemptLog: WptProgressAttemptLogEntry[];
  attemptRuns: number;
  generatedAt: string;
  targets: WptProgressTargetState[];
}

export async function updateWptProgressReport(
  report: WptRunReport,
  progressPath: string = defaultProgressPath,
) {
  const previousState = await readExistingProgressState(
    defaultProgressStatePath,
    progressPath,
  );
  const nextState = buildWptProgressState(report, previousState, resolveBuildOptions());
  const markdown = formatWptProgressMarkdown(nextState);
  const serializedState = formatWptProgressState(nextState);

  await mkdir(dirname(progressPath), { recursive: true });
  await Promise.all([
    writeFile(progressPath, markdown, "utf8"),
    writeFile(defaultProgressStatePath, serializedState, "utf8"),
  ]);

  return { markdown, state: nextState };
}

export function buildWptProgressState(
  report: WptRunReport,
  previousState?: WptProgressState,
  options: {
    attemptFilter?: string;
    canonical?: boolean;
  } = {},
): WptProgressState {
  const canonical = options.canonical ?? true;
  const attemptFilter = sanitizeAttemptFilter(options.attemptFilter);
  const previousAttemptRuns = countAttemptRuns(previousState?.attemptLog ?? []);
  const currentAttemptRunId = attemptFilter
    ? `attempt-${previousAttemptRuns + 1}`
    : undefined;
  const currentTargets = summarizeResults(report.results);
  const previousTargets = new Map(
    (previousState?.targets ?? []).map((target) => [targetKey(target), target]),
  );
  const attemptLog = [
    ...normalizeAttemptLog(previousState?.attemptLog ?? []),
    ...collectAttemptLogEntries(report, attemptFilter, currentAttemptRunId),
  ];
  const trackedKeys = new Set(previousTargets.keys());

  for (const [key, target] of currentTargets) {
    if (target.pass > 0 || trackedKeys.has(key)) {
      trackedKeys.add(key);
    }
  }

  const targets = [...trackedKeys]
    .map((key) => {
      const previousTarget = previousTargets.get(key);
      const currentTarget = currentTargets.get(key);

      if (!currentTarget) {
        return previousTarget!;
      }

      const baseTarget = canonical || !previousTarget ? currentTarget : previousTarget;
      const previousSubtests = new Map(
        previousTarget?.subtests.map((subtest) => [subtest.name, subtest]) ?? [],
      );
      const baseSubtests = new Map(
        baseTarget.subtests.map((subtest) => [subtest.name, subtest]),
      );

      const mergedSubtestNames = new Set(
        currentTarget.subtests.length > 0
          ? currentTarget.subtests.map((subtest) => subtest.name)
          : baseSubtests.keys(),
      );
      const subtests: WptProgressSubtestState[] = [];
      for (const name of mergedSubtestNames) {
          const currentSubtest = currentTarget.subtests.find(
            (subtest) => subtest.name === name,
          );
          const previousSubtest = previousSubtests.get(name);
          const baseSubtest = baseSubtests.get(name);
          const latestStatus = currentSubtest?.latestStatus ?? baseSubtest?.latestStatus;
          if (!latestStatus) {
            continue;
          }

          const failedAttempts = countAttempts(attemptLog, key, name);
          const excluded = failedAttempts > 3;

          subtests.push({
            excluded,
            exclusionReason: excluded
              ? `Excluded after ${failedAttempts} failed implementation attempts.`
              : undefined,
            failedAttempts,
            lastError: completeLastError(
              currentSubtest?.lastError ??
                previousSubtest?.lastError ??
                baseSubtest?.lastError,
              latestStatus,
            ),
            latestStatus,
            name,
          });
        }

      const effectiveSubtests = subtests.filter((subtest) => !subtest.excluded);
      const effectivePass = effectiveSubtests.filter(
        (subtest) => subtest.latestStatus === "PASS",
      ).length;
      const effectiveTotal = effectiveSubtests.length;
      const status: WptProgressTargetStatus =
        effectiveTotal === 0
          ? "excluded"
          : effectivePass === effectiveTotal
            ? "done"
            : "active";

      return {
        ...baseTarget,
        effectivePass,
        effectiveTotal,
        excludedSubtests: subtests.length - effectiveTotal,
        status,
        subtests,
        successRate:
          effectiveTotal === 0
            ? 100
            : Number(((effectivePass / effectiveTotal) * 100).toFixed(1)),
      };
    })
    .sort((left, right) => {
      return (
        statusOrder(left.status) - statusOrder(right.status) ||
        left.successRate - right.successRate ||
        left.file.localeCompare(right.file) ||
        left.variant.localeCompare(right.variant)
      );
    });

  const nextState: WptProgressState = {
    attemptLog,
    attemptRuns: previousAttemptRuns + (attemptFilter ? 1 : 0),
    generatedAt: canonical ? report.generatedAt : previousState?.generatedAt ?? report.generatedAt,
    targets,
  };

  if (
    canonical &&
    previousState &&
    hasSameProgressContent(previousState, nextState)
  ) {
    return {
      ...nextState,
      generatedAt: previousState.generatedAt,
    };
  }

  return nextState;
}

export function formatWptProgressMarkdown(state: WptProgressState) {
  const excludedTargets = state.targets
    .map((target) => ({
      ...target,
      excludedSubtests: target.subtests.filter((subtest) => subtest.excluded),
    }))
    .filter((target) => target.excludedSubtests.length > 0);
  const lines = [
    "# WPT partial-pass progress",
    "",
    `| Generated at | ${state.generatedAt} |`,
    "",
    "## Target success rates",
    "",
    "| File | Variant | PASS | FAIL | TIMEOUT | TOTAL | Excluded | Effective PASS/TOTAL | Success rate | Status |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...state.targets.map(
      (target) =>
        `| ${target.file} | ${target.variant || "(default)"} | ${target.pass} | ${target.fail} | ${target.timeout} | ${target.total} | ${target.excludedSubtests} | ${target.effectivePass}/${target.effectiveTotal} | ${target.successRate.toFixed(1)}% | ${target.status} |`,
    ),
    "",
    "## Excluded test cases",
    "",
    ...(excludedTargets.length > 0
      ? excludedTargets.flatMap((target) => [
          `### ${target.file} ${target.variant || "(default)"}`,
          "",
          "| Test case | Latest | Failed attempts | Exclusion reason | Last error |",
          "| --- | --- | ---: | --- | --- |",
          ...target.excludedSubtests.map(
            (subtest) =>
              `| ${escapeCell(subtest.name)} | ${subtest.latestStatus} | ${subtest.failedAttempts} | ${escapeCell(subtest.exclusionReason ?? "")} | ${subtest.lastError ? escapeCell(subtest.lastError) : ""} |`,
          ),
          "",
        ])
      : ["_No excluded test cases._"]),
  ];

  return `${lines.join("\n")}\n`;
}

export function formatWptProgressState(state: WptProgressState) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function parseWptProgressMarkdown(markdown: string) {
  const pattern = new RegExp(
    `${escapeForRegExp(progressStateStart)}\\n([\\s\\S]*?)\\n${escapeForRegExp(progressStateEnd)}`,
  );
  const match = markdown.match(pattern);
  if (!match) {
    return undefined;
  }

  return JSON.parse(match[1]) as WptProgressState;
}

export function parseWptProgressState(rawState: string) {
  return JSON.parse(rawState) as WptProgressState;
}

async function readExistingProgressState(statePath: string, progressPath: string) {
  try {
    return parseWptProgressState(await readFile(statePath, "utf8"));
  } catch {
    try {
      return parseWptProgressMarkdown(await readFile(progressPath, "utf8"));
    } catch {
      return undefined;
    }
  }
}

function summarizeResults(results: WptResultRecord[]) {
  const byTarget = new Map<
    string,
    {
      fail: number;
      file: string;
      pass: number;
      subtests: Array<Omit<WptProgressSubtestState, "excluded" | "failedAttempts">>;
      timeout: number;
      total: number;
      variant: string;
    }
  >();

  for (const result of results) {
    const key = targetKey(result);
    const target =
      byTarget.get(key) ??
      {
        fail: 0,
        file: result.file,
        pass: 0,
        subtests: [],
        timeout: 0,
        total: 0,
        variant: result.variant,
      };

    target.total += 1;
    if (result.status === "PASS") {
      target.pass += 1;
    } else if (result.status === "FAIL") {
      target.fail += 1;
    } else if (result.status === "TIMEOUT") {
      target.timeout += 1;
    }
    target.subtests.push({
      lastError: result.message,
      latestStatus: result.status,
      name: result.subtest,
    });
    byTarget.set(key, target);
  }

  return byTarget;
}

function summarizeProgressState(state: WptProgressState) {
  return state.targets.reduce(
    (summary, target) => {
      summary.targets += 1;
      summary.effectivePass += target.effectivePass;
      summary.effectiveTotal += target.effectiveTotal;
      summary.excludedSubtests += target.excludedSubtests;
      switch (target.status) {
        case "active":
          summary.activeTargets += 1;
          break;
        case "done":
          summary.doneTargets += 1;
          break;
        case "excluded":
          summary.excludedTargets += 1;
          break;
      }
      return summary;
    },
    {
      activeTargets: 0,
      doneTargets: 0,
      effectivePass: 0,
      effectiveTotal: 0,
      excludedSubtests: 0,
      excludedTargets: 0,
      targets: 0,
    },
  );
}

function isTrackedFailure(status: WptResultRecord["status"]) {
  return status === "FAIL" || status === "TIMEOUT";
}

function collectAttemptLogEntries(
  report: WptRunReport,
  attemptFilter: string | undefined,
  runId: string | undefined,
) {
  if (!attemptFilter || !runId) {
    return [];
  }

  return report.results
    .filter((result) => isTrackedFailure(result.status))
    .map((result) => ({
      file: result.file,
      filter: attemptFilter,
      latestError: completeLastError(result.message, result.status),
      latestStatus: result.status,
      runId,
      subtest: result.subtest,
      timestamp: report.generatedAt,
      variant: result.variant,
    }));
}

function countAttempts(
  attemptLog: WptProgressAttemptLogEntry[],
  key: string,
  subtestName: string,
) {
  return attemptLog.filter(
    (entry) =>
      targetKey(entry) === key &&
      entry.subtest === subtestName,
  ).length;
}

function countAttemptRuns(attemptLog: WptProgressAttemptLogEntry[]) {
  return new Set(
    attemptLog.map((entry) => entry.runId ?? `${entry.timestamp}::${entry.filter}`),
  ).size;
}

function normalizeAttemptLog(attemptLog: WptProgressAttemptLogEntry[]) {
  return attemptLog
    .filter((entry) => isScopedAttemptFilter(entry.filter))
    .map((entry) => ({
      ...entry,
      runId: entry.runId ?? `${entry.timestamp}::${entry.filter}`,
    }));
}

function hasSameProgressContent(
  previousState: WptProgressState,
  nextState: WptProgressState,
) {
  return (
    previousState.attemptRuns === nextState.attemptRuns &&
    JSON.stringify(previousState.attemptLog) === JSON.stringify(nextState.attemptLog) &&
    JSON.stringify(previousState.targets) === JSON.stringify(nextState.targets)
  );
}

function statusOrder(status: WptProgressTargetStatus) {
  switch (status) {
    case "active":
      return 0;
    case "done":
      return 1;
    case "excluded":
      return 2;
  }
}

function targetKey(target: Pick<WptResultRecord, "file" | "variant">) {
  return `${target.file}::${target.variant}`;
}

function escapeCell(value: string) {
  return value.replaceAll("|", "\\|");
}

function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCanonicalProgressRun() {
  return !process.env.WPT_TARGET_FILTER && !process.env.WPT_TARGET_JSON;
}

function resolveBuildOptions() {
  const canonical = isCanonicalProgressRun();
  const rawAttemptFilter = canonical
    ? undefined
    : process.env.WPT_TARGET_FILTER ?? process.env.WPT_TARGET_JSON ?? "(manual rerun)";
  return {
    attemptFilter: sanitizeAttemptFilter(rawAttemptFilter),
    canonical,
  };
}

function sanitizeAttemptFilter(filter: string | undefined) {
  if (!filter) {
    return undefined;
  }
  return isScopedAttemptFilter(filter) ? filter : undefined;
}

function isScopedAttemptFilter(filter: string) {
  const normalized = filter.trim();
  return (
    normalized.startsWith("{") ||
    normalized.includes(".html") ||
    normalized.includes(".https.html")
  );
}

function completeLastError(
  lastError: string | undefined,
  status: WptResultRecord["status"],
) {
  if (lastError) {
    return lastError;
  }
  switch (status) {
    case "FAIL":
      return "No detailed failure message was captured for the latest FAIL result.";
    case "TIMEOUT":
      return "No detailed timeout message was captured for the latest TIMEOUT result.";
    case "SKIP":
      return "No detailed skip message was captured for the latest SKIP result.";
    default:
      return undefined;
  }
}
