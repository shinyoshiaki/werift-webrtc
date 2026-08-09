import { uint16Gt } from "../../../../imports/common";

/** 16-bit transport-wide sequence modulus. */
export const TWCC_SEQ_MOD = 0x10000;

/**
 * Compare two transport-wide sequence numbers with wrap-around awareness.
 * @returns negative if a is before b, positive if a is after b, 0 if equal.
 */
export function compareTransportWideSeq(a: number, b: number): number {
  const a16 = a & 0xffff;
  const b16 = b & 0xffff;
  if (a16 === b16) return 0;
  return uint16Gt(a16, b16) ? 1 : -1;
}

/**
 * Sort TWCC packet results into send-order with wrap-around safety.
 *
 * Chooses the origin that minimises the covered span (largest gap between
 * consecutive sequences, including wrap), so a window like
 * `{0, 1, 65534, 65535}` sorts as `65534, 65535, 0, 1` rather than numeric order.
 */
export function sortPacketResultsByWideSeq<
  T extends { sequenceNumber: number },
>(results: T[]): T[] {
  if (results.length <= 1) return [...results];

  const unique = [
    ...new Set(results.map((r) => r.sequenceNumber & 0xffff)),
  ].sort((a, b) => a - b);

  // Largest gap between consecutive unique seqs (circular) → base is after that gap.
  let maxGap = -1;
  let origin = unique[0];
  for (let i = 0; i < unique.length; i++) {
    const a = unique[i];
    const b = unique[(i + 1) % unique.length];
    const gap =
      i === unique.length - 1 ? b + TWCC_SEQ_MOD - a : b - a;
    if (gap > maxGap) {
      maxGap = gap;
      origin = b;
    }
  }

  return [...results].sort((a, b) => {
    const da =
      ((a.sequenceNumber & 0xffff) - origin + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
    const db =
      ((b.sequenceNumber & 0xffff) - origin + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
    return da - db;
  });
}

/**
 * True if `seq` is strictly older than `ref` within half the sequence space
 * (same half-mod convention as {@link uint16Gt}).
 */
export function isOlderTransportWideSeq(seq: number, ref: number): boolean {
  return compareTransportWideSeq(seq, ref) < 0;
}
