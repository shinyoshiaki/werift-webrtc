const width = 64; // bits / entries, must be multiple of INT_SIZE
const INT_SIZE = 32; // in JS, bitwise operators use 32-bit ints

/**
 * Provides protection against replay attacks by remembering received packets in a sliding window.
 *
 * Layout (bit 0 = oldest / lowerBound, bit 63 = ceiling):
 *   window[0] = bits 0..31, window[1] = bits 32..63
 */
export class AntiReplayWindow {
  private window: number[] = [];
  private ceiling = 0; // highest received seq_num (upper end of the window)

  constructor() {
    this.reset();
  }

  public reset(): void {
    this.window = [];
    for (let i = 0; i < width / INT_SIZE; i++) {
      this.window[i] = 0;
    }
    this.ceiling = width - 1;
  }

  /**
   * Checks if the packet with the given sequence number may be received.
   */
  public mayReceive(seq_num: number): boolean {
    // Accept any sequence above the ceiling (including large jumps).
    if (seq_num > this.ceiling) {
      return true;
    } else if (seq_num >= this.ceiling - width + 1 && seq_num <= this.ceiling) {
      return !this.hasReceived(seq_num);
    } else {
      // too old
      return false;
    }
  }

  /**
   * Checks if the packet with the given sequence number is marked as received.
   */
  public hasReceived(seq_num: number): boolean {
    const lowerBound = this.ceiling - width + 1;
    if (seq_num < lowerBound || seq_num > this.ceiling) {
      return false;
    }
    const bitIndex = seq_num - lowerBound;
    const windowIndex = Math.floor(bitIndex / INT_SIZE);
    const windowBit = bitIndex % INT_SIZE;
    const flag = 1 << windowBit;
    return (this.window[windowIndex] & flag) === flag;
  }

  /**
   * Marks the packet with the given sequence number as received.
   * Advances the sliding window when seq_num exceeds the current ceiling.
   *
   * JS note: `n >>> 32` is a no-op (shift count masked to 5 bits). Whole-word
   * shifts must not use a shift amount of 32.
   */
  public markAsReceived(seq_num: number): void {
    if (seq_num > this.ceiling) {
      const amount = seq_num - this.ceiling;
      this.shiftWindow(amount);
      this.ceiling = seq_num;
    }
    const lowerBound = this.ceiling - width + 1;
    if (seq_num < lowerBound) {
      // Seq fell out of the window after a huge jump — nothing to mark
      return;
    }
    const bitIndex = seq_num - lowerBound;
    const windowIndex = Math.floor(bitIndex / INT_SIZE);
    const windowBit = bitIndex % INT_SIZE;
    const flag = 1 << windowBit;
    this.window[windowIndex] |= flag;
  }

  /**
   * Shift bitmap toward older indices by `amount` bits (discard old, free high end).
   * window[0] is the older half; window[1] is the newer half near ceiling.
   */
  private shiftWindow(amount: number): void {
    if (amount <= 0) return;
    if (amount >= width) {
      this.window[0] = 0;
      this.window[1] = 0;
      return;
    }
    // Whole 32-bit words first (never use >>> 32 — it's a no-op in JS)
    while (amount >= INT_SIZE) {
      this.window[0] = this.window[1] >>> 0;
      this.window[1] = 0;
      amount -= INT_SIZE;
    }
    if (amount === 0) return;
    // 0 < amount < 32: right-shift the 64-bit value (low=window[0], high=window[1])
    const new0 =
      ((this.window[0] >>> amount) |
        (this.window[1] << (INT_SIZE - amount))) >>>
      0;
    const new1 = (this.window[1] >>> amount) >>> 0;
    this.window[0] = new0;
    this.window[1] = new1;
  }
}
