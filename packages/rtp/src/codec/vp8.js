// RFC 7741 — RTP Payload Format for VP8 Video
// docs/rfc/rfc7741.txt
//
// Payload Descriptor (RFC 7741 §4.2):
//   X|R|N|S|R|PID
// Packetizer emits the same 4-octet form as libwebrtc single-layer senders:
// X=1, I=1, M=1 (15-bit PictureID), L=T=K=0, single partition PID=0.
//   First chunk of a frame: S=1 → 0x90 0x80 PictureID(2 octets, M=1)
//   Continuation chunks:    S=0 → 0x80 0x80 PictureID(2 octets, M=1)
// PictureID increments by 1 per frame (15-bit wrap); all fragments of a frame
// share it. X=1 is required by SFUs such as mediasoup <= 3.19.2, which drop
// X=0 VP8 as unparsable and never detect its keyframes.
// Marker: last RTP packet of the frame (RFC 7741 §4.1).
// VP8 Payload Header P bit (keyframe when P=0) is left untouched in the
// bitstream; only present when S=1 && PID=0 (RFC 7741 §4.3).
Object.defineProperty(exports, "__esModule", { value: true });
exports.Vp8Packetizer =
  exports.VP8_PAYLOAD_DESCRIPTOR_LENGTH =
  exports.Vp8RtpPayload =
    void 0;
exports.createVp8PayloadDescriptor = createVp8PayloadDescriptor;
const src_1 = require("../../../common/src");
const base_1 = require("./base");
//        0 1 2 3 4 5 6 7                      0 1 2 3 4 5 6 7
//       +-+-+-+-+-+-+-+-+                   +-+-+-+-+-+-+-+-+
//       |X|R|N|S|R| PID | (REQUIRED)        |X|R|N|S|R| PID | (REQUIRED)
//       +-+-+-+-+-+-+-+-+                   +-+-+-+-+-+-+-+-+
//  X:   |I|L|T|K| RSV   | (OPTIONAL)   X:   |I|L|T|K| RSV   | (OPTIONAL)
//       +-+-+-+-+-+-+-+-+                   +-+-+-+-+-+-+-+-+
//  I:   |M| PictureID   | (OPTIONAL)   I:   |M| PictureID   | (OPTIONAL)
//       +-+-+-+-+-+-+-+-+                   +-+-+-+-+-+-+-+-+
//  L:   |   TL0PICIDX   | (OPTIONAL)        |   PictureID   |
//       +-+-+-+-+-+-+-+-+                   +-+-+-+-+-+-+-+-+
//  T/K: |TID|Y| KEYIDX  | (OPTIONAL)   L:   |   TL0PICIDX   | (OPTIONAL)
//       +-+-+-+-+-+-+-+-+                   +-+-+-+-+-+-+-+-+
//                                      T/K: |TID|Y| KEYIDX  | (OPTIONAL)
//                                           +-+-+-+-+-+-+-+-+
// 0 1 2 3 4 5 6 7
// +-+-+-+-+-+-+-+-+
// |Size0|H| VER |P|
// +-+-+-+-+-+-+-+-+
// |     Size1     |
// +-+-+-+-+-+-+-+-+
// |     Size2     |
// +-+-+-+-+-+-+-+-+
// | Octets 4..N of|
// | VP8 payload   |
// :               :
// +-+-+-+-+-+-+-+-+
// | OPTIONAL RTP  |
// | padding       |
// :               :
// +-+-+-+-+-+-+-+-+
class Vp8RtpPayload {
  constructor() {
    Object.defineProperty(this, "xBit", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "nBit", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "sBit", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "pid", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "iBit", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "lBit", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "tBit", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "kBit", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "mBit", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "pictureId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "payload", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "size0", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(this, "hBit", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "ver", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "pBit", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "size1", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(this, "size2", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0,
    });
  }
  static deSerialize(buf) {
    const p = new Vp8RtpPayload();
    let offset = 0;
    p.xBit = (0, src_1.getBit)(buf[offset], 0);
    p.nBit = (0, src_1.getBit)(buf[offset], 2);
    p.sBit = (0, src_1.getBit)(buf[offset], 3);
    p.pid = (0, src_1.getBit)(buf[offset], 5, 3);
    offset++;
    if (p.xBit) {
      p.iBit = (0, src_1.getBit)(buf[offset], 0);
      p.lBit = (0, src_1.getBit)(buf[offset], 1);
      p.tBit = (0, src_1.getBit)(buf[offset], 2);
      p.kBit = (0, src_1.getBit)(buf[offset], 3);
      offset++;
    }
    if (p.iBit) {
      p.mBit = (0, src_1.getBit)(buf[offset], 0);
      if (p.mBit) {
        const _7 = (0, src_1.paddingByte)((0, src_1.getBit)(buf[offset], 1, 7));
        const _8 = (0, src_1.paddingByte)(buf[offset + 1]);
        p.pictureId = Number.parseInt(_7 + _8, 2);
        offset += 2;
      } else {
        p.pictureId = (0, src_1.getBit)(buf[offset], 1, 7);
        offset++;
      }
    }
    if (p.lBit) {
      offset++;
    }
    if (p.lBit || p.kBit) {
      if (p.tBit) {
      }
      if (p.kBit) {
      }
      offset++;
    }
    p.payload = buf.subarray(offset);
    if (p.payloadHeaderExist) {
      p.size0 = (0, src_1.getBit)(buf[offset], 0, 3);
      p.hBit = (0, src_1.getBit)(buf[offset], 3);
      p.ver = (0, src_1.getBit)(buf[offset], 4, 3);
      p.pBit = (0, src_1.getBit)(buf[offset], 7);
      offset++;
      p.size1 = buf[offset];
      offset++;
      p.size2 = buf[offset];
    }
    return p;
  }
  static isDetectedFinalPacketInSequence(header) {
    return header.marker;
  }
  get isKeyframe() {
    return this.pBit === 0;
  }
  get isPartitionHead() {
    return this.sBit === 1;
  }
  get payloadHeaderExist() {
    return this.sBit === 1 && this.pid === 0;
  }
  get size() {
    if (this.payloadHeaderExist) {
      const size = this.size0 + 8 * this.size1 + 2048 * this.size2;
      return size;
    }
    return 0;
  }
}
exports.Vp8RtpPayload = Vp8RtpPayload;
/** Length of the descriptor emitted by {@link createVp8PayloadDescriptor}. */
exports.VP8_PAYLOAD_DESCRIPTOR_LENGTH = 4;
const VP8_PICTURE_ID_MASK = 0x7fff;
/**
 * Build the 4-octet VP8 payload descriptor X=1, I=1, M=1 (RFC 7741 §4.2).
 * `start` sets S (first packet of the frame, PID=0).
 */
