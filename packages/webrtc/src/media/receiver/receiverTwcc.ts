import { setTimeout } from "timers/promises";

import { uint8Add, uint24 } from "../../imports/common";
import {
  debug,
  PacketStatus,
  RecvDelta,
  RtcpTransportLayerFeedback,
  RunLengthChunk,
  type StatusVectorChunk,
  TransportWideCC,
} from "../../imports/rtp";
import type { RTCDtlsTransport } from "../../transport/dtls";
import { microTime } from "../../utils";

const log = debug("werift:packages/webrtc/media/receiver/receiverTwcc");

const TWCC_SEQ_MOD = 0x10000;
/** Reject feedback windows larger than half the sequence space. */
const MAX_FEEDBACK_SPAN = 0x7fff;
/** Wire RunLengthChunk.runLength is 13 bits → max 8191. */
const RUN_LENGTH_MAX = 8191;

type ExtensionInfo = { tsn: number; timestamp: bigint };

type SharedReceiverTWCC = {
  instance: ReceiverTWCC;
  refs: number;
};

/**
 * One {@link ReceiverTWCC} per DTLS transport. BUNDLE multiplexes audio/video
 * onto a shared transport-wide sequence; per-receiver generators would treat
 * the other stream's TSNs as PacketNotReceived.
 */
const receiverTwccByTransport = new WeakMap<
  RTCDtlsTransport,
  SharedReceiverTWCC
>();

/**
 * Return the transport-scoped TWCC generator, creating it on first use.
 * Each acquire must be matched by {@link releaseTransportReceiverTWCC}.
 */
export function acquireTransportReceiverTWCC(
  dtlsTransport: RTCDtlsTransport,
  rtcpSsrc: number,
  mediaSourceSsrc: number,
): ReceiverTWCC {
  const existing = receiverTwccByTransport.get(dtlsTransport);
  if (existing) {
    existing.refs++;
    existing.instance.setMediaSourceSsrc(mediaSourceSsrc);
    return existing.instance;
  }
  const instance = new ReceiverTWCC(dtlsTransport, rtcpSsrc, mediaSourceSsrc);
  receiverTwccByTransport.set(dtlsTransport, { instance, refs: 1 });
  return instance;
}

/**
 * Drop one holder of the transport-scoped generator. The periodic loop stops
 * when the last receiver on that DTLS transport releases.
 */
export function releaseTransportReceiverTWCC(
  dtlsTransport: RTCDtlsTransport,
  instance: ReceiverTWCC,
): void {
  const entry = receiverTwccByTransport.get(dtlsTransport);
  if (!entry || entry.instance !== instance) {
    return;
  }
  entry.refs--;
  if (entry.refs > 0) {
    return;
  }
  instance.twccRunning = false;
  receiverTwccByTransport.delete(dtlsTransport);
}

/**
 * Receiver-side TWCC feedback generator.
 *
 * One instance is shared per DTLS transport (see {@link acquireTransportReceiverTWCC})
 * so BUNDLE streams share a single transport-wide feedback window.
 *
 * Feedback triggers: every 100ms (periodic) or when >10 packets are buffered.
 * Status chunks cover the full transport-sequence span (including gaps as
 * PacketNotReceived), including losses that straddle feedback boundaries via
 * {@link nextReportTsn}. Stays a dumb receiver: a packet arriving after its
 * sequence was already reported is not re-reported (no corrective feedback).
 */
export class ReceiverTWCC {
  extensionInfo: {
    [tsn: number]: ExtensionInfo;
  } = {};
  /** Periodic 100ms loop runs while true (enabled in constructor). */
  twccRunning = true;
  /** uint8 */
  fbPktCount = 0;
  /**
   * Next transport sequence that should appear in feedback (wrap-aware).
   * When set, a feedback that receives only TSN N reports any missing
   * sequences from this cursor through N as PacketNotReceived.
   */
  nextReportTsn?: number;

  constructor(
    private dtlsTransport: RTCDtlsTransport,
    private rtcpSsrc: number,
    private mediaSourceSsrc: number,
  ) {
    this.runTWCC();
  }

  /**
   * libwebrtc RemoteEstimatorProxy puts the latest RTP SSRC into
   * `media_ssrc`; it does not mean that SSRC owns the TSN range.
   */
  setMediaSourceSsrc(mediaSourceSsrc: number) {
    this.mediaSourceSsrc = mediaSourceSsrc;
  }

  handleTWCC(transportSequenceNumber: number) {
    const tsn = transportSequenceNumber & 0xffff;
    const info: ExtensionInfo = {
      tsn,
      timestamp: microTime(),
    };
    this.extensionInfo[tsn] = info;

    if (Object.keys(this.extensionInfo).length > 10) {
      this.sendTWCC();
    }
  }

  private async runTWCC() {
    while (this.twccRunning) {
      this.sendTWCC();
      await setTimeout(100);
    }
  }

