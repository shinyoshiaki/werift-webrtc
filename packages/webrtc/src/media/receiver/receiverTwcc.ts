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
/** Max packets in one feedback window (below half the sequence space). */
const MAX_FEEDBACK_SPAN = 0x7fff;
/** Wire RunLengthChunk.runLength is 13 bits → max 8191. */
const RUN_LENGTH_MAX = 8191;

type ExtensionInfo = {
  tsn: number;
  timestamp: bigint;
  /**
   * Extended TSN, unwrapped against the highest one received so far. Entries
   * set without it (tests) are unwrapped when the feedback is built.
   */
  ext?: number;
};

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
 *
 * TSNs are unwrapped against the highest one received (pin
 * `RemoteEstimatorProxy` SeqNumUnwrapper): a jump of up to half the 16-bit
 * space is forward, anything further back is late. Pending packets are
 * reported in windows of at most {@link MAX_FEEDBACK_SPAN} packets. When the
 * first new packet is that far or further past the cursor, the cursor jumps to
 * it (the gap is not reported), so feedback never stalls after a long loss.
 */
export class ReceiverTWCC {
  extensionInfo: {
    [tsn: number]: ExtensionInfo;
  } = {};
  /** Periodic 100ms loop runs while true (enabled in constructor). */
  twccRunning = true;
  /** uint8 */
  fbPktCount = 0;
  /** Extended form of {@link nextReportTsn}. */
  private nextReportExt?: number;
  /** Highest extended TSN received (unwrap reference). */
  private highestRecvExt?: number;

  /**
   * Next transport sequence that should appear in feedback (16-bit).
   * When set, a feedback that receives only TSN N reports any missing
   * sequences from this cursor through N as PacketNotReceived.
   */
  get nextReportTsn(): number | undefined {
    return this.nextReportExt === undefined
      ? undefined
      : this.nextReportExt & 0xffff;
  }
  set nextReportTsn(tsn: number | undefined) {
    this.nextReportExt = tsn === undefined ? undefined : this.unwrapTsn(tsn);
  }

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
    const ext = this.unwrapTsn(tsn);
    this.highestRecvExt = Math.max(this.highestRecvExt ?? ext, ext);
    const info: ExtensionInfo = {
      tsn,
      timestamp: microTime(),
      ext,
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
    const entries = Object.values(this.extensionInfo);
    this.extensionInfo = {};
    if (entries.length === 0) return;

    const byExt = new Map<number, ExtensionInfo>();
    for (const e of entries) {
      const ext = e.ext ?? this.unwrapTsn(e.tsn);
      // Late packets behind the cursor were already reported (as not
      // received) and are dropped.
      if (this.nextReportExt !== undefined && ext < this.nextReportExt) {
        continue;
      }
      byExt.set(ext, e);
    }
    const pending = [...byExt.keys()].sort((a, b) => a - b);

    let i = 0;
    while (i < pending.length) {
      const first = pending[i]!;
      // Continue from the cursor unless the gap alone fills a window.
      const base =
        this.nextReportExt !== undefined &&
        first - this.nextReportExt < MAX_FEEDBACK_SPAN
          ? this.nextReportExt
          : first;
      let last = first;
      while (i < pending.length && pending[i]! - base < MAX_FEEDBACK_SPAN) {
        last = pending[i]!;
        i++;
      }
      this.sendFeedbackWindow(base, last - base + 1, byExt);
      this.nextReportExt = last + 1;
    }
  }

  /**
   * Send one feedback for `packetStatusCount` sequences from extended `base`
   * (at least one of them received).
   */
  private sendFeedbackWindow(
    base: number,
    packetStatusCount: number,
    byExt: Map<number, ExtensionInfo>,
  ) {
    const baseSequenceNumber = base & 0xffff;
    const packetChunks: (RunLengthChunk | StatusVectorChunk)[] = [];
    const recvDeltas: RecvDelta[] = [];

    type StatusEntry = {
      received: boolean;
      status: PacketStatus;
    };
    const statuses: StatusEntry[] = [];

    const lookup = (offset: number): ExtensionInfo | undefined =>
      byExt.get(base + offset);

    let firstRecvTimestamp: bigint | undefined;
    for (let offset = 0; offset < packetStatusCount; offset++) {
      const info = lookup(offset);
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
      const info = lookup(offset);
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

    this.fbPktCount = uint8Add(this.fbPktCount, 1);
  }

  /**
   * Unwrap a 16-bit TSN to the extended value nearest the highest received
   * (exactly half the space counts as forward).
   */
  private unwrapTsn(tsn: number): number {
    const ref = this.highestRecvExt ?? this.nextReportExt;
    if (ref === undefined) return tsn & 0xffff;
    let delta = ((tsn & 0xffff) - (ref & 0xffff) + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
    if (delta > TWCC_SEQ_MOD / 2) delta -= TWCC_SEQ_MOD;
    return ref + delta;
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
