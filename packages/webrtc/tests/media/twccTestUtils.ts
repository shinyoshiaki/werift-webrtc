import type {
  BandwidthEstimator,
  SentInfo,
  TwccFeedbackAdapter,
  TwccPacketFeedback,
} from "../../src";
import {
  PacketResult,
  PacketStatus,
  RecvDelta,
  RtcpPacketConverter,
  RtcpTransportLayerFeedback,
  RunLengthChunk,
  TransportWideCC,
} from "../../src/imports/rtp";

/** Arrange: SentInfo with matching send / sent times. */
export function twccSentInfo(
  wideSeq: number,
  size: number,
  sendingAtMs: number,
  opts?: Partial<SentInfo>,
): SentInfo {
  return { wideSeq, size, sendingAtMs, sentAtMs: sendingAtMs, ...opts };
}

/** Arrange: synthetic feedback that returns `results` as-is. */
export function syntheticTwccFeedback(
  results: PacketResult[],
  referenceTime = 0,
): TransportWideCC {
  const feedback = new TransportWideCC({
    senderSsrc: 1,
    mediaSourceSsrc: 2,
    baseSequenceNumber: results[0]?.sequenceNumber ?? 0,
    packetStatusCount: results.length,
    referenceTime,
    fbPktCount: 0,
  });
  Object.defineProperty(feedback, "packetResults", {
    get: () => results,
  });
  return feedback;
}

/**
 * Arrange: wire-accurate TWCC feedback for a contiguous 16-bit range.
 * `recvUs[i]` is the receive time (µs) of `base + i`, or `undefined` for lost.
 * Serialized and parsed again so 250µs delta quantization applies.
 */
export function wireTwccFeedback(
  base16: number,
  recvUs: (number | undefined)[],
  fbPktCount = 0,
): TransportWideCC {
  const firstUs = recvUs.find((v) => v !== undefined) ?? 0;
  const referenceTime = Math.floor(firstUs / 1000 / 64);
  let prevUs = referenceTime * 64 * 1000;
  const recvDeltas: RecvDelta[] = [];
  const statuses: PacketStatus[] = [];
  for (const us of recvUs) {
    if (us === undefined) {
      statuses.push(PacketStatus.TypeTCCPacketNotReceived);
      continue;
    }
    const delta = new RecvDelta({ delta: Math.round(us - prevUs) });
    delta.parseDelta();
    recvDeltas.push(delta);
    statuses.push(delta.type!);
    prevUs = us;
  }
  const packetChunks: RunLengthChunk[] = [];
  for (let i = 0; i < statuses.length; ) {
    let j = i;
    while (j < statuses.length && statuses[j] === statuses[i]) j++;
    packetChunks.push(
      new RunLengthChunk({ packetStatus: statuses[i], runLength: j - i }),
    );
    i = j;
  }
  const feedback = new TransportWideCC({
    senderSsrc: 1,
    mediaSourceSsrc: 2,
    baseSequenceNumber: base16 & 0xffff,
    packetStatusCount: recvUs.length,
    referenceTime,
    fbPktCount,
    recvDeltas,
    packetChunks,
  });
  const wire = new RtcpTransportLayerFeedback({ feedback }).serialize();
  const [rtpfb] = RtcpPacketConverter.deSerialize(wire) as [
    RtcpTransportLayerFeedback,
  ];
  return rtpfb.feedback as TransportWideCC;
}

/** Arrange: deterministic PRNG (mulberry32) for property-style tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Internal TWCC adapter of a legacy / GCC estimator. */
export function feedbackAdapterOf(e: BandwidthEstimator): TwccFeedbackAdapter {
  return (e as unknown as { feedbackAdapter: TwccFeedbackAdapter })
    .feedbackAdapter;
}

/** Send history still waiting for a received report (extended seq → info). */
export function twccHistoryOf(
  e: BandwidthEstimator | TwccFeedbackAdapter,
): Map<number, SentInfo> {
  const adapter =
    "onFeedback" in e ? e : feedbackAdapterOf(e as BandwidthEstimator);
  return (adapter as unknown as { history: Map<number, SentInfo> }).history;
}

/**
 * Record the normalized packets the adapter hands to the estimator, one
 * array per `receiveTWCC` call.
 */
