// Extends wrapping RTP numbers (16bit sequence numbers, 32bit timestamps)
// into a counter that keeps growing. Each value is taken relative to the
// newest one seen so far, not to a fixed first value: comparing with a fixed
// start breaks once the stream is half the number space past it.

export class Unwrapper {
  private readonly modulo: number;
  private newest?: number;
  private newestExtended = 0;

  constructor(bits: 16 | 32) {
    this.modulo = 2 ** bits;
  }

  /** Extended value; the first one is 0. Newer values move the reference forward. */
  unwrap(value: number) {
    return this.extend(value, true);
  }

  /** Extended value without moving the reference (a query). */
  peek(value: number) {
    return this.extend(value, false);
  }

  private extend(value: number, update: boolean) {
    if (this.newest === undefined) {
      if (update) this.newest = value;
      return 0;
    }
    let diff = (value - this.newest) % this.modulo;
    if (diff < 0) diff += this.modulo;
    if (diff >= this.modulo / 2) diff -= this.modulo;
    const extended = this.newestExtended + diff;
    if (update && diff > 0) {
      this.newest = value;
      this.newestExtended = extended;
    }
    return extended;
  }
}
