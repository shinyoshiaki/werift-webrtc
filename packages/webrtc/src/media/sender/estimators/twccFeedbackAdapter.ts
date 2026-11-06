import {
  hasTwccReceiveTiming,
  type TransportWideCC,
  TransportWideSeqUnwrapper,
  TwccReferenceTimeUnwrapper,
} from "../../../imports/rtp";
import type { SentInfo } from "../bandwidthEstimator";

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
 * Time contract. Three times are involved, all on the caller's clock (ms):
 * - `SentInfo.sendingAtMs`: right before the packet is handed to ICE.
 * - `SentInfo.sentAtMs`: when the send completed ({@link onSent} is called
 *   at or after this time).
 * - `nowMs` of {@link onFeedback} / {@link prune}: when the feedback arrived
 *   or the caller ticks.
 *
 * The adapter keeps a monotonic clock: the largest `sentAtMs` / `nowMs` seen.
 * A packet's age is `clock - sendingAtMs`. A packet is in range while its age
 * is at most `maxAgeMs` and it lies less than
 * {@link kTwccFeedbackHistoryMaxSeqSpan} behind the latest sent sequence.
 * {@link onFeedback} checks every matched packet against this range at match
 * time, so it never returns an out-of-range packet regardless of call order.
 * Pruning only bounds memory.
 *
 * Shared by every {@link BandwidthEstimator} that consumes TWCC (lightweight, GCC).
 */
export class TwccFeedbackAdapter {
  private readonly maxAgeMs: number;
  /**
   * Send history by extended sequence. Entries confirmed in order are kept in
   * ascending sequence and send-time order (`RTCRtpSender` samples
   * `sendingAtMs` synchronously right after allocating the TSN), so pruning
   * can stop at the first entry still in range.
   */
  private readonly history = new Map<number, SentInfo>();
  /**
   * Keys confirmed after a larger sequence (concurrent sends completing out of
   * order). They break the insertion order above, so {@link prune} checks
   * each of them individually instead of relying on the early stop.
   */
  private readonly outOfOrderKeys = new Set<number>();
  private readonly sentUnwrapper = new TransportWideSeqUnwrapper();
  private readonly refTimeUnwrapper = new TwccReferenceTimeUnwrapper();
  private lastFeedbackSeq: number | undefined;
  /** Monotonic clock: largest `sentAtMs` / `nowMs` seen (see time contract). */
  private clockMs = Number.NEGATIVE_INFINITY;

  /**
   * @param maxAgeMs Max age (`clock - sendingAtMs`) of a packet that may
   *   still be matched.
   */
  constructor(maxAgeMs: number) {
    this.maxAgeMs = maxAgeMs;
  }

  /** Number of packets still waiting for a received report. */
  get size(): number {
    return this.history.size;
  }

  /** Latest extended sequence recorded by {@link onSent}. */
  get latestSentSeq(): number | undefined {
    return this.sentUnwrapper.last;
  }

  /**
   * Record a sent packet. `info.wideSeq` is the extended transport-wide
   * sequence number and is kept exactly, even when confirmations arrive out
   * of order. Advances the clock to `info.sentAtMs`.
   * @returns extended sequence used as the history key
   */
  onSent(info: SentInfo): number {
    const previousLatest = this.sentUnwrapper.last;
    const extSeq = this.sentUnwrapper.advanceSent(info.wideSeq);
    this.advanceClock(info.sentAtMs);
    this.forget(extSeq);
    const outOfOrder = previousLatest !== undefined && extSeq <= previousLatest;
    // A late confirmation already outside the span / age window is not kept,
    // so the history span stays below half of the 16-bit space.
    if (!this.isOutOfRange(extSeq, info)) {
      this.history.set(extSeq, info);
      if (outOfOrder) this.outOfOrderKeys.add(extSeq);
    }
    this.pruneHistory();
    return extSeq;
  }

  /**
   * Advance the clock to `nowMs` and drop entries now out of range. Memory
   * bound only: {@link onFeedback} checks the range itself.
   */
  prune(nowMs: number): void {
    this.advanceClock(nowMs);
    this.pruneHistory();
  }

  private advanceClock(nowMs: number) {
    if (Number.isFinite(nowMs)) this.clockMs = Math.max(this.clockMs, nowMs);
  }

  private pruneHistory() {
    for (const [extSeq, info] of this.history) {
      if (this.outOfOrderKeys.has(extSeq)) continue;
      if (!this.isOutOfRange(extSeq, info)) break;
      this.history.delete(extSeq);
    }
    for (const extSeq of this.outOfOrderKeys) {
      const info = this.history.get(extSeq);
      if (!info || this.isOutOfRange(extSeq, info)) {
        this.forget(extSeq);
      }
    }
  }

  private isOutOfRange(extSeq: number, info: SentInfo) {
    const latest = this.sentUnwrapper.last;
    const tooOld = this.clockMs - info.sendingAtMs > this.maxAgeMs;
    const tooFar =
      latest !== undefined && latest - extSeq >= kTwccFeedbackHistoryMaxSeqSpan;
    return tooOld || tooFar;
  }

  private forget(extSeq: number) {
    this.history.delete(extSeq);
    this.outOfOrderKeys.delete(extSeq);
  }

  /**
   * Match one TWCC feedback against the send history.
   * Results are in extended-sequence (send) order. Packets this sender did not
   * send (other BUNDLE senders), already reported as received, or out of
   * range at match time (see time contract) are omitted.
   * @param nowMs Feedback arrival time; advances the clock.
   */
  onFeedback(feedback: TransportWideCC, nowMs: number): TwccPacketFeedback[] {
    this.advanceClock(nowMs);
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
      if (this.isOutOfRange(extSeq, sent)) {
        this.forget(extSeq);
        continue;
      }
      if (!result.received) {
        out.push({ extSeq, sent, received: false });
        continue;
      }
      this.forget(extSeq);
      out.push({
        extSeq,
        sent,
        received: true,
        recvMs: hasTwccReceiveTiming(result) ? result.receivedAtMs : undefined,
      });
    }
    this.pruneHistory();
    // Real feedback is already ordered; keep synthetic input deterministic.
    return out.sort((a, b) => a.extSeq - b.extSeq);
  }

  reset(): void {
    this.history.clear();
    this.outOfOrderKeys.clear();
    this.sentUnwrapper.reset();
    this.refTimeUnwrapper.reset();
    this.lastFeedbackSeq = undefined;
    this.clockMs = Number.NEGATIVE_INFINITY;
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
