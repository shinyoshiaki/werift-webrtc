// RFC 7587 — RTP Payload Format for the Opus Speech and Audio Codec
// docs/rfc/rfc7587.txt
//
// Opus RTP has no codec-specific payload header: the RTP payload is one
// complete Opus packet (RFC 7587 §3 / §4.1). Marker is set only on the first
// packet of a talkspurt. Simple MTU splitting would break the TOC and is
// rejected (caller must keep Opus packets ≤ maxPayloadSize).
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpusPacketizer =
  exports.OpusRtpPayload =
  exports.OPUS_CLOCK_RATE =
    void 0;
const src_1 = require("../../../common/src");
const base_1 = require("./base");
/** RFC 7587 §4 / Opus default sampling rate (Hz). */
exports.OPUS_CLOCK_RATE = 48000;
class OpusRtpPayload {
  constructor() {
    Object.defineProperty(this, "payload", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
  }
  static deSerialize(buf) {
    const opus = new OpusRtpPayload();
    opus.payload = buf;
    return opus;
  }
  static isDetectedFinalPacketInSequence(_header) {
    return true;
  }
  get isKeyframe() {
    return true;
  }
  static createCodecPrivate(samplingFrequency = 48000) {
    return Buffer.concat([
      Buffer.from("OpusHead"),
      (0, src_1.bufferWriter)([1, 1], [1, 2]),
      (0, src_1.bufferWriterLE)([2, 4, 2, 1], [312, samplingFrequency, 0, 0]),
    ]);
  }
}
exports.OpusRtpPayload = OpusRtpPayload;
/**
 * Packetize one Opus packet into one RTP packet (RFC 7587 §3).
 * Throws if the Opus packet exceeds maxPayloadSize (no TOC-blind split).
 */
class OpusPacketizer extends base_1.PacketizerBase {
  constructor(options = {}) {
    super(options);
  }
  packetize(data, rtpTimestamp) {
    if (data.length === 0) {
      return [];
    }
    if (data.length > this.maxPayloadSize) {
      throw new Error(
        `OpusPacketizer: Opus packet length ${data.length} exceeds maxPayloadSize ${this.maxPayloadSize} (RFC 7587 forbids blind MTU fragmentation of the TOC)`,
      );
    }
    // RFC 7587 §4.1: marker only on the first packet of a talkspurt
    return [this.buildPacket(data, rtpTimestamp, this.takeTalkspurtMarker())];
  }
}
exports.OpusPacketizer = OpusPacketizer;
//# sourceMappingURL=opus.js.map
