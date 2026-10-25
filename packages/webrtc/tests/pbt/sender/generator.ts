import type { SeededRandom } from "../shared/random";

/**
 * Generators of the RTP sender property test (`senderProperty.test.ts`).
 * Every value is drawn from the seed's stream.
 */

/** One step of a forwarded media stream. */
export type ForwardStep =
  | {
      type: "media";
      /** Source RTP sequence number. */
      seq: number;
      payloadByte: number;
      /** Upstream padding-only packet forwarded on the media path. */
      forwardedPadding: boolean;
    }
  /** This sender's own padding burst (`count` packets). */
  | { type: "padding"; count: number }
  /** `replaceTrack` to a new source with its own sequence space. */
  | { type: "switch" };

/**
 * `length` steps of forwarded media with gaps, reorders, duplicates, and
 * upstream padding-only packets, interleaved with this sender's own padding
 * bursts and occasional track switches.
 */
export function randomForwardScript(
  rng: SeededRandom,
  length: number,
): ForwardStep[] {
  const steps: ForwardStep[] = [];
  let seq = rng.int(0, 0x10000);
  for (let i = 0; i < length; i++) {
    const r = rng.next();
    if (r < 0.02) {
      steps.push({ type: "switch" });
      seq = rng.int(0, 0x10000);
      continue;
    }
    if (r < 0.15) {
      steps.push({ type: "padding", count: rng.int(1, 5) });
      continue;
    }
    const jitter = rng.next();
    let s: number;
    if (jitter < 0.1) s = (seq - rng.int(1, 4)) & 0xffff;
    else if (jitter < 0.15) s = seq;
    else {
      seq = (seq + 1 + (rng.chance(0.15) ? rng.int(0, 4) : 0)) & 0xffff;
      s = seq;
    }
    steps.push({
      type: "media",
      seq: s,
      payloadByte: i & 0xff,
      forwardedPadding: rng.chance(0.1),
    });
  }
  return steps;
}
