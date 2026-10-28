/** Return whether a deterministic periodic debug burst is active at `nowMs`. */
export function isWithinBurstLossWindow(
  nowMs: number,
  everyMs: number | undefined,
  durationMs: number | undefined,
) {
  return (
    !!everyMs &&
    !!durationMs &&
    everyMs > 0 &&
    durationMs > 0 &&
    nowMs % everyMs < Math.min(durationMs, everyMs)
  );
}
