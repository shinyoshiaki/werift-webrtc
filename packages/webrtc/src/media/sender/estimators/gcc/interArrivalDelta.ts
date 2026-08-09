/**
 * libwebrtc `InterArrivalDelta` (modules/remote_bitrate_estimator/inter_arrival_delta.*)
 * ported for send/receive times in milliseconds.
 *
 * Groups packets by send-time bursts, then emits send/recv deltas between
 * completed groups for the trendline filter.
 *
 * Send-delta between groups uses **latest** send times in each group
 * (`current.sendMs - prev.sendMs`), matching libwebrtc.
 */

/** Send-time group length (ms). libwebrtc default for transport-seq is 5ms. */
export const kSendTimeGroupLengthMs = 5;

/** Arrival burst membership threshold (ms). libwebrtc `kBurstDeltaThreshold`. */
export const kBurstDeltaThresholdMs = 5;

/** Max burst duration from first arrival (ms). libwebrtc `kMaxBurstDuration`. */
export const kMaxBurstDurationMs = 100;

/**
 * After this many consecutive reorder (negative arrival-delta) samples,
 * reset state (libwebrtc `kReorderedResetThreshold` = 3).
 */
export const kReorderedResetThreshold = 3;

/**
 * Arrival/system offset that triggers a full reset (ms).
 * libwebrtc `kArrivalTimeOffsetThresholdMs` = 3000.
 */
export const kArrivalTimeOffsetThresholdMs = 3000;

export interface InterArrivalDeltas {
  sendDeltaMs: number;
  recvDeltaMs: number;
  sizeDelta: number;
}

interface TimestampGroup {
  /** First packet send time in the group (ms). Never moved forward on append. */
  firstSendMs: number;
  /** Latest packet send time in the group (ms). Monotonic max. */
  sendMs: number;
  /** First packet arrival time (ms). */
  firstRecvMs: number;
  /** Latest packet arrival time / complete time (ms). */
  recvMs: number;
  size: number;
  complete: boolean;
}

/**
 * Packet batcher for delay-based GCC.
 * Unlike a naive "last packet" burst check, this keeps `firstSendMs` fixed so
 * continuous ≤5ms spacing still closes groups after `kSendTimeGroupLengthMs`.
 */
export class InterArrivalDelta {
  private readonly sendTimeGroupLengthMs: number;
  private current?: TimestampGroup;
  private prev?: TimestampGroup;
  private numConsecutiveReorderedPackets = 0;

  constructor(sendTimeGroupLengthMs = kSendTimeGroupLengthMs) {
    this.sendTimeGroupLengthMs = sendTimeGroupLengthMs;
  }

  reset() {
    this.current = undefined;
    this.prev = undefined;
    this.numConsecutiveReorderedPackets = 0;
  }

  /**
   * Ingest one packet. When a completed previous group pair is available,
   * returns send/recv/size deltas; otherwise `undefined`.
   */
  computeDeltas(
    sendMs: number,
    recvMs: number,
    packetSize: number,
  ): InterArrivalDeltas | undefined {
    let out: InterArrivalDeltas | undefined;

    if (!this.current) {
      this.current = {
        firstSendMs: sendMs,
        sendMs,
        firstRecvMs: recvMs,
        recvMs,
        size: packetSize,
        complete: false,
      };
      return undefined;
    }

    // Packet older than current group's first send → ignore (reordered).
    if (sendMs < this.current.firstSendMs) {
      return undefined;
    }

    if (this.newTimestampGroup(sendMs, recvMs)) {
      if (this.prev) {
        // libwebrtc: send delta = latest send times of the two groups.
        const sendDeltaMs = this.current.sendMs - this.prev.sendMs;
        const recvDeltaMs = this.current.recvMs - this.prev.recvMs;

        if (recvDeltaMs < 0) {
          this.numConsecutiveReorderedPackets++;
          if (
            this.numConsecutiveReorderedPackets >= kReorderedResetThreshold
          ) {
            this.reset();
            this.current = {
              firstSendMs: sendMs,
              sendMs,
              firstRecvMs: recvMs,
              recvMs,
              size: packetSize,
              complete: false,
            };
            return undefined;
          }
        } else {
          this.numConsecutiveReorderedPackets = 0;
          if (sendDeltaMs > 0) {
            out = {
              sendDeltaMs,
              recvDeltaMs,
              sizeDelta: this.current.size - this.prev.size,
            };
          }
        }
      }
      this.prev = { ...this.current, complete: true };
      this.current = {
        firstSendMs: sendMs,
        sendMs,
        firstRecvMs: recvMs,
        recvMs,
        size: packetSize,
        complete: false,
      };
      return out;
    }

    // Same group: extend with max send/recv; never rewind sendMs on reorder.
    this.current.sendMs = Math.max(this.current.sendMs, sendMs);
    this.current.recvMs = Math.max(this.current.recvMs, recvMs);
    this.current.size += packetSize;
    return undefined;
  }

  /**
   * Flush any in-progress group as complete (e.g. end of TWCC feedback batch).
   * Does not invent a following group; returns deltas vs prev if possible.
   */
  flush(): InterArrivalDeltas | undefined {
    if (!this.current || !this.prev) {
      if (this.current) {
        this.prev = { ...this.current, complete: true };
        this.current = undefined;
      }
      return undefined;
    }
    const sendDeltaMs = this.current.sendMs - this.prev.sendMs;
    const recvDeltaMs = this.current.recvMs - this.prev.recvMs;
    const sizeDelta = this.current.size - this.prev.size;
    this.prev = { ...this.current, complete: true };
    this.current = undefined;
    if (sendDeltaMs > 0 && recvDeltaMs >= 0) {
      return { sendDeltaMs, recvDeltaMs, sizeDelta };
    }
    return undefined;
  }

  private newTimestampGroup(sendMs: number, recvMs: number): boolean {
    if (!this.current) return true;

    // Large arrival/system offset → treat as new timeline (caller resets via
    // negative-delta path if needed). Check offset vs previous complete time.
    if (this.prev) {
      const offset = this.current.firstRecvMs - this.prev.recvMs;
      if (Math.abs(offset) > kArrivalTimeOffsetThresholdMs) {
        // Force group boundary; deltas may be discarded by reorder logic.
        return true;
      }
    }

    if (this.belongsToBurst(sendMs, recvMs)) return false;
    return sendMs - this.current.firstSendMs > this.sendTimeGroupLengthMs;
  }

  private belongsToBurst(sendMs: number, recvMs: number): boolean {
    if (!this.current) return false;
    const arrivalDelta = recvMs - this.current.recvMs;
    const sendDelta = sendMs - this.current.sendMs;
    if (sendDelta === 0) return true;
    const propagationDelta = arrivalDelta - sendDelta;
    if (
      propagationDelta < 0 &&
      arrivalDelta <= kBurstDeltaThresholdMs &&
      recvMs - this.current.firstRecvMs < kMaxBurstDurationMs
    ) {
      return true;
    }
    return false;
  }
}