function createVp8PayloadDescriptor({ start, pictureId }) {
  const pid = pictureId & VP8_PICTURE_ID_MASK;
  return Buffer.from([
    0x80 | (start ? 0x10 : 0x00),
    0x80,
    0x80 | (pid >> 8),
    pid & 0xff,
  ]);
}
/**
 * Packetize one VP8 frame (single partition PID=0) into RTP packets.
 * Each packet carries the 4-octet descriptor from
 * {@link createVp8PayloadDescriptor}; PictureID advances once per frame.
 */
class Vp8Packetizer extends base_1.PacketizerBase {
  constructor(options = {}) {
    super(options);
    Object.defineProperty(this, "pictureId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    this.pictureId =
      (options.pictureId ?? (0, src_1.random16)()) & VP8_PICTURE_ID_MASK;
  }
  packetize(data, rtpTimestamp) {
    if (data.length === 0) {
      return [];
    }
    // Descriptor length = 4 (X/I/M); chunk size = maxPayloadSize − 4
    const chunkSize =
      this.maxPayloadSize - exports.VP8_PAYLOAD_DESCRIPTOR_LENGTH;
    if (chunkSize <= 0) {
      throw new Error(
        `Vp8Packetizer: maxPayloadSize ${this.maxPayloadSize} too small for VP8 descriptor`,
      );
    }
    const pictureId = this.pictureId;
    this.pictureId = (this.pictureId + 1) & VP8_PICTURE_ID_MASK;
    const packets = [];
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.subarray(
        offset,
        Math.min(data.length, offset + chunkSize),
      );
      // S=1 on partition start (frame start for PID=0), else S=0 (RFC 7741 §4.2)
      const descriptor = createVp8PayloadDescriptor({
        start: offset === 0,
        pictureId,
      });
      const isLast = offset + chunk.length >= data.length;
      packets.push(
        this.buildPacket(
          Buffer.concat([descriptor, chunk]),
          rtpTimestamp,
          isLast,
        ),
      );
    }
    return packets;
  }
}
exports.Vp8Packetizer = Vp8Packetizer;
//# sourceMappingURL=vp8.js.map
