// RFC 4733 — RTP Payload for DTMF Digits, Telephony Tones, and Telephony Signals
//
// Named telephone events are a "lower-level RTP primitive" (RFC 4733 §2.1):
// they are not aggregated into media frames by dePacketizeRtpPackets.
// Use TelephoneEventRtpPayload + TelephoneEventPacketizer directly.
//
// Wire format (4 octets, RFC 4733 §2.3 Figure 1):
//   event(8) | E(1) | R(1) | volume(6) | duration(16)
// Marker bit: set on the *first* packet of an event (RFC 4733 §2.5.1.1) —
// opposite of the usual "last packet of frame" convention.
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelephoneEventPacketizer =
  exports.TelephoneEventRtpPayload =
  exports.TELEPHONE_EVENT_DEFAULT_CLOCK_RATE =
  exports.TELEPHONE_EVENT_DEFAULT_PAYLOAD_TYPE =
    void 0;
const base_1 = require("./base");
/** Common dynamic PT for telephone-event (SDP: telephone-event/8000). */
exports.TELEPHONE_EVENT_DEFAULT_PAYLOAD_TYPE = 101;
/** Typical clock rate negotiated for telephone-event. */
exports.TELEPHONE_EVENT_DEFAULT_CLOCK_RATE = 8000;
const PAYLOAD_SIZE = 4;
function assertUintRange(name, value, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(
      `telephone-event ${name} must be an integer in 0..${max}, got ${value}`,
    );
  }
}
/**
 * RFC 4733 named telephone event payload.
 * Bidirectional: deSerialize + serialize (unlike most codec depacketizers).
 */
class TelephoneEventRtpPayload {
  constructor(props = {}) {
    Object.defineProperty(this, "event", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(this, "end", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: false,
    });
    /** Reserved bit; receivers MUST ignore, senders SHOULD set 0. */
    Object.defineProperty(this, "reserved", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: false,
    });
    Object.defineProperty(this, "volume", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(this, "duration", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.assign(this, props);
  }
  /**
   * Parse a 4-byte telephone-event payload (RFC 4733 §2.3).
   * @throws if buffer is shorter than 4 bytes.
   */
  static deSerialize(buf) {
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
  serialize() {
    assertUintRange("event", this.event, 0xff);
    assertUintRange("volume", this.volume, 0x3f);
    // RFC 4733 §2.5.1.3: events longer than 0xFFFF must be split by the caller
    assertUintRange("duration", this.duration, 0xffff);
    const buf = Buffer.alloc(PAYLOAD_SIZE);
    buf[0] = this.event & 0xff;
    buf[1] =
      (this.end ? 0x80 : 0) | (this.reserved ? 0x40 : 0) | (this.volume & 0x3f);
    buf.writeUInt16BE(this.duration, 2);
    return buf;
  }
  /**
   * Not used for frame aggregation — single-packet primitive.
   * Kept for interface familiarity; always returns true.
   */
  static isDetectedFinalPacketInSequence(_header) {
    return true;
  }
  get isKeyframe() {
    return true;
  }
  get payload() {
    return this.serialize();
  }
}
exports.TelephoneEventRtpPayload = TelephoneEventRtpPayload;
/**
 * Packetize named telephone events (RFC 4733).
 *
 * Preferred APIs for RFC-correct marker/E-bit control:
 * - {@link packetizeStart} / {@link packetizeContinue} / {@link packetizeEnd}
 * - {@link packetizeEvent} with start/end flags
 * - {@link packetize}(fields, timestamp) with structured fields
 *
 * {@link packetizeBuffer} exists only to re-wrap a pre-serialized 4-byte
 * payload (marker defaults to false — not for new event starts).
 */
class TelephoneEventPacketizer extends base_1.PacketizerBase {
  constructor(options = {}) {
    super({
      ...options,
      payloadType:
        options.payloadType ?? exports.TELEPHONE_EVENT_DEFAULT_PAYLOAD_TYPE,
    });
  }
  /**
   * Packetize a telephone-event snapshot.
   * Accepts structured fields (recommended) or a pre-built 4-byte Buffer.
   * For Buffer input, marker is false unless you use packetizeEvent/Start.
   */
  packetize(data, rtpTimestamp) {
    if (Buffer.isBuffer(data)) {
      return [this.packetizeBuffer(data, rtpTimestamp, false)];
    }
    return [this.packetizeEvent(data, rtpTimestamp)];
  }
  /**
   * Re-wrap a pre-serialized 4-byte payload. Marker is controlled explicitly;
   * default false (not suitable for event start without marker=true).
   */
  packetizeBuffer(data, rtpTimestamp, marker = false) {
    if (data.length < PAYLOAD_SIZE) {
      throw new Error(
        `telephone-event packetize: payload must be at least ${PAYLOAD_SIZE} bytes`,
      );
    }
    return this.buildPacket(
      data.subarray(0, PAYLOAD_SIZE),
      rtpTimestamp,
      marker,
    );
  }
  /**
   * Build one RTP packet for a telephone event snapshot.
   * - `start: true` → RTP marker = 1 (first packet of event)
   * - `end: true` → E bit = 1 (end of event)
   * Duration is cumulative from event start (RFC 4733 §2.5.1.2).
   */
  packetizeEvent(input, rtpTimestamp) {
    const payload = new TelephoneEventRtpPayload({
      event: input.event,
      volume: input.volume,
      duration: input.duration,
      end: !!input.end,
    }).serialize();
    return this.buildPacket(payload, rtpTimestamp, !!input.start);
  }
  /** First packet of an event: marker=1, E=0 (RFC 4733 §2.5.1.1). */
  packetizeStart(event, volume, duration, rtpTimestamp) {
    return this.packetizeEvent(
      { event, volume, duration, start: true, end: false },
      rtpTimestamp,
    );
  }
  /** Intermediate update: marker=0, E=0; duration is cumulative. */
  packetizeContinue(event, volume, duration, rtpTimestamp) {
    return this.packetizeEvent(
      { event, volume, duration, start: false, end: false },
      rtpTimestamp,
    );
  }
  /** Final packet(s): marker=0, E=1; duration is cumulative. */
  packetizeEnd(event, volume, duration, rtpTimestamp) {
    return this.packetizeEvent(
      { event, volume, duration, start: false, end: true },
      rtpTimestamp,
    );
  }
}
exports.TelephoneEventPacketizer = TelephoneEventPacketizer;
//# sourceMappingURL=telephoneEvent.js.map
