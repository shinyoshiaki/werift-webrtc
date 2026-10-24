// RFC 3551 §4.5.14 — PCMA and PCMU (G.711)
// Payload is raw 8-bit samples with no codec-specific header.
// Static PT: PCMU = 0, PCMA = 8; clock rate 8000 Hz (RFC 3551 Table 4 / §6).
Object.defineProperty(exports, "__esModule", { value: true });
exports.PcmaPacketizer =
  exports.PcmuPacketizer =
  exports.PcmaRtpPayload =
  exports.PcmuRtpPayload =
  exports.G711_CLOCK_RATE =
  exports.PCMA_PAYLOAD_TYPE =
  exports.PCMU_PAYLOAD_TYPE =
    void 0;
const base_1 = require("./base");
/** RFC 3551 static payload type for PCMU (μ-law). */
exports.PCMU_PAYLOAD_TYPE = 0;
/** RFC 3551 static payload type for PCMA (A-law). */
exports.PCMA_PAYLOAD_TYPE = 8;
/** RFC 3551 clock rate for PCMU/PCMA (Hz). */
exports.G711_CLOCK_RATE = 8000;
/** Default frame duration for packetization (20 ms → 160 samples @ 8 kHz). */
const DEFAULT_FRAME_DURATION_MS = 20;
class PcmuRtpPayload {
  constructor() {
    Object.defineProperty(this, "payload", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
  }
  static deSerialize(buf) {
    const p = new PcmuRtpPayload();
    p.payload = buf;
    return p;
  }
  static isDetectedFinalPacketInSequence(_header) {
    return true;
  }
  get isKeyframe() {
    return true;
  }
}
exports.PcmuRtpPayload = PcmuRtpPayload;
class PcmaRtpPayload {
  constructor() {
    Object.defineProperty(this, "payload", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
  }
  static deSerialize(buf) {
    const p = new PcmaRtpPayload();
    p.payload = buf;
    return p;
  }
  static isDetectedFinalPacketInSequence(_header) {
    return true;
  }
  get isKeyframe() {
    return true;
  }
}
exports.PcmaRtpPayload = PcmaRtpPayload;
class G711Packetizer extends base_1.PacketizerBase {
  constructor(options = {}) {
    super(options);
    Object.defineProperty(this, "frameBytes", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    const frameMs = options.frameDurationInMs ?? DEFAULT_FRAME_DURATION_MS;
    // 8 kHz, 1 byte/sample → samples = bytes
    this.frameBytes = Math.max(
      1,
      Math.floor((exports.G711_CLOCK_RATE * frameMs) / 1000),
    );
  }
  packetize(data, rtpTimestamp) {
    if (data.length === 0) {
      return [];
    }
    const chunkSize = Math.min(this.maxPayloadSize, this.frameBytes);
    const packets = [];
    let ts = rtpTimestamp >>> 0;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const end = Math.min(data.length, offset + chunkSize);
      const chunk = data.subarray(offset, end);
      // RFC 3551 §4.1: marker only on the first packet of a talkspurt
      packets.push(this.buildPacket(chunk, ts, this.takeTalkspurtMarker()));
      // Advance timestamp by samples in this packet (1 sample = 1 byte)
      ts = (ts + chunk.length) >>> 0;
    }
    return packets;
  }
}
class PcmuPacketizer extends G711Packetizer {
  constructor(options = {}) {
    super({
      ...options,
      payloadType: options.payloadType ?? exports.PCMU_PAYLOAD_TYPE,
    });
  }
}
exports.PcmuPacketizer = PcmuPacketizer;
class PcmaPacketizer extends G711Packetizer {
  constructor(options = {}) {
    super({
      ...options,
      payloadType: options.payloadType ?? exports.PCMA_PAYLOAD_TYPE,
    });
  }
}
exports.PcmaPacketizer = PcmaPacketizer;
//# sourceMappingURL=g711.js.map
