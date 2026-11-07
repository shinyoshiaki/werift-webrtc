/**
 * Received packets remembered per media SSRC (a power of two, and far more
 * than the losses `NackHandler` asks for at once).
 */
const HISTORY_SIZE = 1024;
const HISTORY_MASK = HISTORY_SIZE - 1;
/**
 * Slack, in seconds of the media clock, around the timestamps of a hole's
 * received neighbors. Covers frames sent out of display order (B-frames,
 * whose timestamps are not monotonic in sending order) and the frames a long
 * burst loss spans past its oldest remembered neighbor.
 */
const TIMESTAMP_SLACK_SECONDS = 1;
/**
 * A jump of more than this many sequence numbers records the packet before
 * it, so a hole of a long burst keeps its lower neighbor after that packet
 * leaves the history. At most HISTORY_SIZE / GAP_RECORD_MIN such jumps fit in
 * the history window, so the bounded list never drops one still needed.
 */
const GAP_RECORD_MIN = 32;
const MAX_GAP_STARTS = HISTORY_SIZE / GAP_RECORD_MIN;

/**
 * Sequence number → RTP timestamp of the packets received on one media SSRC,
 * used to check that an RTX packet repairs a hole of this stream.
 *
 * An RTX packet fits when its original sequence number:
 * - lies after the first packet received on the SSRC and less than
 *   {@link HISTORY_SIZE} behind the newest one, the range where the history
 *   knows exactly which packets arrived (NACK, RFC 4585, asks only for
 *   numbers after a received packet and before the newest one), whatever the
 *   length of the burst it belongs to;
 * - was not received (a duplicate, e.g. libwebrtc padding with redundant
 *   payloads, fits nothing and is dropped harmlessly);
 * and its RTP timestamp, which RTX keeps (RFC 4588 section 4), lies within
 * the timestamps of the nearest received packets on either side, in either
 * order, widened by {@link TIMESTAMP_SLACK_SECONDS}. No timestamp order is
 * assumed, so frames sent out of display order still fit. The neighbors are
 * searched over the whole history window, and the packet before a long jump
 * is also kept apart (see {@link GAP_RECORD_MIN}); a hole whose lower
 * neighbor is known by neither is dropped rather than guessed.
 *
 * Why this identifies the stream: sequence numbers and timestamps start at
 * random values per SSRC (RFC 3550 section 5.1). Another SSRC fits only if
 * the number is also a recent hole of that SSRC and the timestamp falls in
 * its window, about (2 s of media clock + the neighbors' span) / 2^32, some
 * 5e-5 at 90 kHz, for a number that is a hole of both. Streams whose sequence
 * numbers and timestamps start at the same values are bit-identical and
 * cannot be told apart; the caller drops a packet that fits several.
 */
export class ReceivedPacketHistory {
  private readonly sequenceNumbers = new Int32Array(HISTORY_SIZE).fill(-1);
  private readonly timestamps = new Uint32Array(HISTORY_SIZE);
  /** Extended (wrap-counting) sequence numbers of the first / newest packet. */
  private firstExt?: number;
  private newestExt = 0;
  /** Packets before a jump of more than {@link GAP_RECORD_MIN}, oldest first. */
  private readonly gapStarts: { ext: number; timestamp: number }[] = [];
  private readonly slack: number;

  constructor(clockRate: number) {
    this.slack = Math.round(clockRate * TIMESTAMP_SLACK_SECONDS);
  }

  add(sequenceNumber: number, timestamp: number) {
    const ext = this.extend(sequenceNumber);
    if (this.firstExt === undefined) {
      this.firstExt = this.newestExt = ext;
    } else if (ext > this.newestExt) {
      if (
        ext - this.newestExt > GAP_RECORD_MIN &&
        this.has(this.newestExt & 0xffff)
      ) {
        this.gapStarts.push({
          ext: this.newestExt,
          timestamp: this.timestamps[this.newestExt & HISTORY_MASK],
        });
        if (this.gapStarts.length > MAX_GAP_STARTS) this.gapStarts.shift();
      }
      this.newestExt = ext;
    } else if (ext < this.firstExt) {
      this.firstExt = ext;
    }
    const index = sequenceNumber & HISTORY_MASK;
    this.sequenceNumbers[index] = sequenceNumber;
    this.timestamps[index] = timestamp;
  }

  has(sequenceNumber: number) {
    return (
      this.sequenceNumbers[sequenceNumber & HISTORY_MASK] === sequenceNumber
    );
  }

  /** Whether an RTX packet with this original number and timestamp fits a hole. */
  fitsHole(sequenceNumber: number, timestamp: number) {
    if (this.firstExt === undefined) return false;
    const ext = this.extend(sequenceNumber);
    if (ext <= this.firstExt || ext >= this.newestExt) return false;
    if (this.newestExt - ext >= HISTORY_SIZE) return false;
    if (this.has(sequenceNumber)) return false;

    // newest は受信済みなので hi は必ず見つかる。lo は履歴の範囲内で探す。
    const oldest = Math.max(this.firstExt, this.newestExt - HISTORY_SIZE + 1);
    let hi = ext + 1;
    while (!this.has(hi & 0xffff)) hi++;
    let lo = ext - 1;
    while (lo >= oldest && !this.has(lo & 0xffff)) lo--;
    let tsLo: number;
    if (lo >= oldest) {
      tsLo = this.timestamps[lo & HISTORY_MASK];
    } else {
      // 履歴から外れた下側の隣は、長い欠落の直前として記録されていれば使う。
      const start = this.gapStarts.findLast(
        (gap) => gap.ext < ext && gap.ext >= this.firstExt!,
      );
      if (!start) return false;
      tsLo = start.timestamp;
    }

    const tsHi = this.timestamps[hi & HISTORY_MASK];
    // 時刻は hi からの符号付き差で比べる (32 bit の折り返しに依存しない)。
    const fromHi = (value: number) => (value - tsHi) | 0;
    const loOffset = fromHi(tsLo);
    const offset = fromHi(timestamp);
    return (
      offset >= Math.min(loOffset, 0) - this.slack &&
      offset <= Math.max(loOffset, 0) + this.slack
    );
  }

  /** The extended sequence number of `sequenceNumber` nearest the newest. */
  private extend(sequenceNumber: number) {
    const delta = (sequenceNumber - this.newestExt) & 0xffff;
    return this.newestExt + (delta < 0x8000 ? delta : delta - 0x10000);
  }
}
