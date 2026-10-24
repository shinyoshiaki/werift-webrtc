// RFC 3551 §4.5.2 — G.722
//
// "Even though the actual sampling rate for G.722 audio is 16,000 Hz,
//  the RTP clock rate for the G722 payload format is 8,000 Hz ...
//  The octet rate or sample-pair rate is 8,000 Hz."
//
// Therefore payload size and RTP timestamp both track **8000 octets/second**
// (1 octet ↔ 1 RTP clock tick). A 20 ms packet is 160 octets, not 320.
// Static PT = 9. Payload is raw G.722 bitstream (no codec-specific header).
Object.defineProperty(exports, "__esModule", { value: true });
exports.G722Packetizer =
  exports.G722RtpPayload =
  exports.G722_OCTET_RATE =
  exports.G722_CLOCK_RATE =
  exports.G722_PAYLOAD_TYPE =
    void 0;
const base_1 = require("./base");
/** RFC 3551 static payload type for G.722. */
exports.G722_PAYLOAD_TYPE = 9;
/**
 * RTP clock rate for G.722 (Hz) and octet rate (octets/s).
 * RFC 3551 §4.5.2: both are 8000 (not 16000).
 */
exports.G722_CLOCK_RATE = 8000;
/** Octets per second of G.722 RTP payload (RFC 3551 §4.5.2). */
exports.G722_OCTET_RATE = 8000;
const DEFAULT_FRAME_DURATION_MS = 20;
class G722RtpPayload {
  constructor() {
    Object.defineProperty(this, "payload", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
  }
  static deSerialize(buf) {
    const p = new G722RtpPayload();
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
exports.G722RtpPayload = G722RtpPayload;
class G722Packetizer extends base_1.PacketizerBase {
  constructor(options = {}) {
    super({
      ...options,
      payloadType: options.payloadType ?? exports.G722_PAYLOAD_TYPE,
    });
    /** Nominal octets per packetization frame (8000 octets/s × duration). */
    Object.defineProperty(this, "frameBytes", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    const frameMs = options.frameDurationInMs ?? DEFAULT_FRAME_DURATION_MS;
    // RFC 3551 §4.5.2: octet rate = 8000 Hz → 20 ms = 160 octets
    this.frameBytes = Math.max(
      1,
      Math.floor((exports.G722_OCTET_RATE * frameMs) / 1000),
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
      // 1 octet = 1 RTP clock unit @ 8000 Hz (RFC 3551 §4.5.2)
      ts = (ts + chunk.length) >>> 0;
    }
    return packets;
  }
}
exports.G722Packetizer = G722Packetizer;
//# sourceMappingURL=g722.js.map
