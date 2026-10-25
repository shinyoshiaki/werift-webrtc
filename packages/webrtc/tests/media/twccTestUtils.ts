import { vi } from "vitest";
import {
  type BandwidthEstimator,
  type GccBandwidthEstimator,
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpSender,
  RtpHeader,
  type SentInfo,
  type TwccFeedbackAdapter,
  type TwccPacketFeedback,
} from "../../src";
import { RTP_EXTENSION_URI } from "../../src/imports/rtp";
import {
  PacketResult,
  PacketStatus,
  RecvDelta,
  RtcpPacketConverter,
  RtcpTransportLayerFeedback,
  RunLengthChunk,
  TransportWideCC,
} from "../../src/imports/rtp";
import { createDtlsTransport } from "../fixture";

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

/** pin OnNetworkAvailability(true) then first ProcessInterval SetBitrates. */
export function startGccProbing(gcc: GccBandwidthEstimator, nowMs?: number) {
  gcc.setNetworkAvailable(true);
  // 合成 clock の GCC では Date.now() を使わない（ALR origin が壁時計になる）。
  gcc.process(nowMs ?? (gcc as unknown as { clock: () => number }).clock());
}

/**
 * 3x/6x を開始するが、RTCRtpSender の onProbeClusterConfig 自動 padding は抑止する。
 * sendRtp 後の注入や maybeInjectProbePadding 自体を検証するテスト用。
 */
export function startGccProbingWithoutSenderPadding(
  sender: RTCRtpSender,
  gcc: GccBandwidthEstimator,
  nowMs?: number,
) {
  const spy = vi.spyOn(sender, "maybeInjectProbePadding").mockResolvedValue(0);
  try {
    startGccProbing(gcc, nowMs);
  } finally {
    spy.mockRestore();
  }
}

/**
 * Connected video sender with VP8 + TWCC. RTX (PT 97) is negotiated by
 * default because probe / loss padding is only sent on the RTX SSRC.
 */
export async function prepareConnectedSender(
  estimator?: BandwidthEstimator,
  { rtx = true }: { rtx?: boolean } = {},
) {
  const sender = new RTCRtpSender("video");
  const dtls = createDtlsTransport();
  (dtls as { state: string }).state = "connected";
  const sentPackets: { header: RtpHeader; payload: Buffer; size: number }[] =
    [];
  dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
    // payload already includes RFC 3550 padding bytes when P=1.
    const size = payload.length + header.serializeSize;
    // Snapshot header fields — the same object is mutated across sends.
    sentPackets.push({
      header: new RtpHeader({ ...header, extensions: [...header.extensions] }),
      payload: Buffer.from(payload),
      size,
    });
    return size;
  }) as typeof dtls.sendRtp;
  dtls.transportSequenceNumber = 0;
  dtls.transportSequenceNumberExtended = 0;
  sender.setDtlsTransport(dtls);
  if (estimator) {
    sender.setBandwidthEstimator(estimator);
  }
  sender.prepareSend({
    codecs: [
      new RTCRtpCodecParameters({
        mimeType: "video/VP8",
        clockRate: 90000,
        payloadType: 96,
      }),
      ...(rtx
        ? [
            new RTCRtpCodecParameters({
              mimeType: "video/rtx",
              clockRate: 90000,
              payloadType: 97,
              parameters: "apt=96",
            }),
          ]
        : []),
    ],
    headerExtensions: [
      new RTCRtpHeaderExtensionParameters({
        id: 3,
        uri: RTP_EXTENSION_URI.transportWideCC,
      }),
    ],
    muxId: "0",
    rtcp: { cname: "test", mux: true },
  });
  return { sender, dtls, sentPackets };
}
