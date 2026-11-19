import { debug } from "../../imports/common";
import { FragmentedHandshake } from "./fragment";

const err = debug(
  "werift-dtls : packages/dtls/src/record/message/reassembler.ts : err",
);

/**
 * Limits on the bytes buffered from untrusted handshake fragments.
 * Spec: `tests/record/message/reassembler.test.ts` › "limits".
 */
export interface HandshakeReassemblerLimits {
  /** Spec: "drops a fragment of a message longer than maxMessageLength" */
  maxMessageLength: number;
  /** Spec: "keeps at most maxEntries partial messages" */
  maxEntries: number;
  /**
   * Spec: "keeps at most maxBufferedBytes of partial messages",
   * "drops a message longer than maxBufferedBytes on its own"
   */
  maxBufferedBytes: number;
  /** Spec: "discards a message split into more than maxRangesPerMessage ranges" */
  maxRangesPerMessage: number;
  /**
   * Spec: "discards a partial message not updated for entryLifetimeMs",
   * "evaluates entryLifetimeMs only when the next fragment is added, not on a timer"
   */
  entryLifetimeMs: number;
}

export interface HandshakeReassemblerOptions
  extends Partial<HandshakeReassemblerLimits> {
  /** Clock (ms) for `entryLifetimeMs`. */
  now?: () => number;
}

interface Entry {
  msg_type: number;
  message_seq: number;
  buffer: Buffer;
  /**
   * Received byte ranges `[start, end)`. Spec: "merges adjacent and
   * overlapping ranges, so contiguous fragments count as one range"
   */
  ranges: [number, number][];
  updatedAt: number;
}

/**
 * Reassembles fragmented DTLS 1.2 handshake messages (RFC 6347 §4.2.3).
 * Spec: `tests/record/message/reassembler.test.ts`; invalid fragments are
 * dropped without an alert (RFC 6347 §4.1.2.1), spec: `tests/server.test.ts`
 * › "drops invalid and inconsistent handshake fragments without an alert".
 */
export class HandshakeReassembler {
  static MaxMessageLength = 0x10000;
  static MaxEntries = 16;
  static MaxBufferedBytes = 0x40000;
  static MaxRangesPerMessage = 256;
  static EntryLifetimeMs = 60_000;

  private readonly limits: HandshakeReassemblerLimits;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private buffered = 0;

  constructor(options: HandshakeReassemblerOptions = {}) {
    this.limits = {
      maxMessageLength:
        options.maxMessageLength ?? HandshakeReassembler.MaxMessageLength,
      maxEntries: options.maxEntries ?? HandshakeReassembler.MaxEntries,
      maxBufferedBytes:
        options.maxBufferedBytes ?? HandshakeReassembler.MaxBufferedBytes,
      maxRangesPerMessage:
        options.maxRangesPerMessage ?? HandshakeReassembler.MaxRangesPerMessage,
      entryLifetimeMs:
        options.entryLifetimeMs ?? HandshakeReassembler.EntryLifetimeMs,
    };
    this.now = options.now ?? Date.now;
  }

  /** Partially received messages currently buffered. */
  get size() {
    return this.entries.size;
  }

  /** Bytes currently allocated for partially received messages. */
  get bufferedBytes() {
    return this.buffered;
  }

  /** Spec: "clear() discards every partial message" */
  clear() {
    this.entries.clear();
    this.buffered = 0;
  }

