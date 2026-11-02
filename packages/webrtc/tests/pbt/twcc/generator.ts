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
export type HistoryOp =
  | {
      type: "send";
      /** When the send confirmation (`rtpPacketSent`) arrives. */
      atMs: number;
      /** `SentInfo.sendingAtMs`: when the packet was sent. */
      sentAtMs: number;
      /** Extended transport-wide sequence number (as `RTCRtpSender` reports it). */
      seq: number;
    }
  | { type: "process"; atMs: number };

/**
 * `count` send / process operations with non-decreasing times (dense bursts
 * and rare multi-second idle gaps) and extended TSNs that cross 16-bit wraps
 * and skip by up to 5,000 (other BUNDLE senders), so both the time window and
 * the 32768 sequence-span cap bound the history. Some send confirmations
 * arrive late (concurrent sends completing out of order): usually a few
 * operations later, sometimes up to 60, which with the skips can put them
 * more than half the 16-bit space behind the newest TSN.
 */
export function randomHistoryOps(
  rng: SeededRandom,
  count: number,
  withProcess: boolean,
): HistoryOp[] {
  const ops: HistoryOp[] = [];
  const late: { due: number; seq: number; sentAtMs: number }[] = [];
  let atMs = 1_000;
  let seq = rng.int(0, 0x10000);
  for (let i = 0; i < count; i++) {
    atMs += rng.chance(0.98) ? rng.int(0, 10) : rng.int(0, 15_000);
    for (const l of late.filter((l) => l.due <= i)) {
      late.splice(late.indexOf(l), 1);
      ops.push({ type: "send", atMs, sentAtMs: l.sentAtMs, seq: l.seq });
    }
    if (withProcess && rng.chance(0.2)) {
      ops.push({ type: "process", atMs });
      continue;
    }
    seq += 1 + (rng.chance(0.1) ? rng.int(0, 5_000) : 0);
    if (rng.chance(0.05)) {
      const delay = rng.chance(0.2) ? rng.int(4, 61) : rng.int(1, 4);
      late.push({ due: i + delay, seq, sentAtMs: atMs });
    } else {
      ops.push({ type: "send", atMs, sentAtMs: atMs, seq });
    }
  }
  for (const l of late) {
    ops.push({ type: "send", atMs, sentAtMs: l.sentAtMs, seq: l.seq });
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
 * earlier losses are now received. `sendOrder` is the order of the send
 * confirmations (`rtpPacketSent`): concurrent sends complete locally out of
 * order, and about half of the runs swap the pair across the first 16-bit
 * wrap (extended 0xffff / 0x10000).
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

  const sendOrder = [...owned.values()];
  for (let i = 0; i + 1 < sendOrder.length; i++) {
    if (rng.chance(0.05)) {
      [sendOrder[i], sendOrder[i + 1]] = [sendOrder[i + 1]!, sendOrder[i]!];
    }
  }
  const wrapAt = sendOrder.findIndex((info) => info.wideSeq >= 0x10000);
  if (wrapAt > 0 && rng.chance(0.5)) {
    [sendOrder[wrapAt - 1], sendOrder[wrapAt]] = [
      sendOrder[wrapAt]!,
      sendOrder[wrapAt - 1]!,
    ];
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
  return { owned, sendOrder, deliveries };
}
