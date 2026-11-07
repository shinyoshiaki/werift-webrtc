/** Max Sender Reports kept: about 16 s at the shortest RTCP interval (0.5 s). */
export const SENDER_REPORT_HISTORY_MAX_ENTRIES = 32;
/** Sender Reports older than this (seconds) are no longer matched. */
export const SENDER_REPORT_HISTORY_MAX_AGE_SEC = 30;

/**
 * Bounded history of sent RTCP Sender Reports, so a report block whose `LSR`
 * references an older SR (delayed or queued RTCP) still yields an RTT sample
 * (RFC 3550 §6.4.1: the RTT is relative to the SR the `LSR` identifies, not to
 * the newest SR sent).
 *
 * Several entries may share an `LSR` value; `roundTripTime` resolves a
 * collision to the newest SR that could have been received `DLSR` seconds
 * before now, so a too-new SR never yields a negative RTT. `LSR` values are
 * only compared for equality, so compact NTP wraparound (16 bit seconds, about
 * 18.2 hours) matters only if a value repeats within the retention time.
 *
 * Times are monotonic seconds (`performance.now() / 1000`).
 */
export class SenderReportHistory {
  private entries: { lsr: number; sentAtSec: number }[] = [];
  readonly maxEntries: number;
  readonly maxAgeSec: number;

  constructor(
    maxEntries = SENDER_REPORT_HISTORY_MAX_ENTRIES,
    maxAgeSec = SENDER_REPORT_HISTORY_MAX_AGE_SEC,
  ) {
    this.maxEntries = maxEntries;
    this.maxAgeSec = maxAgeSec;
  }

  get size() {
    return this.entries.length;
  }

  /**
   * @param lsr compact NTP (`compactNtp`) of the NTP timestamp placed in the SR
   * @param sentAtSec monotonic send time in seconds
   */
  record(lsr: number, sentAtSec: number) {
    this.entries.push({ lsr, sentAtSec });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    this.prune(sentAtSec);
  }

  /**
   * RTT in seconds for a report block, or `undefined` when the block cannot be
   * matched safely: `lsr === 0` (no SR received, RFC 3550), an unknown or
   * evicted `LSR`, or a sample that would be negative or older than the
   * retention time.
   *
   * @param dlsr delay since last SR in 1/65536 seconds
   * @param nowSec monotonic receive time in seconds
   */
  roundTripTime(lsr: number, dlsr: number, nowSec: number) {
    if (lsr === 0) {
      return undefined;
    }
    this.prune(nowSec);
    const dlsrSec = dlsr / 65536;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.lsr !== lsr || entry.sentAtSec > nowSec - dlsrSec) {
        continue;
      }
      const rtt = nowSec - entry.sentAtSec - dlsrSec;
      if (rtt < 0 || rtt > this.maxAgeSec) {
        return undefined;
      }
      return rtt;
    }
    return undefined;
  }

  clear() {
    this.entries = [];
  }

  private prune(nowSec: number) {
    const oldest = nowSec - this.maxAgeSec;
    const firstKept = this.entries.findIndex(
      (entry) => entry.sentAtSec >= oldest,
    );
    if (firstKept === -1) {
      this.entries = [];
    } else if (firstKept > 0) {
      this.entries.splice(0, firstKept);
    }
  }
}
