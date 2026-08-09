import { setTimeout } from "timers/promises";

import { uint8Add, uint24 } from "../../imports/common";
import {
  PacketStatus,
  RecvDelta,
  RtcpTransportLayerFeedback,
  RunLengthChunk,
  type StatusVectorChunk,
  TransportWideCC,
  debug,
} from "../../imports/rtp";
import type { RTCDtlsTransport } from "../../transport/dtls";
import { microTime } from "../../utils";

const log = debug("werift:packages/webrtc/media/receiver/receiverTwcc");

const TWCC_SEQ_MOD = 0x10000;
/** Reject feedback windows larger than half the sequence space. */
const MAX_FEEDBACK_SPAN = 0x7fff;

type ExtensionInfo = { tsn: number; timestamp: bigint };

/**
 * Receiver-side TWCC feedback generator.
 *
 * Feedback triggers: every 100ms (periodic) or when >10 packets are buffered.
 * Status chunks cover the full transport-sequence span (including gaps as
 * PacketNotReceived), including losses that straddle feedback boundaries via
 * {@link nextReportTsn}.
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

  handleTWCC(transportSequenceNumber: number) {
    const tsn = transportSequenceNumber & 0xffff;
    this.extensionInfo[tsn] = {
      tsn,
      timestamp: microTime(),
    };

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

    const received = Object.values(this.extensionInfo).map((e) => ({
      tsn: e.tsn & 0xffff,
      timestamp: e.timestamp,
    }));

    const baseSequenceNumber = this.resolveBaseSequence(received);
    if (baseSequenceNumber === undefined) {
      // Only already-reported sequences remain — drop them.
      this.extensionInfo = {};
      return;
    }

    // Latest received packet that is at/after base (wrap-aware forward half).
    let maxOffset = -1;
    for (const r of received) {
      const off = (r.tsn - baseSequenceNumber + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
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

    // Build full transport-sequence status series (received + not-received gaps).
    type StatusEntry = {
      received: boolean;
      status: PacketStatus;
    };
    const statuses: StatusEntry[] = [];

    // First received timestamp in this feedback (for reference_time).
    let firstRecvTimestamp: bigint | undefined;
    for (let offset = 0; offset < packetStatusCount; offset++) {
      const seq = (baseSequenceNumber + offset) & 0xffff;
      const info = this.extensionInfo[seq];
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
    /** Running clock for successive received packets (microseconds). */
    let prevRecvUs = referenceTimeUs;

    for (let offset = 0; offset < packetStatusCount; offset++) {
      const seq = (baseSequenceNumber + offset) & 0xffff;
      const info = this.extensionInfo[seq];
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

    // Compress status series into RunLength chunks.
    let runStatus = statuses[0].status;
    let runStart = 0;
    for (let i = 1; i <= statuses.length; i++) {
      const done = i === statuses.length;
      const status = done ? undefined : statuses[i].status;
      if (done || status !== runStatus) {
        packetChunks.push(
          new RunLengthChunk({
            packetStatus: runStatus,
            runLength: i - runStart,
          }),
        );
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
    // Next feedback must cover from the sequence after lastTsn (cross-boundary loss).
    this.nextReportTsn = (lastTsn + 1) & 0xffff;
    this.fbPktCount = uint8Add(this.fbPktCount, 1);
  }

  /**
   * Choose feedback base:
   * - If {@link nextReportTsn} is set, use it so losses since the previous
   *   feedback are reported as PacketNotReceived.
   * - Otherwise (first feedback) use wrap-aware earliest among received.
   */
  private resolveBaseSequence(
    received: { tsn: number; timestamp: bigint }[],
  ): number | undefined {
    if (this.nextReportTsn !== undefined) {
      const base = this.nextReportTsn & 0xffff;
      // Require at least one received packet at/after base.
      const hasNew = received.some((r) => {
        const off = (r.tsn - base + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
        return off < MAX_FEEDBACK_SPAN;
      });
      return hasNew ? base : undefined;
    }

    // First feedback: largest circular gap → base after gap.
    const unique = [...new Set(received.map((r) => r.tsn))].sort(
      (a, b) => a - b,
    );
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
