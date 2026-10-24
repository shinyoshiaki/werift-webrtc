// RTP Payload Format For AV1
// Spec: https://aomediacodec.github.io/av1-rtp-spec/
// Saved: docs/rfc/av1-rtp-spec.html
//
// Aggregation Header (AV1 RTP §4.4):
//   Z|Y|W|N|-|-|-
// Packetizer packs up to 3 OBU elements per packet (W=1..3), splitting OBUs
// across packet boundaries like libwebrtc so only the first packet of a
// temporal unit has Z=0 and only the last has Y=0.
// Z/Y mark fragment continuation; N marks start of a new coded video sequence
// (keyframe, first packet only). N=1 and Z=1 together are forbidden.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Av1Packetizer = exports.AV1Obu = exports.AV1RtpPayload = void 0;
exports.leb128decode = leb128decode;
exports.createAv1AggregationHeader = createAv1AggregationHeader;
exports.splitAv1Obus = splitAv1Obus;
const common_1 = require("../imports/common");
const base_1 = require("./base");
const leb128_1 = require("./leb128");
const log = (0, common_1.debug)("werift-rtp : packages/rtp/src/codec/av1.ts");
// 4.4 AV1 Aggregation Header
//  0 1 2 3 4 5 6 7
// +-+-+-+-+-+-+-+-+
// |Z|Y| W |N|-|-|-|
// +-+-+-+-+-+-+-+-+
// RTP payload syntax:
// 0                   1                   2                   3
// 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |Z|Y|0 0|N|-|-|-|  OBU element 1 size (leb128)  |               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+               |
// :                                                               :
// :                      OBU element 1 data                       :
// :                                                               :
// |                                                               |
// |                               +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                               |  OBU element 2 size (leb128)  |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// :                                                               :
// :                       OBU element 2 data                      :
// :                                                               :
// |                                                               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// :                                                               :
// :                              ...                              :
// :                                                               :
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |OBU e... N size|                                               |
// +-+-+-+-+-+-+-+-+       OBU element N data      +-+-+-+-+-+-+-+-+
// |                                               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// OBU syntax:
//     0 1 2 3 4 5 6 7
//    +-+-+-+-+-+-+-+-+
//    |0| type  |X|S|-| (REQUIRED)
//    +-+-+-+-+-+-+-+-+
// X: | TID |SID|-|-|-| (OPTIONAL)
//    +-+-+-+-+-+-+-+-+
//    |1|             |
//    +-+ OBU payload |
// S: |1|             | (OPTIONAL, variable length leb128 encoded)
//    +-+    size     |
//    |0|             |
//    +-+-+-+-+-+-+-+-+
//    |  OBU payload  |
//    |     ...       |
class AV1RtpPayload {
  constructor() {
    /**
     * RtpStartsWithFragment
     * MUST be set to 1 if the first OBU element is an OBU fragment that is a continuation of an OBU fragment from the previous packet, and MUST be set to 0 otherwise.
     */
    Object.defineProperty(this, "zBit_RtpStartsWithFragment", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /**
     * RtpEndsWithFragment
     * MUST be set to 1 if the last OBU element is an OBU fragment that will continue in the next packet, and MUST be set to 0 otherwise.
     */
    Object.defineProperty(this, "yBit_RtpEndsWithFragment", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /**
     * RtpNumObus
     * two bit field that describes the number of OBU elements in the packet. This field MUST be set equal to 0 or equal to the number of OBU elements contained in the packet. If set to 0, each OBU element MUST be preceded by a length field.
     */
    Object.defineProperty(this, "w_RtpNumObus", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /**
     * RtpStartsNewCodedVideoSequence
     * MUST be set to 1 if the packet is the first packet of a coded video sequence, and MUST be set to 0 otherwise.
     */
    Object.defineProperty(this, "nBit_RtpStartsNewCodedVideoSequence", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "obu_or_fragment", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: [],
    });
  }
  static isDetectedFinalPacketInSequence(header) {
    return header.marker;
  }
  get isKeyframe() {
    return this.nBit_RtpStartsNewCodedVideoSequence === 1;
  }
  static getFrame(payloads) {
    const frames = [];
    // Adjacent fragmented OBUs (A ends and B starts in the same packet) share
    // isFragment=true, so boundaries come from continues/isContinuation:
    // an OBU starts at a fragment without isContinuation and ends at the first
    // fragment that does not continue into the next packet.
    let pending = [];
    const flushLost = () => {
      if (pending.length > 0) {
        log("fragment lost, maybe packet lost");
        pending = [];
      }
    };
    for (const {
      data,
      isFragment,
      continues,
      isContinuation,
    } of payloads.flatMap((p) => p.obu_or_fragment)) {
      if (!isFragment) {
        flushLost();
        frames.push(data);
        continue;
      }
      if (!isContinuation) {
        flushLost();
        pending = [data];
      } else if (pending.length === 0) {
        // continuation without a start: head of the OBU was lost
        log("fragment lost, maybe packet lost");
        continue;
      } else {
        pending.push(data);
      }
      if (!continues) {
        if (pending.length > 1) {
          frames.push(Buffer.concat(pending));
        } else {
          log("fragment lost, maybe packet lost");
        }
        pending = [];
      }
    }
    flushLost();
    // Re-serialize OBUs. Non-last OBUs always carry a size field so the
    // bitstream is self-delimiting; the last OBU keeps its original
    // obu_has_size_field (size present or remainder-of-buffer).
    // Size-field LEB128 is re-encoded canonically from the payload body
    // (AV1Obu.deSerialize strips LEB128 into payload-only).
    const obus = frames.map((f) => AV1Obu.deSerialize(f));
    if (obus.length === 0) {
      return Buffer.alloc(0);
    }
    const lastObu = obus.pop();
    return Buffer.concat([
      ...obus.map((o) => {
        o.obu_has_size_field = 1;
        return o.serialize();
      }),
      lastObu.serialize(),
    ]);
  }
}
exports.AV1RtpPayload = AV1RtpPayload;
Object.defineProperty(AV1RtpPayload, "deSerialize", {
  enumerable: true,
  configurable: true,
  writable: true,
  value: (buf) => {
    const p = new AV1RtpPayload();
    let offset = 0;
    p.zBit_RtpStartsWithFragment = (0, common_1.getBit)(buf[offset], 0);
    p.yBit_RtpEndsWithFragment = (0, common_1.getBit)(buf[offset], 1);
    p.w_RtpNumObus = (0, common_1.getBit)(buf[offset], 2, 2);
    p.nBit_RtpStartsNewCodedVideoSequence = (0, common_1.getBit)(
      buf[offset],
      4,
    );
    offset++;
    if (p.nBit_RtpStartsNewCodedVideoSequence && p.zBit_RtpStartsWithFragment) {
      throw new Error();
    }
    if (p.w_RtpNumObus === 0) {
      // W=0: every OBU element, including the last, is preceded by a length
      let i = 0;
      while (offset < buf.length) {
        const [elementSize, bytes] = leb128decode(buf.subarray(offset));
        const start = offset + bytes;
        const end = start + elementSize;
        if (end > buf.length) {
          throw new Error("AV1 OBU element length exceeds payload");
        }
        const isFirst = i === 0;
        const isLast = end >= buf.length;
        const isFragment =
          (isFirst && !!p.zBit_RtpStartsWithFragment) ||
          (isLast && !!p.yBit_RtpEndsWithFragment);
        p.obu_or_fragment.push({
          data: buf.subarray(start, end),
          isFragment,
          continues: isLast && !!p.yBit_RtpEndsWithFragment,
          isContinuation: isFirst && !!p.zBit_RtpStartsWithFragment,
        });
        offset = end;
        i++;
      }
      return p;
    }
    [...Array(p.w_RtpNumObus - 1).keys()].forEach((i) => {
      const [elementSize, bytes] = leb128decode(buf.subarray(offset));
      const start = offset + bytes;
      const end = start + elementSize;
      let isFragment = false;
      if (p.zBit_RtpStartsWithFragment && i === 0) {
        isFragment = true;
      }
      p.obu_or_fragment.push({
        data: buf.subarray(start, end),
        isFragment,
        continues: false,
        isContinuation: isFragment,
      });
      offset += bytes + elementSize;
    });
    let isFragment = false;
    if (
      p.yBit_RtpEndsWithFragment ||
      (p.w_RtpNumObus === 1 && p.zBit_RtpStartsWithFragment)
    ) {
      isFragment = true;
    }
    p.obu_or_fragment.push({
      data: buf.subarray(offset),
      isFragment: isFragment,
      continues: !!p.yBit_RtpEndsWithFragment,
      isContinuation: !!p.zBit_RtpStartsWithFragment && p.w_RtpNumObus === 1,
    });
    return p;
  },
});
class AV1Obu {
  constructor() {
    Object.defineProperty(this, "obu_forbidden_bit", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "obu_type", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "obu_extension_flag", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "obu_has_size_field", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "obu_reserved_1bit", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /** Present when obu_extension_flag=1 (TID/SID byte). */
    Object.defineProperty(this, "extension_header", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /** OBU payload body only (LEB128 size field is not part of payload). */
    Object.defineProperty(this, "payload", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
  }
  /**
   * Parse one OBU element.
   * When `obu_has_size_field` is set, consumes LEB128 size and takes exactly
   * that many payload octets (AV1 bitstream / AV1 RTP OBU element).
   */
  static deSerialize(buf) {
    if (buf.length < 1) {
      throw new Error("AV1 OBU too short: expected at least 1 header byte");
    }
    const obu = new AV1Obu();
    let offset = 0;
    obu.obu_forbidden_bit = (0, common_1.getBit)(buf[offset], 0);
    obu.obu_type = OBU_TYPES[(0, common_1.getBit)(buf[offset], 1, 4)];
    obu.obu_extension_flag = (0, common_1.getBit)(buf[offset], 5);
    obu.obu_has_size_field = (0, common_1.getBit)(buf[offset], 6);
    obu.obu_reserved_1bit = (0, common_1.getBit)(buf[offset], 7);
    offset++;
    if (obu.obu_extension_flag) {
      if (offset >= buf.length) {
        throw new Error(
          "AV1 OBU: extension flag set but extension byte missing",
        );
      }
      obu.extension_header = buf[offset];
      offset++;
    }
    if (obu.obu_has_size_field) {
      const [obuSize, leb128Length] = leb128decode(buf.subarray(offset));
      offset += leb128Length;
      const end = offset + obuSize;
      if (end > buf.length) {
        throw new Error(
          `AV1 OBU size field ${obuSize} exceeds remaining buffer ${buf.length - offset}`,
        );
      }
      // Payload is body only; size is re-encoded on serialize
      obu.payload = buf.subarray(offset, end);
    } else {
      // No size field: remainder is the payload (typical last OBU)
      obu.payload = buf.subarray(offset);
    }
    return obu;
  }
  serialize() {
    const header = new common_1.BitWriter2(8)
      .set(this.obu_forbidden_bit)
      .set(OBU_TYPE_IDS[this.obu_type], 4)
      .set(this.obu_extension_flag)
      .set(this.obu_has_size_field)
      .set(this.obu_reserved_1bit).buffer;
    const ext =
      this.obu_extension_flag && this.extension_header !== undefined
        ? Buffer.from([this.extension_header & 0xff])
        : Buffer.alloc(0);
    let obuSize = Buffer.alloc(0);
    if (this.obu_has_size_field) {
      obuSize = (0, leb128_1.leb128encode)(this.payload.length);
    }
    return Buffer.concat([header, ext, obuSize, this.payload]);
  }
}
exports.AV1Obu = AV1Obu;
function leb128decode(buf) {
  let value = 0;
  let leb128bytes = 0;
  for (let i = 0; i < 8; i++) {
    if (i >= buf.length) {
      throw new Error("LEB128 decode incomplete");
    }
    const leb128byte = buf.readUInt8(i);
    value += (leb128byte & 0x7f) * 128 ** i;
    leb128bytes++;
    if (!(leb128byte & 0x80)) {
      if (!Number.isSafeInteger(value)) {
        throw new Error("LEB128 value exceeds safe integer");
      }
      return [value, leb128bytes];
    }
  }
  throw new Error("LEB128 decode incomplete");
}
const OBU_TYPES = {
  0: "Reserved",
  1: "OBU_SEQUENCE_HEADER",
  2: "OBU_TEMPORAL_DELIMITER",
  3: "OBU_FRAME_HEADER",
  4: "OBU_TILE_GROUP",
  5: "OBU_METADATA",
  6: "OBU_FRAME",
  7: "OBU_REDUNDANT_FRAME_HEADER",
  8: "OBU_TILE_LIST",
  15: "OBU_PADDING",
};
const OBU_TYPE_IDS = Object.entries(OBU_TYPES).reduce((acc, [key, value]) => {
  acc[value] = Number(key);
  return acc;
}, {});
// ---------------------------------------------------------------------------
// Packetizer helpers (canonical location; webrtc may mirror for EncodedPacket)
// ---------------------------------------------------------------------------
/**
 * Build the 1-byte AV1 Aggregation Header (AV1 RTP §4.4).
 * N=1 and Z=1 must not both be set (deSerialize throws).
 */
function createAv1AggregationHeader({
  startsWithFragment,
  endsWithFragment,
  startsNewCodedVideoSequence,
  obuCount = 1,
}) {
  if (startsWithFragment && startsNewCodedVideoSequence) {
    throw new Error(
      "AV1 aggregation header: N=1 and Z=1 must not both be set (AV1 RTP §4.4)",
    );
  }
  if (!Number.isInteger(obuCount) || obuCount < 1 || obuCount > 3) {
    throw new Error(`AV1 aggregation header: invalid W=${obuCount}`);
  }
  // Z|Y|W|N|000
  return new common_1.BitWriter(8)
    .set(1, 0, startsWithFragment ? 1 : 0)
    .set(1, 1, endsWithFragment ? 1 : 0)
    .set(2, 2, obuCount)
    .set(1, 4, startsNewCodedVideoSequence ? 1 : 0)
    .set(3, 5, 0).buffer;
}
/**
 * Split an AV1 sample into OBU elements.
 * Accepts size-field and no-size-field (remainder is last OBU) layouts.
 */
function splitAv1Obus(sample) {
  const obus = [];
  let offset = 0;
  while (offset < sample.length) {
    const start = offset;
    const header = sample[offset];
    offset += 1;
    if (header == undefined) {
      break;
    }
    const extensionFlag = (0, common_1.getBit)(header, 5);
    const hasSizeField = (0, common_1.getBit)(header, 6);
    if (extensionFlag) {
      if (offset >= sample.length) {
        throw new Error("invalid AV1 OBU: extension flag set but buffer ends");
      }
      offset += 1;
    }
    if (!hasSizeField) {
      // Remainder of the buffer is this OBU
      obus.push(sample.subarray(start));
      break;
    }
    const [obuSize, leb128Length] = leb128decode(sample.subarray(offset));
    offset += leb128Length;
    const end = offset + obuSize;
    if (end > sample.length) {
      throw new Error("invalid AV1 OBU size");
    }
    obus.push(sample.subarray(start, end));
    offset = end;
  }
  return obus;
}
/** Max OBU elements per packet expressible with W (W=0 is not emitted). */
const MAX_W_ELEMENTS = 3;
/** obu_type of a Sequence Header OBU (AV1 spec §6.2.2). */
const OBU_SEQUENCE_HEADER = 1;
/** obu_type of a Temporal Delimiter OBU; MUST NOT be sent over RTP (AV1 RTP §5). */
const OBU_TEMPORAL_DELIMITER = 2;
/**
 * Convert an OBU to its RTP element form: obu_has_size_field=0 and no LEB128
 * size (AV1 RTP §5: senders SHOULD clear it; libwebrtc cannot reassemble
 * fragments that still carry a size field).
 */
function toRtpObuElement(obu) {
  const header = obu[0];
  if (!(0, common_1.getBit)(header, 6)) {
    return obu;
  }
  const headerLength = (0, common_1.getBit)(header, 5) ? 2 : 1;
  const [, sizeBytes] = leb128decode(obu.subarray(headerLength));
  const out = Buffer.concat([
    obu.subarray(0, headerLength),
    obu.subarray(headerLength + sizeBytes),
  ]);
  out[0] = header & ~0x02;
  return out;
}
/** temporal_id/spatial_id bits of the OBU extension header, if present. */
function getAv1ObuLayerId(obu) {
  if (!(0, common_1.getBit)(obu[0], 5) || obu.length < 2) return undefined;
  return obu[1] & 0xf8;
}
/**
 * Packetize one AV1 access unit (OBU sequence) into RTP packets.
 * Packs OBU elements (W=1..3) and fragments them across packets with Z/Y bits.
 */
class Av1Packetizer extends base_1.PacketizerBase {
  constructor(options = {}) {
    super(options);
    Object.defineProperty(this, "defaultIsKeyframe", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    this.defaultIsKeyframe = options.isKeyframe ?? false;
  }
  packetize(data, rtpTimestamp, options = {}) {
    if (data.length === 0) {
      return [];
    }
    let isKeyframe = this.defaultIsKeyframe;
    if (options.frameType === "key") isKeyframe = true;
    else if (options.frameType === "delta") isKeyframe = false;
    else if (options.isKeyframe !== undefined) isKeyframe = options.isKeyframe;
    const allObus = splitAv1Obus(data);
    if (allObus.length === 0) {
      throw new Error("AV1 sample did not contain any OBU data");
    }
    const startsNewSequence =
      options.startsNewCodedVideoSequence ??
      (isKeyframe &&
        allObus.some((o) => ((o[0] >> 3) & 0x0f) === OBU_SEQUENCE_HEADER));
    const obus = allObus
      .filter((o) => ((o[0] >> 3) & 0x0f) !== OBU_TEMPORAL_DELIMITER)
      .map(toRtpObuElement);
    if (obus.length === 0) {
      return [];
    }
    // Aggregation header = 1 byte
    const capacity = this.maxPayloadSize - 1;
    if (capacity <= 0) {
      throw new Error(
        `Av1Packetizer: maxPayloadSize ${this.maxPayloadSize} too small for aggregation header`,
      );
    }
    // OBU elements are packed back to back and split at packet boundaries
    // (as libwebrtc RtpPacketizerAv1 does). Without a dependency descriptor,
    // libwebrtc treats Z=0 as frame start and Y=0 as frame end, so starting
    // every OBU in its own packet would split one temporal unit into frames.
    const packets = [];
    let obuIndex = 0;
    let obuOffset = 0;
    while (obuIndex < obus.length) {
      const startsWithFragment = obuOffset > 0;
      const elements = [];
      let used = 0;
      let endsWithFragment = false;
      // 同一 packet 内の拡張ヘッダ付き OBU は temporal_id/spatial_id が同じものに限る。
      let packetLayerId;
      while (obuIndex < obus.length && elements.length < MAX_W_ELEMENTS) {
        const obu = obus[obuIndex];
        const layerId = getAv1ObuLayerId(obu);
        if (
          layerId !== undefined &&
          packetLayerId !== undefined &&
          layerId !== packetLayerId
        ) {
          break;
        }
        const rest = obu.subarray(obuOffset);
        // Adding an element gives the previous last element a length prefix
        const prefix =
          elements.length > 0
            ? (0, leb128_1.leb128encode)(elements.at(-1).length).length
            : 0;
        const available = capacity - used - prefix;
        if (available <= 0) {
          break;
        }
        used += prefix;
        if (rest.length <= available) {
          elements.push(rest);
          used += rest.length;
          if (layerId !== undefined) packetLayerId = layerId;
          obuIndex++;
          obuOffset = 0;
          continue;
        }
        elements.push(rest.subarray(0, available));
        used += available;
        if (layerId !== undefined) packetLayerId = layerId;
        obuOffset += available;
        endsWithFragment = true;
        break;
      }
      const aggregationHeader = createAv1AggregationHeader({
        startsWithFragment,
        endsWithFragment,
        startsNewCodedVideoSequence: packets.length === 0 && startsNewSequence,
        obuCount: elements.length,
      });
      const body = elements.flatMap((element, i) =>
        i < elements.length - 1
          ? [(0, leb128_1.leb128encode)(element.length), element]
          : [element],
      );
      packets.push(
        this.buildPacket(
          Buffer.concat([aggregationHeader, ...body]),
          rtpTimestamp,
          false,
        ),
      );
    }
    // Marker on last packet of the frame (AV1 RTP marker bit semantics)
    packets.at(-1).header.marker = true;
    return packets;
  }
}
exports.Av1Packetizer = Av1Packetizer;
//# sourceMappingURL=av1.js.map
