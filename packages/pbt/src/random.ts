/**
 * The seeded random stream every property test of werift draws from, so a
 * seed replays exactly. Changing `next` changes the inputs of every seed of
 * every package; the helpers below only combine `next` and may be added
 * freely.
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
    /** Real number in `[0, 1)`. */
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
