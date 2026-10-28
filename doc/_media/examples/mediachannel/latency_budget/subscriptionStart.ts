// Where a relayed subscription starts, and which upstream packets belong to
// it. The first packet relayed is the start; a packet older than that (an
// upstream retransmission of something sent before the subscription) is not
// relayed. Sequence numbers are extended (unwrap.ts), so "older" stays right
// however long the subscription runs.
import { Unwrapper } from "./unwrap";

export type RelayDecision = "start" | "relay" | "before";

export class SubscriptionStart {
  private readonly seqs = new Unwrapper(16);
  private startExtended?: number;
  /** The first packet relayed */
  start?: { sequenceNumber: number; rtpTimestamp: number };

  /**
   * @param upstreamNewest the newest upstream sequence number, before the
   *   start: a recovered older packet must not become the start.
   */
  accept(
    sequenceNumber: number,
    rtpTimestamp: number,
    upstreamNewest?: number,
  ): RelayDecision {
    if (this.startExtended === undefined) {
      if (
        upstreamNewest !== undefined &&
        ((upstreamNewest - sequenceNumber) & 0xffff) !== 0 &&
        ((upstreamNewest - sequenceNumber) & 0xffff) < 0x8000
      ) {
        return "before";
      }
      this.startExtended = this.seqs.unwrap(sequenceNumber);
      this.start = { sequenceNumber, rtpTimestamp };
      return "start";
    }
    return this.seqs.unwrap(sequenceNumber) < this.startExtended
      ? "before"
      : "relay";
  }
}
