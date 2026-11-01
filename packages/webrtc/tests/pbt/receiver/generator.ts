import type { SeededRandom } from "../shared/random";

/**
 * Generators of the RTP receiver property test (`receiverProperty.test.ts`).
 * Every value is drawn from the seed's stream.
 */

/** One received RTP packet; `ext` is the sender's extended sequence number. */
export interface ReceivedStep {
  kind: "media" | "padding";
  ext: number;
}

/** Extended start often just below a 16-bit wrap so most seeds cross it. */
function startExt(rng: SeededRandom) {
  return rng.chance(0.5) ? 0x10000 - rng.int(1, 64) : rng.int(0, 0x10000);
}

/**
 * `length` sequence numbers of media and probe padding (padding in bursts)
 * with real media losses. With `reorder`, packets also arrive locally out of
 * order and some are duplicated, so padding can arrive after later media.
 */
export function randomMediaPaddingStream(
  rng: SeededRandom,
  length: number,
  { reorder }: { reorder: boolean },
): ReceivedStep[] {
  const steps: ReceivedStep[] = [];
  let ext = startExt(rng);
  let paddingBurst = 0;
  for (let i = 0; i < length; i++, ext++) {
    if (paddingBurst === 0 && rng.chance(0.08)) {
      paddingBurst = rng.int(1, 9);
    }
    if (paddingBurst > 0) {
      paddingBurst--;
      steps.push({ kind: "padding", ext });
    } else if (!rng.chance(0.1)) {
      steps.push({ kind: "media", ext });
    }
  }
  if (!reorder) return steps;
  for (let i = 0; i + 1 < steps.length; i++) {
    if (rng.chance(0.15)) {
      const j = Math.min(steps.length - 1, i + rng.int(1, 4));
      [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    }
  }
  for (let i = steps.length - 1; i >= 0; i--) {
    if (rng.chance(0.05)) steps.splice(i, 0, { ...steps[i]! });
  }
  return steps;
}

/** Transport-wide sequence numbers received in order, plus feedback timing. */
export interface TwccArrival {
  ext: number;
  /** Force a feedback right after this packet (the 100ms timer firing). */
  flush: boolean;
}

/**
 * `length` transport-wide sequence numbers with random losses (short and
 * long gaps), received in order across the 16-bit wrap, with feedback forced
 * at random points.
 */
export function randomTwccArrivals(
  rng: SeededRandom,
  length: number,
): TwccArrival[] {
  const arrivals: TwccArrival[] = [];
  let ext = startExt(rng);
  for (let i = 0; i < length; i++) {
    ext += rng.chance(0.15) ? rng.int(2, rng.chance(0.2) ? 40 : 5) : 1;
    arrivals.push({ ext, flush: rng.chance(0.1) });
  }
  return arrivals;
}
