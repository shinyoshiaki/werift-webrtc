/**
 * libwebrtc `InterArrivalDelta` (modules/remote_bitrate_estimator/inter_arrival_delta.*)
 * ported for send/receive times in milliseconds.
 *
 * Groups packets by send-time bursts, then emits send/recv deltas between
 * completed groups for the trendline filter.
 */

/** Send-time group length (ms). libwebrtc default for transport-seq is 5ms. */
export const kSendTimeGroupLengthMs = 5;

/** Arrival burst membership threshold (ms). libwebrtc `kBurstDeltaThreshold`. */
export const kBurstDeltaThresholdMs = 5;

/** Max burst duration from first arrival (ms). libwebrtc `kMaxBurstDuration`. */
export const kMaxBurstDurationMs = 100;

export interface InterArrivalDeltas {
  sendDeltaMs: number;
  recvDeltaMs: number;
  sizeDelta: number;
}

interface TimestampGroup {
  /** First packet send time in the group (ms). Never moved forward on append. */
  firstSendMs: number;
  /** Latest packet send time in the group (ms). */
  sendMs: number;
  /** First packet arrival time (ms). */
  firstRecvMs: number;
  /** Latest packet arrival time / complete time (ms). */
  recvMs: number;
  size: number;
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

  constructor(sendTimeGroupLengthMs = kSendTimeGroupLengthMs) {
    this.sendTimeGroupLengthMs = sendTimeGroupLengthMs;
  }

  reset() {
    this.current = undefined;
    this.prev = undefined;
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
      };
      return undefined;
    }

    if (this.newTimestampGroup(sendMs, recvMs)) {
      if (this.prev) {
        const sendDeltaMs = this.current.firstSendMs - this.prev.firstSendMs;
        const recvDeltaMs = this.current.recvMs - this.prev.recvMs;
        if (sendDeltaMs > 0) {
          out = {
            sendDeltaMs,
            recvDeltaMs,
            sizeDelta: this.current.size - this.prev.size,
          };
        }
      }
      // Snapshot current into prev (new object — do not share mutable refs).
      this.prev = { ...this.current };
      this.current = {
        firstSendMs: sendMs,
        sendMs,
        firstRecvMs: recvMs,
        recvMs,
        size: packetSize,
      };
      return out;
    }

    // Same group: extend latest times and accumulate size; keep firstSendMs.
    this.current.sendMs = sendMs;
    this.current.recvMs = recvMs;
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
        this.prev = { ...this.current };
        this.current = undefined;
      }
      return undefined;
    }
    const sendDeltaMs = this.current.firstSendMs - this.prev.firstSendMs;
    const recvDeltaMs = this.current.recvMs - this.prev.recvMs;
    const sizeDelta = this.current.size - this.prev.size;
    this.prev = { ...this.current };
    // Keep current as the latest completed group seed for the next packet
    // (libwebrtc leaves the completed group as current until a new one starts).
    // We clear firstSendMs tracking by cloning into prev and resetting current
    // so the next packet opens a fresh group — matching "group completed".
    this.current = undefined;
    if (sendDeltaMs > 0) {
      return { sendDeltaMs, recvDeltaMs, sizeDelta };
    }
    return undefined;
  }

  private newTimestampGroup(sendMs: number, recvMs: number): boolean {
    if (!this.current) return true;
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
