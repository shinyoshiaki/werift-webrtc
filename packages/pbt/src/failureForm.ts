/** The form of a failure that `pbt:deep --baseline` compares between two revisions. */

/**
 * The start of the message of a statistical assertion (a threshold on a
 * measured value). In a shard marked `statistical`, only a failure whose
 * errors all start with it is treated as statistical:
 * `expect(leaked, `${STATISTICAL_FAILURE_MARKER} ${reason}`)`.
 */
export const STATISTICAL_FAILURE_MARKER = "[pbt:statistical]";

/** An error as `deepReporter.mjs` writes it. */
export type ReportedError = {
  /** vitest's kind of an unhandled error (e.g. "Unhandled Rejection"). */
  type?: string;
  name?: string;
  message?: string;
  expected?: string;
  actual?: string;
  /** The first stack frame in the project and its source line (the failing assertion or throw). */
  at?: { file: string; source?: string };
  cause?: ReportedError;
  /** The errors of an `AggregateError`. */
  errors?: ReportedError[];
};

export const isStatisticalError = (error: ReportedError) =>
  error.message?.startsWith(STATISTICAL_FAILURE_MARKER) ?? false;

/**
 * Everything that identifies the cause of `error`: its kind, name, whole
 * message, expected and actual values, the file and source line it was thrown
 * at, and the same of its causes. Only what differs between two runs of one
 * cause is removed: ANSI colors, the worktree root (`<root>`), line and column
 * numbers and durations in milliseconds. A statistical error also has every
 * number replaced by `<n>` (a heap slope of 16.01 and of 16.20 KiB/cycle are
 * the same check failing). Undefined when the error, or one of its causes,
 * has no message: such a cause cannot be compared.
 */
export function failureSignature(
  error: ReportedError,
  root: string,
): string | undefined {
  if (!error.message?.trim()) return undefined;
  const lines = [
    `${error.type ? `${error.type}: ` : ""}${error.name ?? "Error"}: ${error.message}`,
    ...(error.expected === undefined ? [] : [`expected: ${error.expected}`]),
    ...(error.actual === undefined ? [] : [`actual: ${error.actual}`]),
    ...(error.at
      ? [`at: ${error.at.file}${error.at.source ? `: ${error.at.source}` : ""}`]
      : []),
  ];
  for (const [label, nested] of [
    ...(error.cause ? [["caused by", error.cause] as const] : []),
    ...(error.errors ?? []).map((e) => ["aggregated", e] as const),
  ]) {
    const signature = failureSignature(nested, root);
    if (signature === undefined) return undefined;
    lines.push(`${label}: ${signature}`);
  }
  const signature = lines
    .join("\n")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI color codes
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replaceAll(`file://${root}`, "<root>")
    .replaceAll(root, "<root>")
    .replace(/(\.[cm]?[jt]sx?):\d+:\d+/g, "$1:<n>:<n>")
    .replace(/\d+(?:\.\d+)?(?= ?ms\b)/g, "<n>");
  return isStatisticalError(error)
    ? signature.replace(/\d+(?:\.\d+)?/g, "<n>")
    : signature;
}

/** The signature of all errors of a failed test; undefined when one cannot be compared or there is none. */
export function testSignature(errors: ReportedError[], root: string) {
  const signatures = errors.map((error) => failureSignature(error, root));
  if (signatures.length === 0 || signatures.includes(undefined)) {
    return undefined;
  }
  return signatures.join("\n---\n");
}
