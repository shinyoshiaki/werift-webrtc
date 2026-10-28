// How late a packet is, judged on the media clock: the delay of the best
// packet seen so far (smallest arrival time minus RTP time) is the baseline,
// and a packet's lag is how much later than that baseline it is *now*.
//
// Using the newest RTP packet as the reference would be wrong in two ways: it
// keeps a recovered packet's lag at ~20ms when the upstream went quiet, and it
// moves the reference back when a newer packet itself arrives late.

import { Unwrapper } from "./unwrap";

const RTP_TICKS_PER_MS = 48;

export class LiveEdge {
  private timestamps = new Unwrapper(32);
  private started = false;
  /** min over packets of (arrival ms - RTP ms since the first packet) */
  private baseline = 0;

  /** A new publisher has its own timestamp base. */
  reset() {
    this.timestamps = new Unwrapper(32);
    this.started = false;
  }

  /** RTP time in ms since the first packet, extended past the 32bit wrap */
  private rtpMs(timestamp: number, update: boolean) {
    const ticks = update
      ? this.timestamps.unwrap(timestamp)
      : this.timestamps.peek(timestamp);
    return ticks / RTP_TICKS_PER_MS;
  }

  /** Call for every received packet. */
  update(timestamp: number, now = Date.now()) {
    if (!this.started) {
      this.started = true;
      this.timestamps.unwrap(timestamp);
      this.baseline = now;
      return;
    }
    this.baseline = Math.min(this.baseline, now - this.rtpMs(timestamp, true));
  }

  /** ms the packet is behind the best-case playout of its RTP time at `now` */
  lagMs(timestamp: number, now = Date.now()) {
    if (!this.started) return 0;
    return Math.max(0, now - this.rtpMs(timestamp, false) - this.baseline);
  }
}