  /**
   * Add one handshake fragment received in a record of `epoch`; returns the
   * message it completes, if any. Spec: "delivers a message only once every
   * byte was received, as one fragment at offset 0", "keeps messages of
   * distinct sequence, type and length apart", "keeps fragments of distinct
   * epochs apart"
   */
  add(
    fragment: FragmentedHandshake,
    epoch = 0,
  ): FragmentedHandshake | undefined {
    const now = this.now();
    this.expire(now);

    const { msg_type, length, message_seq, fragment_offset, fragment_length } =
      fragment;
    const key = `${epoch}:${msg_type}:${message_seq}:${length}`;

    if (fragment.fragment.length !== fragment_length) {
      err("drop a truncated handshake fragment", {
        key,
        fragment_length,
        actual: fragment.fragment.length,
      });
      return;
    }
    if (fragment_offset + fragment_length > length) {
      err("drop a handshake fragment beyond its message length", {
        key,
        fragment_offset,
        fragment_length,
      });
      return;
    }

    // Spec: "delivers an unfragmented message, and each retransmission of it, as is"
    if (fragment_offset === 0 && fragment_length === length) {
      this.delete(key);
      return fragment;
    }

    if (length > this.limits.maxMessageLength) {
      err("drop a handshake fragment over the message length limit", {
        key,
        limit: this.limits.maxMessageLength,
      });
      return;
    }
    // Spec: "ignores an empty fragment"
    if (fragment_length === 0) return;

    let entry = this.entries.get(key);
    if (!entry) {
      if (length > this.limits.maxBufferedBytes) {
        err("drop a handshake fragment over the buffer limit", { key });
        return;
      }
      while (
        this.entries.size > 0 &&
        (this.entries.size >= this.limits.maxEntries ||
          this.buffered + length > this.limits.maxBufferedBytes)
      ) {
        this.evictOldest();
      }
      entry = {
        msg_type,
        message_seq,
        buffer: Buffer.alloc(length),
        ranges: [],
        updatedAt: now,
      };
      this.entries.set(key, entry);
      this.buffered += length;
    }

    const start = fragment_offset;
    const end = fragment_offset + fragment_length;

    // Spec: "discards a partial message whose already received bytes would change"
    for (const [rangeStart, rangeEnd] of entry.ranges) {
      if (rangeEnd <= start) continue;
      if (rangeStart >= end) break;
      const overlapStart = Math.max(start, rangeStart);
      const overlapEnd = Math.min(end, rangeEnd);
      const received = entry.buffer.subarray(overlapStart, overlapEnd);
      const incoming = fragment.fragment.subarray(
        overlapStart - start,
        overlapEnd - start,
      );
      if (!received.equals(incoming)) {
        err("discard a handshake message with inconsistent fragments", {
          key,
          overlapStart,
          overlapEnd,
        });
        this.delete(key);
        return;
      }
    }

    fragment.fragment.copy(entry.buffer, start);
    entry.ranges = mergeRange(entry.ranges, start, end);
    entry.updatedAt = now;

    if (entry.ranges.length > this.limits.maxRangesPerMessage) {
      err("discard a handshake message split into too many ranges", { key });
      this.delete(key);
      return;
    }

    const [first] = entry.ranges;
    if (entry.ranges.length === 1 && first[0] === 0 && first[1] === length) {
      this.delete(key);
      return new FragmentedHandshake(
        entry.msg_type,
        length,
        entry.message_seq,
        0,
        length,
        entry.buffer,
      );
    }
  }

  private delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.buffered -= entry.buffer.length;
  }

  private expire(now: number) {
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt > this.limits.entryLifetimeMs) {
        err("discard an expired partial handshake message", { key });
        this.delete(key);
      }
    }
  }

  private evictOldest() {
    let oldestKey: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.updatedAt < oldest) {
        oldest = entry.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      err("evict a partial handshake message", { key: oldestKey });
      this.delete(oldestKey);
    }
  }
}

/**
 * Insert `[start, end)` into the received ranges. Spec: "merges adjacent and
 * overlapping ranges, so contiguous fragments count as one range"
 */
const mergeRange = (
  ranges: [number, number][],
  start: number,
  end: number,
): [number, number][] => {
  const merged: [number, number][] = [];
  let inserted = false;
  for (const [rangeStart, rangeEnd] of ranges) {
    if (rangeEnd < start) {
      merged.push([rangeStart, rangeEnd]);
    } else if (rangeStart > end) {
      if (!inserted) {
        merged.push([start, end]);
        inserted = true;
      }
      merged.push([rangeStart, rangeEnd]);
    } else {
      start = Math.min(start, rangeStart);
      end = Math.max(end, rangeEnd);
    }
  }
  if (!inserted) merged.push([start, end]);
  return merged;
};
