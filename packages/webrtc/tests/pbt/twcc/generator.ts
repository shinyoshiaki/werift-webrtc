import type { SentInfo } from "../../../src";
import { twccSentInfo } from "../../media/twccTestUtils";
import type { SeededRandom } from "../shared/random";

/**
 * Generators of the TWCC property test (`twccProperty.test.ts`). Every value
 * is drawn from the seed's stream, so a seed replays the same input.
 */

/**
 * A contiguous TWCC window: starts near a 16-bit wrap about half of the time;
 * receive times mostly advance (small / large deltas) with occasional
 * reordering and losses. `recvUs[i]` is the receive time of `base16 + i` (µs)
 * or `undefined` for lost.
 */
export function randomTwccWindow(rng: SeededRandom): {
  base16: number;
  recvUs: (number | undefined)[];
} {
  const length = rng.int(1, 121);
  const base16 = rng.chance(0.5)
    ? (0x10000 - rng.int(0, length)) & 0xffff
    : rng.int(0, 0x10000);
  let tUs = 1_000_000 + rng.int(0, 60_000_000);
  const recvUs = Array.from({ length }, () => {
    if (rng.chance(0.2)) return undefined;
    const r = rng.next();
    // small delta (0–63ms), large forward gap (up to 2s), or reorder (−20ms)
    const stepUs =
      r < 0.8
        ? rng.int(0, 63_000)
        : r < 0.9
          ? 64_000 + rng.int(0, 2_000_000)
          : -rng.int(0, 20_000);
    tUs = Math.max(0, tUs + stepUs);
    return tUs;
  });
  return { base16, recvUs };
}

/** One operation on an estimator's send history. */
export type HistoryOp = {
  type: "send" | "process";
  atMs: number;
  seq16: number;
};

/**
 * `count` send / process operations with non-decreasing times (dense bursts
 * and rare multi-second idle gaps) and 16-bit TSNs that wrap and skip by up
 * to 5,000 (other BUNDLE senders), so both the time window and the 32768
 * sequence-span cap bound the history.
 */
export function randomHistoryOps(
  rng: SeededRandom,
  count: number,
  withProcess: boolean,
): HistoryOp[] {
  const ops: HistoryOp[] = [];
  let atMs = 1_000;
  let seq = rng.int(0, 0x10000);
  for (let i = 0; i < count; i++) {
    atMs += rng.chance(0.98) ? rng.int(0, 10) : rng.int(0, 15_000);
    if (withProcess && rng.chance(0.2)) {
      ops.push({ type: "process", atMs, seq16: seq });
      continue;
    }
    seq = (seq + 1 + (rng.chance(0.1) ? rng.int(0, 5_000) : 0)) & 0xffff;
    ops.push({ type: "send", atMs, seq16: seq });
  }
  return ops;
}

/**
 * True 24-bit `reference_time` units (64ms each): starts just below a wrap,
 * hovers around it with small forward / backward steps (reordered feedback),
 * and sometimes jumps forward by up to about an hour.
 */
export function randomReferenceTimes(
  rng: SeededRandom,
  mod: number,
  count: number,
): number[] {
  let units = mod * rng.int(1, 4) - rng.int(0, 100);
  const out = [units];
  for (let i = 0; i < count; i++) {
    const r = rng.next();
    units +=
      r < 0.6 ? rng.int(0, 60) : r < 0.9 ? -rng.int(0, 60) : rng.int(0, 60_000);
    out.push(units);
  }
  return out;
}

/** One TWCC feedback window over extended sequences. */
export type FeedbackWindow = {
  baseExt: number;
  recvUs: (number | undefined)[];
};

/**
 * A transport where this sender owns only some TSNs (other BUNDLE senders
 * fill the rest) and the receiver's contiguous feedback windows arrive
 * duplicated, delayed (reordered), or as corrective re-reports in which some
 * earlier losses are now received.
 */
export function randomTransport(rng: SeededRandom, packets: number) {
  // Start just below a 16-bit wrap so every run crosses at least one wrap.
  const startExt = 0x10000 - 200 - rng.int(0, 500);
  const totalPackets = packets + rng.int(0, Math.ceil((packets * 2) / 3));
  const owned = new Map<number, SentInfo>();
  const recvUsByExt = new Map<number, number>();
  for (let i = 0; i < totalPackets; i++) {
    const ext = startExt + i;
    const sendMs = 1_000 + i;
    if (rng.chance(0.6)) {
      owned.set(ext, twccSentInfo(ext, 100 + (i % 50), sendMs));
    }
    if (!rng.chance(0.1)) {
      recvUsByExt.set(ext, (sendMs + 20) * 1000 + rng.int(0, 900));
    }
  }

  const windows: FeedbackWindow[] = [];
  for (let base = startExt; base < startExt + totalPackets; ) {
    const n = Math.min(rng.int(1, 41), startExt + totalPackets - base);
    windows.push({
      baseExt: base,
      recvUs: Array.from({ length: n }, (_, i) => recvUsByExt.get(base + i)),
    });
    base += n;
  }

  const deliveries: FeedbackWindow[] = [];
  const delayed: FeedbackWindow[] = [];
  for (const w of windows) {
    deliveries.push(w);
    const r = rng.next();
    if (r < 0.1) deliveries.push(w);
    else if (r < 0.2) delayed.push(w);
    else if (r < 0.3) {
      delayed.push({
        baseExt: w.baseExt,
        recvUs: w.recvUs.map(
          (us, i) => us ?? (rng.chance(0.5) ? (1_000 + i) * 1000 : undefined),
        ),
      });
    }
    if (delayed.length > 0 && rng.chance(0.3)) {
      deliveries.push(delayed.shift()!);
    }
  }
  deliveries.push(...delayed);
  return { owned, deliveries };
}