  private sendTWCC() {
    if (Object.keys(this.extensionInfo).length === 0) return;

    const pending = Object.values(this.extensionInfo).map(
      (e) => e.tsn & 0xffff,
    );
    const baseSequenceNumber = this.resolveBaseSequence(pending);
    if (baseSequenceNumber === undefined) {
      // Only already-reported sequences remain — drop pending buffer.
      this.extensionInfo = {};
      return;
    }

    // Latest pending packet at/after base. Late packets behind the base were
    // already reported (as not received) and are dropped.
    let maxOffset = -1;
    for (const tsn of pending) {
      const off = (tsn - baseSequenceNumber + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
      if (off < MAX_FEEDBACK_SPAN) {
        maxOffset = Math.max(maxOffset, off);
      }
    }
    if (maxOffset < 0) {
      this.extensionInfo = {};
      return;
    }

    const lastTsn = (baseSequenceNumber + maxOffset) & 0xffff;
    const packetStatusCount = maxOffset + 1;
    if (packetStatusCount > MAX_FEEDBACK_SPAN) {
      log(
        "TWCC span too large, packetStatusCount=%s base=%s last=%s",
        packetStatusCount,
        baseSequenceNumber,
        lastTsn,
      );
      this.extensionInfo = {};
      return;
    }

    const packetChunks: (RunLengthChunk | StatusVectorChunk)[] = [];
    const recvDeltas: RecvDelta[] = [];

    type StatusEntry = {
      received: boolean;
      status: PacketStatus;
    };
    const statuses: StatusEntry[] = [];

    const lookup = (seq: number): ExtensionInfo | undefined =>
      this.extensionInfo[seq];

    let firstRecvTimestamp: bigint | undefined;
    for (let offset = 0; offset < packetStatusCount; offset++) {
      const seq = (baseSequenceNumber + offset) & 0xffff;
      const info = lookup(seq);
      if (info && firstRecvTimestamp === undefined) {
        firstRecvTimestamp = info.timestamp;
      }
    }
    if (firstRecvTimestamp === undefined) {
      return;
    }

    // Wire reference_time is floor(ms / 64). Reconstruct that truncated base so
    // the first recv delta is relative to the same 64ms-quantized clock.
    const referenceTimeUnits = Math.floor(
      Number(firstRecvTimestamp / 1000n / 64n),
    );
    const referenceTimeUs =
      BigInt(referenceTimeUnits) * 64n * 1000n; /* microseconds */
    let prevRecvUs = referenceTimeUs;

    for (let offset = 0; offset < packetStatusCount; offset++) {
      const seq = (baseSequenceNumber + offset) & 0xffff;
      const info = lookup(seq);
      if (!info) {
        statuses.push({
          received: false,
          status: PacketStatus.TypeTCCPacketNotReceived,
        });
        continue;
      }

      const deltaUs = Number(info.timestamp - prevRecvUs);
      prevRecvUs = info.timestamp;

      const recvDelta = new RecvDelta({
        delta: deltaUs,
      });
      recvDelta.parseDelta();
      recvDeltas.push(recvDelta);

      statuses.push({
        received: true,
        status: recvDelta.type!,
      });
    }

    // Compress status series into RunLength chunks (split at 13-bit max).
    let runStatus = statuses[0].status;
    let runStart = 0;
    for (let i = 1; i <= statuses.length; i++) {
      const done = i === statuses.length;
      const status = done ? undefined : statuses[i].status;
      if (done || status !== runStatus) {
        pushRunLengthChunks(packetChunks, runStatus, i - runStart);
        if (!done) {
          runStatus = status!;
          runStart = i;
        }
      }
    }

    const packet = new RtcpTransportLayerFeedback({
      feedback: new TransportWideCC({
        senderSsrc: this.rtcpSsrc,
        mediaSourceSsrc: this.mediaSourceSsrc,
        baseSequenceNumber,
        packetStatusCount,
        referenceTime: uint24(referenceTimeUnits),
        fbPktCount: this.fbPktCount,
        recvDeltas,
        packetChunks,
      }),
    });

    this.dtlsTransport.sendRtcp([packet]).catch((err) => {
      log(err);
    });

    this.extensionInfo = {};
    // Advance the frontier only forward.
    this.advanceNextReportTsn((lastTsn + 1) & 0xffff);
    this.fbPktCount = uint8Add(this.fbPktCount, 1);
  }

  /**
   * Advance {@link nextReportTsn} only in the forward half of the sequence
   * space.
   */
  private advanceNextReportTsn(candidate: number) {
    const next = candidate & 0xffff;
    if (this.nextReportTsn === undefined) {
      this.nextReportTsn = next;
      return;
    }
    const advance = (next - this.nextReportTsn + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
    if (advance > 0 && advance < MAX_FEEDBACK_SPAN) {
      this.nextReportTsn = next;
    }
  }

  /**
   * Choose feedback base:
   * - If nextReportTsn is set, use it so losses since the previous feedback
   *   are reported as PacketNotReceived (needs a packet at/after it).
   * - Else (first feedback) use wrap-aware earliest among received.
   */
  private resolveBaseSequence(received: number[]): number | undefined {
    if (this.nextReportTsn !== undefined) {
      const frontier = this.nextReportTsn & 0xffff;
      const hasNew = received.some((tsn) => {
        const off = (tsn - frontier + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
        return off < MAX_FEEDBACK_SPAN;
      });
      return hasNew ? frontier : undefined;
    }

    // First feedback: largest circular gap → base after gap.
    const unique = [...new Set(received)].sort((a, b) => a - b);
    let maxGap = -1;
    let base = unique[0];
    for (let i = 0; i < unique.length; i++) {
      const a = unique[i];
      const b = unique[(i + 1) % unique.length];
      const gap = i === unique.length - 1 ? b + TWCC_SEQ_MOD - a : b - a;
      if (gap > maxGap) {
        maxGap = gap;
        base = b;
      }
    }
    return base;
  }
}

/** Split a run into one or more RunLengthChunk (max 8191 each). */
function pushRunLengthChunks(
  out: (RunLengthChunk | StatusVectorChunk)[],
  packetStatus: PacketStatus,
  runLength: number,
) {
  let remaining = runLength;
  while (remaining > 0) {
    const n = Math.min(remaining, RUN_LENGTH_MAX);
    out.push(
      new RunLengthChunk({
        packetStatus,
        runLength: n,
      }),
    );
    remaining -= n;
  }
}
