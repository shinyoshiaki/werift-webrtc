import { PacketStatus, type PacketResult } from "../../../imports/rtp";

/**
 * Whether a TWCC {@link PacketResult} carries a usable receive-time sample
 * for delay-based BWE / acked bitrate.
 *
 * - `TypeTCCPacketReceivedWithoutDelta`: received for loss accounting only —
 *   no timing (do not confuse with `receivedAtMs === 0`).
 * - Small/Large delta: `receivedAtMs` is valid **including 0** (reference_time
 *   base may be zero in fixtures / early feedback).
 * - Synthetic test results may set `received` + `receivedAtMs` without status;
 *   treat a finite `receivedAtMs` as a timing sample in that case.
 */
export function hasTwccReceiveTiming(result: PacketResult): boolean {
  if (!result.received) return false;
  if (result.status === PacketStatus.TypeTCCPacketReceivedWithoutDelta) {
    return false;
  }
  if (
    result.status === PacketStatus.TypeTCCPacketReceivedSmallDelta ||
    result.status === PacketStatus.TypeTCCPacketReceivedLargeDelta
  ) {
    return Number.isFinite(result.receivedAtMs);
  }
  // Synthetic PacketResult used in unit tests (status left at NotReceived).
  return Number.isFinite(result.receivedAtMs);
}
