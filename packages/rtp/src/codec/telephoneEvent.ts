// RFC 4733 — RTP Payload for DTMF Digits, Telephony Tones, and Telephony Signals
//
// Named telephone events are a "lower-level RTP primitive" (RFC 4733 §2.1):
// they are not aggregated into media frames by dePacketizeRtpPackets.
// Use TelephoneEventRtpPayload deSerialize/serialize (and the packetizer)
// directly on individual RtpPacket instances.
//
// Wire format (4 octets, RFC 4733 §2.3 Figure 1):
//   event(8) | E(1) | R(1) | volume(6) | duration(16)
// Marker bit: set on the *first* packet of an event (RFC 4733 §2.5.1.1) —
// opposite of the usual "last packet of frame" convention.

import type { RtpHeader } from "../rtp/rtp";
import type { RtpPacket } from "../rtp/rtp";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";

/** Common dynamic PT for telephone-event (SDP: telephone-event/8000). */
export const TELEPHONE_EVENT_DEFAULT_PAYLOAD_TYPE = 101;
/** Typical clock rate negotiated for telephone-event. */
export const TELEPHONE_EVENT_DEFAULT_CLOCK_RATE = 8000;

const PAYLOAD_SIZE = 4;

export type TelephoneEventFields = {
  /** Event code (0–255). DTMF 0–9, *, #, A–D use 0–15 (RFC 4733 Table 7). */
  event: number;
  /** End of event flag (RFC 4733 E bit). */
  end: boolean;
  /** Volume 0–63; larger values = lower volume (dBm0). */
  volume: number;
  /** Duration in timestamp units (clock-rate dependent). */
  duration: number;
};

/**
 * RFC 4733 named telephone event payload.
 * Bidirectional: deSerialize + serialize (unlike most codec depacketizers).
 */
export class TelephoneEventRtpPayload {
  event = 0;
  end = false;
  /** Reserved bit; receivers MUST ignore, senders SHOULD set 0. */
  reserved = false;
  volume = 0;
  duration = 0;

  constructor(
    props: Partial<TelephoneEventFields & { reserved: boolean }> = {},
  ) {
    Object.assign(this, props);
  }

  /**
   * Parse a 4-byte telephone-event payload (RFC 4733 §2.3).
   * @throws if buffer is shorter than 4 bytes.
   */
  static deSerialize(buf: Buffer): TelephoneEventRtpPayload {
    if (buf.length < PAYLOAD_SIZE) {
      throw new Error(
        `telephone-event payload too short: expected ${PAYLOAD_SIZE}, got ${buf.length}`,
      );
    }
    const p = new TelephoneEventRtpPayload();
    p.event = buf[0];
    p.end = (buf[1] & 0x80) !== 0;
    p.reserved = (buf[1] & 0x40) !== 0;
    p.volume = buf[1] & 0x3f;
    p.duration = buf.readUInt16BE(2);
    return p;
  }

  /** Serialize to 4-byte payload (RFC 4733 §2.3). */
  serialize(): Buffer {
    const buf = Buffer.alloc(PAYLOAD_SIZE);
    buf[0] = this.event & 0xff;
    buf[1] =
      (this.end ? 0x80 : 0) | (this.reserved ? 0x40 : 0) | (this.volume & 0x3f);
    buf.writeUInt16BE(this.duration & 0xffff, 2);
    return buf;
  }

  /**
   * Not used for frame aggregation — single-packet primitive.
   * Kept for interface familiarity; always returns true.
   */
  static isDetectedFinalPacketInSequence(_header: RtpHeader) {
    return true;
  }

  get isKeyframe() {
    return true;
  }

  get payload(): Buffer {
    return this.serialize();
  }
}

export type TelephoneEventPacketizerOptions = PacketizerBaseOptions;

export type TelephoneEventPacketizeInput = {
  event: number;
  volume: number;
  /** Cumulative duration for this packet (RFC 4733 §2.5.1.2). */
  duration: number;
  /** True on the final packet(s) of the event (sets E bit). */
  end?: boolean;
  /**
   * True on the first packet of a new event (sets RTP marker).
   * RFC 4733 §2.5.1.1: marker indicates beginning of a new event.
   */
  start?: boolean;
};

/**
 * Packetize named telephone events.
 * Callers manage start/continue/end lifecycle via `start` and `end` flags;
 * each call produces one RTP packet (RFC 4733 multi-packet updates).
 */
export class TelephoneEventPacketizer extends PacketizerBase {
  constructor(options: TelephoneEventPacketizerOptions = {}) {
    super({
      payloadType: options.payloadType ?? TELEPHONE_EVENT_DEFAULT_PAYLOAD_TYPE,
      ...options,
    });
  }

  /**
   * Standard Packetizer interface — treats data as a pre-built 4-byte payload.
   * Prefer {@link packetizeEvent} for structured fields.
   */
  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[] {
    if (data.length < PAYLOAD_SIZE) {
      throw new Error(
        `telephone-event packetize: payload must be at least ${PAYLOAD_SIZE} bytes`,
      );
    }
    // Marker left false when using raw buffer; use packetizeEvent for marker control
    return [
      this.buildPacket(data.subarray(0, PAYLOAD_SIZE), rtpTimestamp, false),
    ];
  }

  /**
   * Build one RTP packet for a telephone event snapshot.
   * - `start: true` → RTP marker = 1 (first packet of event)
   * - `end: true` → E bit = 1 (end of event)
   * Duration is cumulative from event start (RFC 4733 §2.5.1.2).
   */
  packetizeEvent(
    input: TelephoneEventPacketizeInput,
    rtpTimestamp: number,
  ): RtpPacket {
    const payload = new TelephoneEventRtpPayload({
      event: input.event,
      volume: input.volume,
      duration: input.duration,
      end: !!input.end,
    }).serialize();
    return this.buildPacket(payload, rtpTimestamp, !!input.start);
  }
}
