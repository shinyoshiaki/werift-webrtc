// Opus decoder state depends on the previous frames, so frames must be fed to
// the decoder in sequence order. A hole is waited for (a retransmission may
// still fill it) until `isWaiting` says to give up; frames behind the decode
// point afterwards are dropped, never decoded out of order.

const behind = (seq: number, next: number) => ((seq - next) & 0xffff) >= 0x8000;

export class DecodeOrder<T> {
  private next?: number;
  private readonly held = new Map<number, T>();

  /** @param isWaiting whether a missing seq may still be recovered */
  constructor(private readonly isWaiting: (seq: number) => boolean) {}

  get heldFrames() {
    return this.held.size;
  }

  /** Frames now ready to decode, in order. `late` when it can no longer be decoded. */
  push(seq: number, item: T): { ready: T[]; late: boolean } {
    this.next ??= seq;
    if (behind(seq, this.next)) {
      return { ready: [], late: true };
    }
    this.held.set(seq, item);
    return { ready: this.release(), late: false };
  }

  /** Call again when a wait ended (a deadline passed or a hole was given up). */
  release(): T[] {
    const ready: T[] = [];
    while (this.held.size > 0 && this.next !== undefined) {
      const item = this.held.get(this.next);
      if (item !== undefined) {
        this.held.delete(this.next);
        ready.push(item);
      } else if (this.isWaiting(this.next)) {
        break;
      }
      this.next = (this.next + 1) & 0xffff;
    }
    return ready;
  }

  clear() {
    this.held.clear();
    this.next = undefined;
  }
}
