/** Received packets remembered per media SSRC (a power of two). */
const HISTORY_SIZE = 1024;
const HISTORY_MASK = HISTORY_SIZE - 1;
/** How far either side of a missing packet its received neighbors are searched. */
const GAP_SEARCH = HISTORY_SIZE / 2;

/**
 * Sequence number → RTP timestamp of the packets received on one media SSRC,
 * used to check that an RTX packet repairs a hole of this stream.
 *
 * Why the check identifies the stream an RTX packet belongs to:
 * - NACK (RFC 4585, `NackHandler`) asks only for a hole between received
 *   packets, so the original sequence number of an answering RTX packet lies
 *   between a received `lo` and `hi` of its own media SSRC.
 * - RTX keeps the original RTP timestamp (RFC 4588 section 4), and RTC video
 *   codecs do not reorder frames, so it lies in `[timestamp(lo), timestamp(hi)]`.
 * - Sequence numbers and timestamps start at random values per SSRC
 *   (RFC 3550 section 5.1), so another SSRC fits the same hole with a
 *   probability of about (timestamp span of the hole) / 2^32, about 1e-6 for
 *   a hole of a few frames. Streams whose sequence numbers and timestamps
 *   start at the same values are bit-identical and cannot be told apart.
 *
 * An RTX packet for a packet already received (a duplicate, e.g. libwebrtc
 * padding with redundant payloads) fits no hole and is dropped, harmlessly.
 */
export class ReceivedPacketHistory {
  private readonly sequenceNumbers = new Int32Array(HISTORY_SIZE).fill(-1);
  private readonly timestamps = new Uint32Array(HISTORY_SIZE);

  add(sequenceNumber: number, timestamp: number) {
    const index = sequenceNumber & HISTORY_MASK;
    this.sequenceNumbers[index] = sequenceNumber;
    this.timestamps[index] = timestamp;
  }

  has(sequenceNumber: number) {
    return (
      this.sequenceNumbers[sequenceNumber & HISTORY_MASK] === sequenceNumber
    );
  }

  /**
   * Whether `sequenceNumber` was not received and lies between received
   * packets whose timestamps enclose `timestamp`.
   */
  fitsHole(sequenceNumber: number, timestamp: number) {
    if (this.has(sequenceNumber)) return false;
    const lo = this.nearestReceived(sequenceNumber, -1);
    const hi = this.nearestReceived(sequenceNumber, 1);
    if (lo === undefined || hi === undefined) return false;
    const tsLo = this.timestamps[lo & HISTORY_MASK];
    const tsHi = this.timestamps[hi & HISTORY_MASK];
    const span = uint32Sub(tsHi, tsLo);
    if (span >= 0x80000000) return false;
    return uint32Sub(timestamp, tsLo) <= span;
  }

  private nearestReceived(sequenceNumber: number, step: 1 | -1) {
    for (let distance = 1; distance <= GAP_SEARCH; distance++) {
      const candidate = (sequenceNumber + step * distance) & 0xffff;
      if (this.has(candidate)) return candidate;
    }
    return undefined;
  }
}

/** `(a - b)` on the 32-bit RTP timestamp circle. */
function uint32Sub(a: number, b: number) {
  return (a - b) >>> 0;
}
