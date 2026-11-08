/**
 * Unwrap TWCC 24-bit `reference_time` (units of 64 ms) into a continuous
 * millisecond timeline across feedbacks.
 *
 * Without this, when reference_time wraps 0xFFFFFF → 0 the reconstructed
 * `receivedAtMs` jumps backward by ~12.4 days and acked-bitrate / trendline
 * windows break.
 *
 * @see draft-holmer-rmcat-transport-wide-cc-extensions reference_time field
 */

/** 24-bit field modulus. */
export const TWCC_REFERENCE_TIME_MOD = 1 << 24;

/** Each reference_time unit is 64 ms. */
export const TWCC_REFERENCE_TIME_UNIT_MS = 64;

/**
 * Tracks successive TWCC reference_time values and expands them to a
 * monotonic timeline (modulo unwrap).
 */
export class TwccReferenceTimeUnwrapper {
  private lastRefUnits: number | undefined;
  /** Completed wrap cycles (can be negative if time goes backward a lot). */
  private cycles = 0;

  reset() {
    this.lastRefUnits = undefined;
    this.cycles = 0;
  }

  /**
   * @param referenceTimeUnits 24-bit reference_time from a TWCC feedback
   * @returns Continuous base receive time in ms (unwrapped × 64)
   */
  unwrapBaseMs(referenceTimeUnits: number): number {
    const ref = referenceTimeUnits & (TWCC_REFERENCE_TIME_MOD - 1);
    if (this.lastRefUnits === undefined) {
      this.lastRefUnits = ref;
      return ref * TWCC_REFERENCE_TIME_UNIT_MS;
    }

    const half = TWCC_REFERENCE_TIME_MOD >> 1;
    const delta = ref - this.lastRefUnits;
    // Forward wrap: last near top, current near 0
    if (delta < -half) {
      this.cycles += 1;
    } else if (delta > half) {
      // Backward wrap (reordered feedbacks)
      this.cycles -= 1;
    }
    this.lastRefUnits = ref;
    return (
      (this.cycles * TWCC_REFERENCE_TIME_MOD + ref) *
      TWCC_REFERENCE_TIME_UNIT_MS
    );
  }

  /**
   * Re-base per-packet `receivedAtMs` produced by {@link TransportWideCC.packetResults}
   * (which uses the raw 24-bit reference_time × 64) onto the continuous timeline.
   *
   * @param results packet results from one feedback
   * @param referenceTimeUnits that feedback's reference_time
   * @returns new array with adjusted `receivedAtMs` (other fields shallow-copied)
   */
  rebasePacketResults<T extends { receivedAtMs: number; received: boolean }>(
    results: T[],
    referenceTimeUnits: number,
  ): T[] {
    const wrappedBase =
      (referenceTimeUnits & (TWCC_REFERENCE_TIME_MOD - 1)) *
      TWCC_REFERENCE_TIME_UNIT_MS;
    const continuousBase = this.unwrapBaseMs(referenceTimeUnits);
    const shift = continuousBase - wrappedBase;
    if (shift === 0) return results;
    return results.map((r) => {
      if (!r.received || !Number.isFinite(r.receivedAtMs)) return r;
      return { ...r, receivedAtMs: r.receivedAtMs + shift };
    });
  }
}
