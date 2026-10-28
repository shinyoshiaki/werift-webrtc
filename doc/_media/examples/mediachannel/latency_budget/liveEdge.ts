// How late a packet is, judged on the media clock: the delay of the best
// packet seen so far (smallest arrival time minus RTP time) is the baseline,
// and a packet's lag is how much later than that baseline it is *now*.
//
// Using the newest RTP packet as the reference would be wrong in two ways: it
// keeps a recovered packet's lag at ~20ms when the upstream went quiet, and it
// moves the reference back when a newer packet itself arrives late.

const RTP_TICKS_PER_MS = 48;

export class LiveEdge {
  private baseTimestamp?: number;
  /** min over packets of (arrival ms - RTP ms since the first packet) */
  private baseline = 0;

  /** A new publisher has its own timestamp base. */
  reset() {
    this.baseTimestamp = undefined;
  }

  /** RTP time in ms since the first packet (signed 32bit wrap: ~12h range) */
  private rtpMs(timestamp: number) {
    return ((timestamp - this.baseTimestamp!) | 0) / RTP_TICKS_PER_MS;
  }

  /** Call for every received packet. */
  update(timestamp: number, now = Date.now()) {
    if (this.baseTimestamp === undefined) {
      this.baseTimestamp = timestamp;
      this.baseline = now;
      return;
    }
    this.baseline = Math.min(this.baseline, now - this.rtpMs(timestamp));
  }

  /** ms the packet is behind the best-case playout of its RTP time at `now` */
  lagMs(timestamp: number, now = Date.now()) {
    if (this.baseTimestamp === undefined) return 0;
    return Math.max(0, now - this.rtpMs(timestamp) - this.baseline);
  }
}
