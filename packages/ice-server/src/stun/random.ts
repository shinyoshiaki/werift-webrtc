import { randomFill, randomFillSync } from "crypto";

import { debug } from "../../../common/src";

const log = debug("werift-ice-server : packages/ice-server/src/stun/random.ts");

/** Cryptographically secure random bytes for STUN / TURN / ICE. */
export interface RandomSource {
  /** Returns `length` cryptographically secure random bytes synchronously. */
  bytes(length: number): Buffer;
}

/**
 * Serves bytes from a pool refilled asynchronously by `crypto.randomFill`
 * (libuv threadpool), so a synchronous caller does not wait for the CSPRNG
 * while the pool has enough bytes. When it does not (first use, a refill
 * still running or failed) the bytes are drawn by `randomFillSync` and a
 * refill is scheduled. Bytes handed out are zeroed in the pool and never
 * served twice.
 */
export class PooledRandomSource implements RandomSource {
  private pool?: Buffer;
  private offset = 0;
  private refilling = false;

  constructor(
    private readonly size = 512,
    private readonly lowWaterMark = 128,
    private readonly fill: typeof randomFill = randomFill,
    private readonly fillSync: typeof randomFillSync = randomFillSync,
  ) {}

  /** Bytes still available without a synchronous draw. */
  get available() {
    return this.pool ? this.pool.length - this.offset : 0;
  }

  bytes(length: number): Buffer {
    const pool = this.pool;
    if (!pool || this.available < length) {
      this.refill();
      return this.fillSync(Buffer.alloc(length));
    }

    const start = this.offset;
    const end = start + length;
    const bytes = Buffer.from(pool.subarray(start, end));
    pool.fill(0, start, end);
    this.offset = end;
    if (this.available < this.lowWaterMark) {
      this.refill();
    }
    return bytes;
  }

  /** Starts one asynchronous refill unless one is already running. */
  refill() {
    if (this.refilling) {
      return;
    }
    this.refilling = true;
    this.fill(Buffer.alloc(this.size), (error, filled) => {
      this.refilling = false;
      // The remaining bytes of the replaced pool are never served.
      this.pool?.fill(0);
      this.pool = undefined;
      this.offset = 0;
      if (error) {
        // Callers fall back to randomFillSync; the next draw retries.
        log("random pool refill failed", error);
        return;
      }
      this.pool = filled;
    });
  }
}

const defaultRandomSource = new PooledRandomSource();
defaultRandomSource.refill();

let randomSource: RandomSource = defaultRandomSource;

/**
 * Replaces the random source (tests inject delays or failures).
 * Without an argument the default pooled source is restored.
 * @internal
 */
export function setRandomSource(source: RandomSource = defaultRandomSource) {
  randomSource = source;
}

/** @internal */
export function getRandomSource(): RandomSource {
  return randomSource;
}

/** `length` cryptographically secure random bytes from the current source. */
export function secureRandomBytes(length: number): Buffer {
  const bytes = randomSource.bytes(length);
  if (bytes.length !== length) {
    throw new RangeError(
      `random source returned ${bytes.length} bytes, expected ${length}`,
    );
  }
  return bytes;
}

/** 96-bit STUN transaction ID (RFC 8489 §5). */
export function randomTransactionId(): Buffer {
  return secureRandomBytes(12);
}
