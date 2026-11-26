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

/**
 * The message of `error` as the statistical assertion, without the marker, or
 * undefined when it is not one. Only a failed `expect` counts: an
 * `AssertionError` reported for a test (no `type`, which vitest sets on an
 * error outside the tests) without a cause or aggregated errors, so an
 * operation that throws an `Error` with the marker's text, or an assertion
 * failing because something else failed, stays a normal failure. The rest of
 * the message (without the marker) must match the shard's `verdict` (the whole
 * message of its one statistical assertion) whole; without a `verdict` no
 * error is statistical, so a shard marked statistical but not saying which
 * assertion is its verdict hides nothing. A revision from before the marker
 * writes the same assertion without it: an unmarked message counts when it
 * matches `verdict` whole, for the form compared with a baseline only
 * (`isStatisticalError` needs the marker).
 */
export function statisticalMessage(
  error: ReportedError,
  verdict: RegExp | undefined,
) {
  const { name, type, cause, errors, message } = error;
  if (
    !verdict ||
    name !== "AssertionError" ||
    type ||
    cause ||
    errors ||
    !message
  ) {
    return undefined;
  }
  const rest = message.startsWith(STATISTICAL_FAILURE_MARKER)
    ? message.slice(STATISTICAL_FAILURE_MARKER.length).trimStart()
    : message;
  return verdict.test(rest) ? rest : undefined;
}

/**
 * Whether `error` is a statistical assertion of this revision: one with the
 * marker that `statisticalMessage` accepts (with the shard's `verdict`).
 */
export const isStatisticalError = (
  error: ReportedError,
  verdict: RegExp | undefined,
) =>
  (error.message?.startsWith(STATISTICAL_FAILURE_MARKER) ?? false) &&
  statisticalMessage(error, verdict) !== undefined;

/** Every number of a statistical message in order: the default `excess` of `statisticalExcess`. */
export const messageNumbers = (message: string) =>
  (message.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

/**
 * How far the statistical assertions among the errors of a failed test went
 * past their thresholds: `excess` of each `statisticalMessage`, joined in
 * order (larger is worse); undefined when none is one. The form
 * (`failureSignature`) replaces their numbers by `<n>`, so a baseline failing
 * the same check is the same failure only when it went at least as far
 * (`sameFailure`): a slope of 16.01 KiB/cycle on the baseline does not cover
 * 400 KiB/cycle here. A message `excess` cannot read gives `NaN`, which no
 * comparison passes, so it is never hidden.
 */
export function statisticalExcess(
  errors: ReportedError[],
  verdict?: RegExp,
  excess: (message: string) => number[] | undefined = messageNumbers,
) {
  const values: number[] = [];
  for (const error of errors) {
    const message = statisticalMessage(error, verdict);
    if (message === undefined) continue;
    const value = excess(message);
    values.push(
      ...(value?.length && value.every(Number.isFinite) ? value : [NaN]),
    );
  }
  return values.length > 0 ? values : undefined;
}

/**
 * Everything that identifies the cause of `error`: its kind, name, whole
 * message, expected and actual values, the file and source line it was thrown
 * at, and the same of its causes. Only what differs between two runs of one
 * cause is removed: ANSI colors, the worktree root (`<root>`), line and column
 * numbers and durations in milliseconds. A statistical error
 * (`statisticalMessage` with the shard's `verdict`, also for a revision from
 * before the marker) loses the marker and has every number replaced by `<n>`
 * (a heap slope of 16.01 and of 16.20 KiB/cycle are the same check failing),
 * so both revisions give one form; how far it failed is compared apart
 * (`statisticalExcess`). Undefined when the error, or one of its causes, has
 * no message: such a cause cannot be compared.
 */
export function failureSignature(
  error: ReportedError,
  root: string,
  verdict?: RegExp,
): string | undefined {
  return signatureOf(error, root, verdict, true);
}

/** `failureSignature`; only the error itself (`top`), not a cause, can be the statistical assertion. */
function signatureOf(
  error: ReportedError,
  root: string,
  verdict: RegExp | undefined,
  top: boolean,
): string | undefined {
  if (!error.message?.trim()) return undefined;
  const statistical = top ? statisticalMessage(error, verdict) : undefined;
  const lines = [
    `${error.type ? `${error.type}: ` : ""}${error.name ?? "Error"}: ${statistical ?? error.message}`,
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
    const signature = signatureOf(nested, root, undefined, false);
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
  return statistical === undefined
    ? signature
    : signature.replace(/\d+(?:\.\d+)?/g, "<n>");
}

/** The signature of all errors of a failed test; undefined when one cannot be compared or there is none. */
export function testSignature(
  errors: ReportedError[],
  root: string,
  verdict?: RegExp,
) {
  const signatures = errors.map((error) =>
    failureSignature(error, root, verdict),
  );
  if (signatures.length === 0 || signatures.includes(undefined)) {
    return undefined;
  }
  return signatures.join("\n---\n");
}
