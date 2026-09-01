/**
 * Package-private Binding Response replay cache for SPED handshake.
 * Not re-exported from `src/index.ts`.
 *
 * Exact Response bytes must be replayed for STUN retransmits (same transaction
 * id) so L1 round-robin does not change the payload. Entries are TTL'd to the
 * STUN transaction lifetime, LRU-capped, and only stored while SPED is
 * embedding.
 */

export const SPED_BINDING_RESPONSE_CACHE_MAX = 32;

type CacheEntry = {
  bytes: Buffer;
  expiresAt: number;
};

type InFlightSlot = {
  promise: Promise<Buffer | undefined>;
  settle: (bytes: Buffer | undefined) => void;
};

export class SpedBindingResponseCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightSlot>();

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  get(txHex: string, now = Date.now()): Buffer | undefined {
    this.prune(now);
    const entry = this.entries.get(txHex);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(txHex);
    this.entries.set(txHex, entry);
    return entry.bytes;
  }

  set(txHex: string, bytes: Buffer, ttlMs: number, now = Date.now()): void {
    this.prune(now);
    this.entries.delete(txHex);
    this.entries.set(txHex, { bytes, expiresAt: now + ttlMs });
    this.evictOverflow();
  }

  clearEntries(): void {
    this.entries.clear();
  }

  clear(): void {
    this.clearEntries();
    this.abortInFlight();
  }

  prune(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  getInFlight(txHex: string): Promise<Buffer | undefined> | undefined {
    return this.inFlight.get(txHex)?.promise;
  }

  begin(txHex: string): {
    promise: Promise<Buffer | undefined>;
    finish: (bytes: Buffer | undefined) => void;
  } {
    let settle!: (bytes: Buffer | undefined) => void;
    const promise = new Promise<Buffer | undefined>((resolve) => {
      settle = resolve;
    });
    const slot: InFlightSlot = { promise, settle };
    this.inFlight.set(txHex, slot);
    return {
      promise,
      finish: (bytes) => {
        if (this.inFlight.get(txHex) !== slot) {
          return;
        }
        this.inFlight.delete(txHex);
        settle(bytes);
      },
    };
  }

  abortInFlight(): void {
    const pending = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const slot of pending) {
      slot.settle(undefined);
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > SPED_BINDING_RESPONSE_CACHE_MAX) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}
