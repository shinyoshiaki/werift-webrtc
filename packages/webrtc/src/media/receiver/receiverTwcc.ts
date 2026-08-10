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
/**
 * How far before {@link ReceiverTWCC.nextReportTsn} a late-reordered packet
 * may still generate corrective feedback (libwebrtc keeps arrival timestamps
 * briefly for ResendsTimestampsOnReordering).
 */
const REORDER_BACK_WINDOW = 64;
/** Wire RunLengthChunk.runLength is 13 bits → max 8191. */
const RUN_LENGTH_MAX = 8191;

type ExtensionInfo = { tsn: number; timestamp: bigint };

/**
 * Receiver-side TWCC feedback generator.
 *
 * Feedback triggers: every 100ms (periodic) or when >10 packets are buffered.
 * Status chunks cover the full transport-sequence span (including gaps as
 * PacketNotReceived), including losses that straddle feedback boundaries via
 * {@link nextReportTsn}. Late reordered packets within
 * {@link REORDER_BACK_WINDOW} can produce corrective feedback.
 */
export class ReceiverTWCC {
  extensionInfo: {
    [tsn: number]: ExtensionInfo;
  } = {};
  /**
   * Recent arrivals retained after feedback so a late packet that filled a
   * prior "not received" hole can be re-reported (bounded back-window).
   */
  private arrivalHistory = new Map<number, ExtensionInfo>();
  /** Periodic 100ms loop runs while true (enabled in constructor). */
  twccRunning = true;
  /** uint8 */
  fbPktCount = 0;
  /**
   * Next transport sequence that should appear in feedback (wrap-aware).
   * When set, a feedback that receives only TSN N reports any missing
   * sequences from this cursor through N as PacketNotReceived.
   * Late arrivals with TSN in (nextReportTsn − BACK_WINDOW, nextReportTsn)
   * may still trigger corrective feedback without moving the frontier back.
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
    const info: ExtensionInfo = {
      tsn,
      timestamp: microTime(),
    };
    this.extensionInfo[tsn] = info;
    this.arrivalHistory.set(tsn, info);
    this.pruneHistory(tsn);

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

  private pruneHistory(latestTsn: number) {
    // Keep roughly 2× back-window around the frontier / latest.
    const keep = REORDER_BACK_WINDOW * 2 + 16;
    if (this.arrivalHistory.size <= keep) return;
    for (const tsn of this.arrivalHistory.keys()) {
      const back = (latestTsn - tsn + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
      if (back > keep && back < MAX_FEEDBACK_SPAN) {
        this.arrivalHistory.delete(tsn);
      }
    }
  }

  private sendTWCC() {
    if (Object.keys(this.extensionInfo).length === 0) return;

    // Base/max are decided from **pending** arrivals only (this feedback cycle).
    // History fills timestamps for neighbors when building status (corrective).
    const pending = Object.values(this.extensionInfo).map((e) => ({
      tsn: e.tsn & 0xffff,
      timestamp: e.timestamp,
    }));

    const baseSequenceNumber = this.resolveBaseSequence(pending);
    if (baseSequenceNumber === undefined) {
      // Only already-reported sequences remain — drop pending buffer.
      this.extensionInfo = {};
      return;
    }

    // Latest pending packet at/after base; also extend max through history so a
    // corrective feedback can re-include already-seen neighbors (e.g. 101 late
    // after 100/102 were reported → report 101..102 with 102 from history).
    let maxOffset = -1;
    const consider = (tsn: number) => {
      const off = (tsn - baseSequenceNumber + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
      if (off < MAX_FEEDBACK_SPAN) {
        maxOffset = Math.max(maxOffset, off);
      }
    };
    for (const r of pending) consider(r.tsn);
    // If this is a corrective feedback (base < frontier), include history up to
    // frontier-1 so previously received packets in the hole range reappear.
    if (this.nextReportTsn !== undefined) {
      const frontier = this.nextReportTsn & 0xffff;
      const back =
        (frontier - baseSequenceNumber + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
      if (back > 0 && back <= REORDER_BACK_WINDOW) {
        // Cover [base, frontier) at least.
        const frontierOff =
          (frontier - 1 - baseSequenceNumber + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
        if (frontierOff < MAX_FEEDBACK_SPAN) {
          maxOffset = Math.max(maxOffset, frontierOff);
        }
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

    // Lookup: pending extensionInfo first, then history (for re-reports).
    const lookup = (seq: number): ExtensionInfo | undefined =>
      this.extensionInfo[seq] ?? this.arrivalHistory.get(seq);

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

    // Clear pending; history keeps arrivals for late-reorder corrections.
    this.extensionInfo = {};
    // Advance frontier only forward (corrective feedback must not rewind it).
    this.advanceNextReportTsn((lastTsn + 1) & 0xffff);
    this.fbPktCount = uint8Add(this.fbPktCount, 1);
  }

  /**
   * Advance {@link nextReportTsn} only in the forward half of the sequence
   * space so a corrective feedback for an old hole does not move the frontier
   * backward.
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
   * - Late packets within REORDER_BACK_WINDOW before nextReportTsn → base at
   *   the earliest such packet (corrective feedback).
   * - Else if nextReportTsn is set, use it so losses since the previous
   *   feedback are reported as PacketNotReceived.
   * - Else (first feedback) use wrap-aware earliest among received.
   */
  private resolveBaseSequence(
    received: { tsn: number; timestamp: bigint }[],
  ): number | undefined {
    if (this.nextReportTsn !== undefined) {
      const frontier = this.nextReportTsn & 0xffff;

      // Corrective path: late arrival filling a prior hole.
      const late = received.filter((r) => {
        const back = (frontier - r.tsn + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
        return back > 0 && back <= REORDER_BACK_WINDOW;
      });
      if (late.length > 0) {
        // Earliest late packet (max back-distance from frontier).
        let best = late[0];
        let bestBack = (frontier - best.tsn + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
        for (const r of late) {
          const back = (frontier - r.tsn + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
          if (back > bestBack) {
            best = r;
            bestBack = back;
          }
        }
        return best.tsn & 0xffff;
      }

      // Normal path: require at least one packet at/after frontier.
      const hasNew = received.some((r) => {
        const off = (r.tsn - frontier + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
        return off < MAX_FEEDBACK_SPAN;
      });
      return hasNew ? frontier : undefined;
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
