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
