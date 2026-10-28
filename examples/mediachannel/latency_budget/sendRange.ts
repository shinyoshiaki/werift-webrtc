// Accounting of the upstream (scenario A) against what the browser really
// sent. The sender transform (sendGate.ts) reports the first / last RTP
// timestamp and the frame count; the RTP timestamp is the one on the wire, and
// one 20ms Opus frame is one packet (+960 ticks, +1 seq). So one received
// packet maps the timestamps to sequence numbers, and every other packet
// checks that mapping. Nothing is estimated: when a check fails, the result is
// "unverified" instead of a wrong number.

/** RTP ticks per packet: 20ms Opus at 48kHz (Chrome's default ptime) */
export const OPUS_FRAME_TICKS = 960;
/** Packets kept while the start notice has not come (1 minute of audio) */
const MAX_EARLY_ARRIVALS = 3000;

export type SendRange = {
  firstRtpTimestamp?: number;
  lastRtpTimestamp?: number;
  frames: number;
};

export type NackCounters = {
  pending: number;
  unrecovered: number;
  late: number;
};

export type Accounting = {
  status: "verified" | "unverified";
  /** why it is unverified */
  reasons: string[];
  frames?: number;
  firstSeq?: number;
  lastSeq?: number;
  /** distinct packets of the range received (retransmissions counted once) */
  uniqueReceived: number;
  duplicates: number;
  /** packets whose (seq, timestamp) is outside the range or off the mapping */
  outOfRange: number;
  mismatched: number;
  /** distinct packets that first arrived after the stop notice */
  arrivedAfterStop: number;
  /** never received = unrecovered - late; balanced when everything is counted */
  neverReceived?: number;
  balanced: boolean;
};

type Arrival = { seq: number; timestamp: number; afterStop: boolean };

export class SendAccounting {
  private firstTimestamp?: number;
  private range?: SendRange;
  private stopped = false;
  /** received before the start notice: checked once it is known */
  private readonly early: Arrival[] = [];
  /** frame index (from the RTP timestamp) -> first arrival after the stop */
  private readonly received = new Map<number, boolean>();
  private duplicates = 0;
  private outOfRange = 0;
  private mismatched = 0;
  private readonly reasons = new Set<string>();
  firstSeq?: number;

  /**
   * The sender's first RTP timestamp. Returns the first sequence number once
   * it is known (now, or from `receive` later).
   */
  start(firstRtpTimestamp: number) {
    if (this.firstTimestamp !== undefined) return undefined;
    this.firstTimestamp = firstRtpTimestamp;
    const early = this.early.splice(0);
    let firstSeq: number | undefined;
    for (const arrival of early) {
      firstSeq ??= this.count(arrival);
    }
    return firstSeq;
  }

  /** Every received RTP packet. Returns the first sequence number when it becomes known. */
  receive(seq: number, timestamp: number) {
    const arrival = { seq, timestamp, afterStop: this.stopped };
    if (this.firstTimestamp === undefined) {
      if (this.early.length < MAX_EARLY_ARRIVALS) this.early.push(arrival);
      else this.reasons.add("start notice did not come");
      return undefined;
    }
    return this.count(arrival);
  }

  private count({ seq, timestamp, afterStop }: Arrival) {
    const ticks = (timestamp - this.firstTimestamp!) | 0;
    if (ticks < 0 || ticks % OPUS_FRAME_TICKS !== 0) {
      // Before the first frame, or not on the 20ms grid (DTX, other ptime).
      if (ticks < 0) this.outOfRange++;
      else this.mismatched++;
      return undefined;
    }
    const index = ticks / OPUS_FRAME_TICKS;
    let derived: number | undefined;
    if (this.firstSeq === undefined) {
      this.firstSeq = (seq - index) & 0xffff;
      derived = this.firstSeq;
    } else if (((this.firstSeq + index) & 0xffff) !== seq) {
      this.mismatched++;
      return undefined;
    }
    if (this.received.has(index)) {
      this.duplicates++;
    } else {
      this.received.set(index, afterStop);
    }
    return derived;
  }

  /** The stop notice with the range. Returns the last sequence number, if it can be derived. */
  stop(range: SendRange) {
    this.stopped = true;
    this.range = range;
    if (
      range.frames === 0 ||
      range.firstRtpTimestamp === undefined ||
      range.lastRtpTimestamp === undefined
    ) {
      this.reasons.add("nothing sent");
      return undefined;
    }
    if (this.firstTimestamp === undefined) {
      // The start notice was lost in transit: the range carries it, too.
      this.start(range.firstRtpTimestamp);
    } else if (this.firstTimestamp !== range.firstRtpTimestamp) {
      this.reasons.add("start and range disagree");
    }
    const span = (range.lastRtpTimestamp - range.firstRtpTimestamp) >>> 0;
    if (
      span % OPUS_FRAME_TICKS !== 0 ||
      span / OPUS_FRAME_TICKS + 1 !== range.frames
    ) {
      // Frames are not one per 20ms (DTX, ptime change): the seq range is unknown.
      this.reasons.add("frame count does not match the timestamps");
      return undefined;
    }
    if (this.firstSeq === undefined) {
      this.reasons.add("no packet received");
      return undefined;
    }
    return (this.firstSeq + range.frames - 1) & 0xffff;
  }

  get frames() {
    return this.range?.frames;
  }

  /** Called after the stop, with the final NACK counters of the same moment. */
  summary(nack: NackCounters): Accounting {
    const frames = this.range?.frames;
    const reasons = new Set(this.reasons);
    if (!this.range) reasons.add("not stopped");
    let uniqueReceived = 0;
    let arrivedAfterStop = 0;
    let outOfRange = this.outOfRange;
    for (const [index, afterStop] of this.received) {
      if (frames !== undefined && index >= frames) {
        outOfRange++;
        continue;
      }
      uniqueReceived++;
      if (afterStop) arrivedAfterStop++;
    }
    if (this.mismatched > 0) reasons.add("seq does not follow the timestamps");
    if (outOfRange > 0) reasons.add("packets outside the sent range");
    const neverReceived = nack.unrecovered - nack.late;
    const balanced =
      frames !== undefined &&
      uniqueReceived + nack.pending + neverReceived === frames;
    const verified = reasons.size === 0;
    return {
      status: verified ? "verified" : "unverified",
      reasons: [...reasons],
      frames,
      firstSeq: this.firstSeq,
      lastSeq:
        verified && frames !== undefined
          ? (this.firstSeq! + frames - 1) & 0xffff
          : undefined,
      uniqueReceived,
      duplicates: this.duplicates,
      outOfRange,
      mismatched: this.mismatched,
      arrivedAfterStop,
      neverReceived,
      balanced: verified && balanced,
    };
  }
}
