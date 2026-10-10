/**
 * RFC 3711 §3.3.2 receiver replay list: a sliding window over the packet
 * index (SRTP: ROC * 2^16 + SEQ, SRTCP: the 31-bit SRTCP index).
 *
 * `check()` runs before the packet is accepted and `accept()` only after it
 * authenticated, so a forged packet cannot advance or poison the window.
 */
export class SrtpReplayWindow {
  private highest = -1;
  /** Bit i set = index (highest - i) was received. */
  private received = 0n;
  private readonly sizeMask: bigint;

  constructor(readonly size = 64) {
    this.sizeMask = (1n << BigInt(size)) - 1n;
  }

  /** True when `index` is neither a replay nor older than the window. */
  check(index: number): boolean {
    if (this.highest < 0 || index > this.highest) return true;
    const delta = this.highest - index;
    if (delta >= this.size) return false;
    return ((this.received >> BigInt(delta)) & 1n) === 0n;
  }

  /** Record an authenticated `index`. */
  accept(index: number): void {
    if (this.highest < 0) {
      this.highest = index;
      this.received = 1n;
      return;
    }
    if (index > this.highest) {
      const shift = index - this.highest;
      this.received =
        shift >= this.size
          ? 1n
          : ((this.received << BigInt(shift)) | 1n) & this.sizeMask;
      this.highest = index;
      return;
    }
    this.received |= 1n << BigInt(this.highest - index);
  }
}
