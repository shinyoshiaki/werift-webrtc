import type { TransportWideCC } from "../../../imports/rtp";
import type { SentInfo } from "../bandwidthEstimator";
import { TransportWideSeqUnwrapper } from "./gcc/sequenceNumber";
import { hasTwccReceiveTiming } from "./twccReceiveTiming";
import { TwccReferenceTimeUnwrapper } from "./twccReferenceTime";

/**
 * History span limit in extended transport-wide sequence numbers.
 *
 * Every key kept in history lies in `(latestSent - span, latestSent]`. With a
 * span below half of the 16-bit space, a 16-bit feedback number maps onto at
 * most one history entry, and the nearest-generation unwrap cannot pick the
 * wrong one.
 */
export const kTwccFeedbackHistoryMaxSeqSpan = 0x8000;

/** One sent packet matched against a TWCC feedback. */
export interface TwccPacketFeedback {
  /** Extended (unwrapped) transport-wide sequence number. */
  extSeq: number;
  /** Observation recorded when the packet was sent. */
  sent: SentInfo;
  /** False when this feedback reports the packet as not received. */
  received: boolean;
  /**
   * Receive time in ms on a continuous timeline (24-bit reference_time
   * unwrapped). `undefined` when lost or reported without a receive delta.
   */
  recvMs?: number;
}

/**
 * Normalizes TWCC feedback before any estimator sees it
 * (pin `TransportFeedbackAdapter`).
 *
 * - Sent packets are kept by extended transport-wide sequence, in send order.
 * - Feedback numbers are unwrapped against the previous feedback (seeded by the
 *   latest sent number), never by searching generations.
 * - A packet reported as received is removed from history, so every sent
 *   packet is reported as received **at most once**. Later re-reports
 *   (duplicate or corrective feedback) are ignored.
 * - A packet reported as not received stays in history; a later feedback may
 *   still report it as received.
 *
 * Shared by every {@link BandwidthEstimator} that consumes TWCC (legacy, GCC).
 */
export class TwccFeedbackAdapter {
  private readonly history = new Map<number, SentInfo>();
  private readonly sentUnwrapper = new TransportWideSeqUnwrapper();
  private readonly refTimeUnwrapper = new TwccReferenceTimeUnwrapper();
  private lastFeedbackSeq: number | undefined;

  /**
   * @param maxAgeMs Drop history entries sent more than this long ago.
   */
  constructor(private readonly maxAgeMs: number) {}

  /** Number of packets still waiting for a received report. */
  get size(): number {
    return this.history.size;
  }

  /** Latest extended sequence recorded by {@link onSent}. */
  get latestSentSeq(): number | undefined {
    return this.sentUnwrapper.last;
  }

  /**
   * Record a sent packet. `info.wideSeq` may be extended or 16-bit; 16-bit
   * values only move forward.
   * @returns extended sequence used as the history key
   */
  onSent(info: SentInfo): number {
    const extSeq = this.sentUnwrapper.advanceSent(info.wideSeq);
    this.history.delete(extSeq);
    this.history.set(extSeq, info);
    this.prune(info.sendingAtMs);
    return extSeq;
  }

  /** Drop entries outside the age window or the sequence span limit. */
  prune(nowMs: number): void {
    const latest = this.sentUnwrapper.last;
    for (const [extSeq, info] of this.history) {
      const tooOld = nowMs - info.sendingAtMs > this.maxAgeMs;
      const tooFar =
        latest !== undefined &&
        latest - extSeq >= kTwccFeedbackHistoryMaxSeqSpan;
      if (!tooOld && !tooFar) break;
      this.history.delete(extSeq);
    }
  }

  /**
   * Match one TWCC feedback against the send history.
   * Results are in extended-sequence (send) order. Packets this sender did not
   * send (other BUNDLE senders) or already reported as received are omitted.
   */
  onFeedback(feedback: TransportWideCC): TwccPacketFeedback[] {
    const results = Number.isFinite(feedback.referenceTime)
      ? this.refTimeUnwrapper.rebasePacketResults(
          feedback.packetResults,
          feedback.referenceTime,
        )
      : feedback.packetResults;
    const out: TwccPacketFeedback[] = [];
    for (const result of results) {
      const extSeq = this.unwrapFeedbackSeq(result.sequenceNumber);
      const sent = this.history.get(extSeq);
      if (!sent) continue;
      if (!result.received) {
        out.push({ extSeq, sent, received: false });
        continue;
      }
      this.history.delete(extSeq);
      out.push({
        extSeq,
        sent,
        received: true,
        recvMs: hasTwccReceiveTiming(result) ? result.receivedAtMs : undefined,
      });
    }
    // Real feedback is already ordered; keep synthetic input deterministic.
    return out.sort((a, b) => a.extSeq - b.extSeq);
  }

  reset(): void {
    this.history.clear();
    this.sentUnwrapper.reset();
    this.refTimeUnwrapper.reset();
    this.lastFeedbackSeq = undefined;
  }

  /**
   * Unwrap to the extended value nearest the previous feedback number.
   * The anchor never moves backward and never falls behind the history
   * window, so a reordered or long-delayed feedback cannot pull later
   * numbers into an older generation.
   */
  private unwrapFeedbackSeq(seq: number): number {
    if (seq > 0xffff) {
      // Already extended (synthetic callers).
      this.lastFeedbackSeq = Math.max(this.lastFeedbackSeq ?? seq, seq);
      return seq;
    }
    const latestSent = this.sentUnwrapper.last;
    let anchor = this.lastFeedbackSeq ?? latestSent;
    if (anchor === undefined) {
      return seq & 0xffff;
    }
    if (latestSent !== undefined) {
      anchor = Math.max(anchor, latestSent - kTwccFeedbackHistoryMaxSeqSpan);
    }
    let delta = (seq & 0xffff) - (anchor & 0xffff);
    if (delta > 0x8000) delta -= 0x10000;
    else if (delta <= -0x8000) delta += 0x10000;
    const extSeq = anchor + delta;
    this.lastFeedbackSeq = Math.max(this.lastFeedbackSeq ?? extSeq, extSeq);
    return extSeq;
  }
}