export function captureMatchedFeedback(
  e: BandwidthEstimator,
): TwccPacketFeedback[][] {
  const adapter = feedbackAdapterOf(e);
  const calls: TwccPacketFeedback[][] = [];
  const original = adapter.onFeedback.bind(adapter);
  adapter.onFeedback = (feedback) => {
    const out = original(feedback);
    calls.push(out);
    return out;
  };
  return calls;
}

export { PacketResult };

/**
 * Arrange: a contiguous TWCC window for wire round-trip properties.
 * Starts near a 16-bit wrap about half of the time; receive times mostly
 * advance (small / large deltas) with occasional reordering and losses.
 * `recvUs[i]` is the receive time of `base16 + i` (µs) or `undefined`.
 */
export function randomTwccWindow(rand: () => number): {
  base16: number;
  recvUs: (number | undefined)[];
} {
  const length = 1 + Math.floor(rand() * 120);
  const base16 =
    rand() < 0.5
      ? (0x10000 - Math.floor(rand() * length)) & 0xffff
      : Math.floor(rand() * 0x10000);
  let tUs = 1_000_000 + Math.floor(rand() * 60_000_000);
  const recvUs = Array.from({ length }, () => {
    if (rand() < 0.2) return undefined;
    const r = rand();
    // small delta (0–63ms), large forward gap (up to 2s), or reorder (−20ms)
    const stepUs =
      r < 0.8
        ? Math.floor(rand() * 63_000)
        : r < 0.9
          ? 64_000 + Math.floor(rand() * 2_000_000)
          : -Math.floor(rand() * 20_000);
    tUs = Math.max(0, tUs + stepUs);
    return tUs;
  });
  return { base16, recvUs };
}

/** One step of a forwarded media stream for sender sequence properties. */
export type SourceSeqStep =
  | {
      type: "media";
      seq: number;
      payloadByte: number;
      /** Upstream padding-only packet forwarded on the media path. */
      forwardedPadding: boolean;
    }
  | { type: "padding"; count: number };

/**
 * Arrange: forwarded source media with gaps, reorders, duplicates, and
 * upstream padding-only packets, interleaved with this sender's own
 * probe-padding bursts.
 */
export function randomSourceSeqScript(
  rand: () => number,
  length: number,
): SourceSeqStep[] {
  const steps: SourceSeqStep[] = [];
  let seq = Math.floor(rand() * 0x10000);
  for (let i = 0; i < length; i++) {
    if (rand() < 0.2) {
      steps.push({ type: "padding", count: 1 + Math.floor(rand() * 4) });
      continue;
    }
    const r = rand();
    let s: number;
    if (r < 0.1) s = (seq - 1 - Math.floor(rand() * 3)) & 0xffff;
    else if (r < 0.15) s = seq;
    else {
      seq = (seq + 1 + (rand() < 0.15 ? Math.floor(rand() * 4) : 0)) & 0xffff;
      s = seq;
    }
    steps.push({
      type: "media",
      seq: s,
      payloadByte: i & 0xff,
      forwardedPadding: rand() < 0.1,
    });
  }
  return steps;
}

/** One operation on an estimator's send history. */
export type HistoryOp = {
  type: "send" | "process";
  atMs: number;
  seq16: number;
};

/**
 * Arrange: send / process operations with non-decreasing times (dense bursts
 * and rare multi-second idle gaps) and 16-bit TSNs that wrap and skip by up
 * to 5,000 (other BUNDLE senders), so both the time window and the 32768
 * sequence-span cap bound the history.
 */
export function randomHistoryOps(
  rand: () => number,
  count: number,
  withProcess: boolean,
): HistoryOp[] {
  const ops: HistoryOp[] = [];
  let atMs = 1_000;
  let seq = Math.floor(rand() * 0x10000);
  for (let i = 0; i < count; i++) {
    const r = rand();
    atMs += r < 0.98 ? Math.floor(rand() * 10) : Math.floor(rand() * 15_000);
    if (withProcess && rand() < 0.2) {
      ops.push({ type: "process", atMs, seq16: seq });
      continue;
    }
    seq = (seq + 1 + (rand() < 0.1 ? Math.floor(rand() * 5_000) : 0)) & 0xffff;
    ops.push({ type: "send", atMs, seq16: seq });
  }
  return ops;
}
