import { debug } from "../../imports/common";
import { FragmentedHandshake } from "./fragment";

const err = debug(
  "werift-dtls : packages/dtls/src/record/message/reassembler.ts : err",
);

/** Limits that bound the bytes buffered from untrusted handshake fragments. */
export interface HandshakeReassemblerLimits {
  /** Largest declared handshake message `length` that is reassembled. */
  maxMessageLength: number;
  /** Partially received messages kept at the same time. */
  maxEntries: number;
  /** Total bytes allocated for partially received messages. */
  maxBufferedBytes: number;
  /** Disjoint received byte ranges kept per message. */
  maxRangesPerMessage: number;
  /** A partial message not updated for this long (ms) is discarded. */
  entryLifetimeMs: number;
}

export interface HandshakeReassemblerOptions
  extends Partial<HandshakeReassemblerLimits> {
  /** Clock (ms) used for the entry lifetime; injectable for tests. */
  now?: () => number;
}

interface Entry {
  msg_type: number;
  message_seq: number;
  buffer: Buffer;
  /** Sorted, merged, disjoint received byte ranges `[start, end)`. */
  ranges: [number, number][];
  updatedAt: number;
}

/**
 * Reassembles fragmented DTLS 1.2 handshake messages (RFC 6347 §4.2.3).
 *
 * Fragments are grouped by `(epoch, msg_type, message_seq, length)` and a
 * message is returned only once every byte of `[0, length)` was received,
 * whatever the order of arrival. Duplicate and overlapping fragments (a
 * retransmission, possibly split at other boundaries) are accepted when the
 * overlapping bytes match; a mismatch discards the partial message. Invalid
 * fragments and fragments over the limits are discarded silently (RFC 6347
 * §4.1.2.1) and logged: no alert is sent, so an injected datagram cannot
 * end the connection.
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

  /** Discard every partially received message. */
  clear() {
    this.entries.clear();
    this.buffered = 0;
  }

  /**
   * Add one received handshake fragment of the record `epoch`. Returns the
   * complete message (a single fragment with `fragment_offset = 0` and
   * `fragment_length = length`) when this fragment completed it, or the
   * fragment itself when it is an unfragmented message; otherwise undefined.
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

    // Unfragmented message: delivered as is (a retransmission is delivered
    // again, the flights answer it).
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
    // An empty fragment adds nothing.
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

    // Bytes already received must not change.
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

/** Insert `[start, end)` into sorted disjoint ranges, merging touching ones. */
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
