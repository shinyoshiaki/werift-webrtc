// The live edge of the upstream media clock, advanced by wall time while no
// RTP arrives. Comparing a recovered packet only with the newest RTP would
// keep its lag at ~20ms when the upstream stops and the retransmission is the
// next packet to arrive.

const RTP_TICKS_PER_MS = 48;

export class LiveEdge {
  private timestamp?: number;
  private at = 0;

  /** A new publisher has its own timestamp base. */
  reset() {
    this.timestamp = undefined;
  }

  /** Call for every received packet. Only a newer timestamp moves the edge. */
  update(timestamp: number, now = Date.now()) {
    if (
      this.timestamp === undefined ||
      ((timestamp - this.timestamp) | 0) > 0
    ) {
      this.timestamp = timestamp;
      this.at = now;
    }
  }

  /** ms the packet is behind the live edge, including wall time since the edge moved */
  lagMs(timestamp: number, now = Date.now()) {
    if (this.timestamp === undefined) return 0;
    const media = ((this.timestamp - timestamp) | 0) / RTP_TICKS_PER_MS;
    return Math.max(0, media + (now - this.at));
  }
}
