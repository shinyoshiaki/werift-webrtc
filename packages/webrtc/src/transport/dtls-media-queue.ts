import {
  createPreAuthEarlyDataBuffer,
  type EarlyDataBuffer,
} from "../../../dtls/src/internal";

/**
 * @internal Encrypted RTP / RTCP that arrived before the SDP fingerprint
 * matched. Nothing is decrypted or delivered until authentication; then
 * {@link PreAuthMediaQueue.drain} hands it on. With the `"drop"` policy the
 * queue keeps nothing and only counts what it dropped.
 *
 * Each ICE generation owns its own buffer and retention timer
 * ({@link PreAuthMediaQueue.renew}); drop statistics survive the replacement.
 */
export class PreAuthMediaQueue {
  /** Buffer of the current generation; replaced by {@link renew}. */
  private buffer: EarlyDataBuffer;
  private retiredDroppedPackets = 0;
  private retiredDroppedBytes = 0;

  constructor(buffering: boolean) {
    this.buffer = createPreAuthEarlyDataBuffer({ enabled: buffering });
  }

  push(data: Buffer): void {
    this.buffer.push(data);
  }

  /** Stats of the current buffer plus everything earlier buffers dropped. */
  snapshot() {
    const current = this.buffer.snapshot();
    return {
      ...current,
      droppedPackets: current.droppedPackets + this.retiredDroppedPackets,
      droppedBytes: current.droppedBytes + this.retiredDroppedBytes,
    };
  }

  /**
   * Hand the queued packets to `deliver` in order while `canContinue()`
   * holds; it is checked before and after every packet, so a close / restart
   * inside `deliver` drops (and counts) the rest.
   */
  drain(deliver: (data: Buffer) => void, canContinue: () => boolean): void {
    const buffer = this.buffer;
    while (true) {
      if (!canContinue()) {
        buffer.clear(true);
        return;
      }
      const data = buffer.takeOne();
      if (!data) return;
      deliver(data);
      if (!canContinue()) {
        buffer.clear(true);
        return;
      }
    }
  }

  /** Drop (and count) what is queued; the buffer stays usable. */
  discard(): void {
    this.buffer.clear(true);
  }

  /** Drop what is queued and stop the retention timer for good (close / failure). */
  close(): void {
    this.buffer.clear(true);
    this.buffer.dispose();
  }

  /**
   * Hand the queue to a new ICE generation or policy: the old buffer is
   * dropped and disposed (its retention timer cannot fire later), its drop
   * count is kept, and an empty buffer with `buffering` takes its place.
   */
  renew(buffering: boolean): void {
    this.buffer.clear(true);
    const stats = this.buffer.snapshot();
    this.retiredDroppedPackets += stats.droppedPackets;
    this.retiredDroppedBytes += stats.droppedBytes;
    this.buffer.dispose();
    this.buffer = createPreAuthEarlyDataBuffer({ enabled: buffering });
  }
}
