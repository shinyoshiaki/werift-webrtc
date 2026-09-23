export interface EarlyDataBufferStats {
  bufferedPackets: number;
  bufferedBytes: number;
  droppedPackets: number;
  droppedBytes: number;
}

/** Ordered, bounded pre-authentication buffer with fail-closed expiry. */
export class EarlyDataBuffer {
  private entries: { data: Buffer; receivedAt: number }[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private droppedPackets = 0;
  private droppedBytes = 0;

  constructor(
    readonly maxPackets: number,
    readonly maxBytes: number,
    readonly retentionMs = 2_000,
  ) {}

  get packets(): readonly Buffer[] {
    return this.entries.map(({ data }) => data);
  }

  get bytes(): number {
    return this.entries.reduce((total, { data }) => total + data.length, 0);
  }

  push(data: Buffer, now = Date.now()): boolean {
    if (this.disposed) return false;
    this.expire(now);
    if (
      this.entries.length >= this.maxPackets ||
      this.bytes + data.length > this.maxBytes
    ) {
      this.droppedPackets++;
      this.droppedBytes += data.length;
      return false;
    }
    this.entries.push({ data: Buffer.from(data), receivedAt: now });
    this.armTimer();
    return true;
  }

  drain(now = Date.now()): Buffer[] {
    this.expire(now);
    const result = this.entries.map(({ data }) => data);
    this.clearEntries();
    return result;
  }

  /**
   * Remove one oldest entry while retaining the rest of the queue.
   *
   * A generation check can run between two application callbacks.  Taking
   * records one at a time lets the caller discard the remaining entries and
   * account them as dropped when that check fails.
   */
  takeOne(now = Date.now()): Buffer | undefined {
    this.expire(now);
    const entry = this.entries.shift();
    if (!entry) {
      this.clearEntries();
      return undefined;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.armTimer();
    return entry.data;
  }

  clear(countAsDropped = false): void {
    if (countAsDropped) {
      this.droppedPackets += this.entries.length;
      this.droppedBytes += this.bytes;
    }
    this.clearEntries();
  }

  reset(): void {
    this.clearEntries();
    this.droppedPackets = 0;
    this.droppedBytes = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.clearEntries();
  }

  snapshot(): EarlyDataBufferStats {
    return {
      bufferedPackets: this.entries.length,
      bufferedBytes: this.bytes,
      droppedPackets: this.droppedPackets,
      droppedBytes: this.droppedBytes,
    };
  }

  private expire(now: number): void {
    const head = this.entries[0];
    if (!head || now - head.receivedAt < this.retentionMs) return;
    this.droppedPackets += this.entries.length;
    this.droppedBytes += this.bytes;
    this.clearEntries();
  }

  private armTimer(): void {
    if (this.timer || this.entries.length === 0) return;
    const delay = Math.max(
      0,
      this.retentionMs - (Date.now() - this.entries[0]!.receivedAt),
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.disposed) this.expire(Date.now());
    }, delay);
    this.timer.unref?.();
  }

  private clearEntries(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.entries = [];
  }
}
