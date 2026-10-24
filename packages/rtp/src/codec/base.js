// Packetizer / Depacketizer base types for werift-rtp.
// PacketizerBase mirrors the sequence/timestamp/marker semantics of
// packages/webrtc BasePacketizer without depending on webrtc.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PacketizerBase = exports.DePacketizerBase = void 0;
const src_1 = require("../../../common/src");
const const_1 = require("../const");
const rtp_1 = require("../rtp/rtp");
class DePacketizerBase {
  constructor() {
    Object.defineProperty(this, "payload", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "fragment", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
  }
  static deSerialize(buf, fragment) {
    return {};
  }
  static isDetectedFinalPacketInSequence(header) {
    return true;
  }
  get isKeyframe() {
    return true;
  }
}
exports.DePacketizerBase = DePacketizerBase;
/**
 * Shared RTP packet construction for package-local packetizers.
 * Sequence number increments by 1 (uint16 wrap) per packet.
 * Marker semantics are left to each codec (typically last packet of a frame;
 * telephone-event is the RFC 4733 exception: marker on the first event packet).
 */
class PacketizerBase {
  constructor(options = {}) {
    Object.defineProperty(this, "sequenceNumber", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "maxPayloadSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "payloadType", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "ssrc", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /** Audio only: next packet begins a talkspurt (RFC 3551 §4.1 marker). */
    Object.defineProperty(this, "talkspurtPending", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: true,
    });
    const max = options.maxPayloadSize ?? const_1.MTU;
    if (!Number.isInteger(max) || max <= 0) {
      throw new Error(
        `PacketizerBase: maxPayloadSize must be a positive integer, got ${max}`,
      );
    }
    this.maxPayloadSize = max;
    this.payloadType = options.payloadType ?? 96;
    this.sequenceNumber = options.sequenceNumber ?? (0, src_1.random16)();
    this.ssrc = options.ssrc ?? 0;
  }
  /**
   * Mark the next audio packet as the first of a talkspurt (e.g. after
   * silence suppression). The first packet of a new packetizer is also one.
   */
  startTalkspurt() {
    this.talkspurtPending = true;
  }
  /** Marker for audio packets: true once per talkspurt, false otherwise. */
  takeTalkspurtMarker() {
    const marker = this.talkspurtPending;
    this.talkspurtPending = false;
    return marker;
  }
  buildPacket(payload, timestamp, marker) {
    const packet = new rtp_1.RtpPacket(
      new rtp_1.RtpHeader({
        payloadType: this.payloadType,
        sequenceNumber: this.sequenceNumber,
        timestamp,
        marker,
        ssrc: this.ssrc,
      }),
      payload,
    );
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    return packet;
  }
}
exports.PacketizerBase = PacketizerBase;
//# sourceMappingURL=base.js.map
