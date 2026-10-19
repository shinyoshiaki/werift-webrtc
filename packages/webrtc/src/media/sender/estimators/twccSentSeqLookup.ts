/** 16-bit transport-wide sequence modulus. */
export const TWCC_SEQ_MOD = 0x10000;

/**
 * Map a 16-bit TWCC feedback sequence onto an unwrapped sentInfos key.
 * Tries the newest generation first (latest send on this estimator).
 *
 * Shared by every estimator that keys sent packets by the extended
 * transport-wide sequence (legacy and GCC).
 */
export function lookupUnwrappedSentSeq(
  seq16: number,
  latestExtended: number | undefined,
  isCandidate: (key: number) => boolean,
): number | undefined {
  const s = seq16 & 0xffff;
  if (latestExtended === undefined) {
    return isCandidate(s) ? s : undefined;
  }
  const maxGen = Math.floor(latestExtended / TWCC_SEQ_MOD);
  for (let gen = maxGen; gen >= 0 && maxGen - gen < 8; gen--) {
    const key = gen * TWCC_SEQ_MOD + s;
    if (isCandidate(key)) return key;
  }
  return undefined;
}
