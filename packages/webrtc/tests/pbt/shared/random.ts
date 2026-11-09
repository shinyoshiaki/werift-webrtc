/**
 * Shared by every property test of tests/pbt: the seeded random stream a
 * seed replays exactly. Changing `next` changes the operations of every seed;
 * the helpers below only combine `next` and may be added freely.
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
    /** Real number in `[min, max)`. */
    between: (min: number, max: number) => min + next() * (max - min),
    /** Integer in `[min, max)`. */
    int: (min: number, max: number) => min + Math.floor(next() * (max - min)),
  };
}
export type SeededRandom = ReturnType<typeof seededRandom>;
