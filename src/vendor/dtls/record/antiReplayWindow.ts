const width = 64; // bits / entries, must be multiple of INT_SIZE
const INT_SIZE = 32; // in JS, bitwise operators use 32bit ints

/**
 * Provides protection against replay attacks by remembering received packets in a sliding window
 */
export class AntiReplayWindow {
  // window bitmap looks as follows:
  //  v- upper end                    lower end --v
  // [111011 ... window_n]...[11111101 ... window_0]
  private window: number[] = [];
  private ceiling: number = 0; // upper end of the window bitmap / highest received seq_num

  constructor() {
    this.reset();
  }
  /**
   * Initializes the anti replay window to its default state
   */
  public reset(): void {
    this.window = [];
    for (let i = 0; i < width / INT_SIZE; i++) {
      this.window[i] = 0;
    }
    this.ceiling = width - 1;
  }

  /**
   * Checks if the packet with the given sequence number may be received or has to be discarded
   * @param seq_num - The sequence number of the packet to be checked
   */
  public mayReceive(seq_num: number): boolean {
    if (seq_num > this.ceiling + width) {
      // we skipped a lot of packets... I don't think we should accept
      return false;
    } else if (seq_num > this.ceiling) {
      // always accept new packets
      return true;
    } else if (seq_num >= this.ceiling - width + 1 && seq_num <= this.ceiling) {
      // packet falls within the window, check if it was received already.
      // if so, don't accept
      return !this.hasReceived(seq_num);
    } /* seq_num <= this.ceiling - width */ else {
      // too old, don't accept
      return false;
    }
  }

  /**
   * Checks if the packet with the given sequence number is marked as received
   * @param seq_num - The sequence number of the packet to be checked
   */
  public hasReceived(seq_num: number): boolean {
    // check if the packet was received already
    const lowerBound = this.ceiling - width + 1;
    // find out where the bit is located
    const bitIndex = seq_num - lowerBound;
    const windowIndex = Math.floor(bitIndex / INT_SIZE);
    const windowBit = bitIndex % INT_SIZE;
    const flag = 1 << windowBit;
    // check if it is set;
    return (this.window[windowIndex] & flag) === flag;
  }

  /**
   * Marks the packet with the given sequence number as received
   * @param seq_num - The sequence number of the packet
   */
  public markAsReceived(seq_num: number): void {
    if (seq_num > this.ceiling) {
      // shift the window
      let amount = seq_num - this.ceiling;
      // first shift whole blocks
      while (amount > INT_SIZE) {
        for (let i = 1; i < this.window.length; i++) {
          this.window[i - 1] = this.window[i];
        }
        this.window[this.window.length - 1] = 0;
        amount -= INT_SIZE;
      }
      // now shift bitwise (to the right)
      let overflow = 0;
      for (let i = 0; i < this.window.length; i++) {
        overflow = this.window[i] << (INT_SIZE - amount); // BBBBBBAA => AA000000
        this.window[i] = this.window[i] >>> amount; // BBBBBBAA ==> 00BBBBBB
        if (i > 0) this.window[i - 1] |= overflow;
      }
      // and remember the new ceiling
      this.ceiling = seq_num;
    }
    const lowerBound = this.ceiling - width + 1;

    // find out where the bit is located
    const bitIndex = seq_num - lowerBound;
    const windowIndex = Math.floor(bitIndex / INT_SIZE);
    const windowBit = bitIndex % INT_SIZE;
    const flag = 1 << windowBit;
    // and set it
    this.window[windowIndex] |= flag;
  }
}
