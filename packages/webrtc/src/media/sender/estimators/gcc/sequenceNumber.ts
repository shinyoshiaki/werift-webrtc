/*!
 * Portions of this file are ported from libwebrtc
 * (https://webrtc.googlesource.com/src, commit 0fda16159e33adf59c71a7ad1173dcbe5a632102).
 * Copyright (c) 2011, The WebRTC project authors. All rights reserved.
 * Use of that source is governed by a BSD-style license and an additional
 * patent grant; both are reproduced in THIRD_PARTY_LICENSES_LIBWEBRTC.txt
 * (shipped with this package).
 */
import { uint16Gt } from "../../../../imports/common";

/** 16-bit transport-wide sequence modulus. */
export const TWCC_SEQ_MOD = 0x10000;

/**
 * pin `rtc_base/numerics/sequence_number_unwrapper.h` `SeqNumUnwrapper<uint16_t>`.
 *
 * Transport-wide CC on the wire is 16-bit. History / probe maps must key by the
 * unwrapped (extended) sequence so a wrap does not overwrite the previous
 * generation still inside the send-time window.
 *
 * Values `> 0xffff` are treated as already-unwrapped (tests / callers that
 * already advanced a generation, e.g. `wideSeq=65537`).
 */
export class TransportWideSeqUnwrapper {
  private lastUnwrapped: number | undefined;

  reset() {
    this.lastUnwrapped = undefined;
  }

  /** Last extended sequence, or `undefined` before the first unwrap. */
  get last(): number | undefined {
    return this.lastUnwrapped;
  }

  /**
   * Map a 16-bit (or already-extended) sequence to a monotonic int and
   * remember it as the unwrap origin.
   */
  unwrap(seq: number): number {
    const next = this.peek(seq);
    this.lastUnwrapped = next;
    return next;
  }

  /**
   * Map a **send-time** TSN onto a monotonic key.
   *
   * Wire TSN only increases. A jump larger than half the 16-bit space is a
   * gap (other BUNDLE senders while this one was idle), not wrap-back.
   * {@link peek} still uses the half-modulus rule for 16-bit feedback.
   */
  advanceSent(seq: number): number {
    if (!Number.isFinite(seq)) return this.lastUnwrapped ?? 0;
    const raw = Math.trunc(seq);
    if (this.lastUnwrapped === undefined) {
      this.lastUnwrapped = raw > 0xffff ? raw : raw & 0xffff;
      return this.lastUnwrapped;
    }
    if (raw > 0xffff) {
      this.lastUnwrapped = Math.max(this.lastUnwrapped, raw);
      return raw;
    }
    const seq16 = raw & 0xffff;
    const last16 = this.lastUnwrapped & 0xffff;
    let forward = seq16 - last16;
    if (forward < 0) forward += TWCC_SEQ_MOD;
    if (forward === 0) return this.lastUnwrapped;
    this.lastUnwrapped = this.lastUnwrapped + forward;
    return this.lastUnwrapped;
  }

  /**
   * Same mapping as {@link unwrap} without updating the origin.
   * Used when matching TWCC 16-bit feedback against already-sent history.
   */
  peek(seq: number): number {
    if (!Number.isFinite(seq)) return this.lastUnwrapped ?? 0;
    const raw = Math.trunc(seq);
    if (raw > 0xffff) {
      return raw;
    }
    const seq16 = raw & 0xffff;
    if (this.lastUnwrapped === undefined) {
      return seq16;
    }
    const last16 = this.lastUnwrapped & 0xffff;
    let delta = seq16 - last16;
    if (delta > 0x8000) delta -= TWCC_SEQ_MOD;
    else if (delta < -0x8000) delta += TWCC_SEQ_MOD;
    return this.lastUnwrapped + delta;
  }
}

/**
 * Compare two transport-wide sequence numbers with wrap-around awareness.
 * @returns negative if a is before b, positive if a is after b, 0 if equal.
 */
export function compareTransportWideSeq(a: number, b: number): number {
  const a16 = a & 0xffff;
  const b16 = b & 0xffff;
  if (a16 === b16) return 0;
  return uint16Gt(a16, b16) ? 1 : -1;
}

/**
 * Sort TWCC packet results into send-order with wrap-around safety.
 *
 * Chooses the origin that minimises the covered span (largest gap between
 * consecutive sequences, including wrap), so a window like
 * `{0, 1, 65534, 65535}` sorts as `65534, 65535, 0, 1` rather than numeric order.
 */
export function sortPacketResultsByWideSeq<
  T extends { sequenceNumber: number },
>(results: T[]): T[] {
  if (results.length <= 1) return [...results];

  const unique = [
    ...new Set(results.map((r) => r.sequenceNumber & 0xffff)),
  ].sort((a, b) => a - b);

  // Largest gap between consecutive unique seqs (circular) → base is after that gap.
  let maxGap = -1;
  let origin = unique[0];
  for (let i = 0; i < unique.length; i++) {
    const a = unique[i];
    const b = unique[(i + 1) % unique.length];
    const gap = i === unique.length - 1 ? b + TWCC_SEQ_MOD - a : b - a;
    if (gap > maxGap) {
      maxGap = gap;
      origin = b;
    }
  }

  return [...results].sort((a, b) => {
    const da =
      ((a.sequenceNumber & 0xffff) - origin + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
    const db =
      ((b.sequenceNumber & 0xffff) - origin + TWCC_SEQ_MOD) % TWCC_SEQ_MOD;
    return da - db;
  });
}

/**
 * True if `seq` is strictly older than `ref` within half the sequence space
 * (same half-mod convention as {@link uint16Gt}).
 */
export function isOlderTransportWideSeq(seq: number, ref: number): boolean {
  return compareTransportWideSeq(seq, ref) < 0;
}
