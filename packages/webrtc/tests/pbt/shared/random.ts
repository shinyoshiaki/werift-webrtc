/**
 * Shared by every property test of tests/pbt: the seeded random stream a
 * seed replays exactly. Changing it changes the operations of every seed.
 */
/** Deterministic PRNG (mulberry32) so a failing seed replays exactly. */
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)],
  };
}
export type SeededRandom = ReturnType<typeof seededRandom>;
