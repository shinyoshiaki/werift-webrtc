// RFC 6184 — RTP Payload Format for H.264 Video
// docs/rfc/rfc6184.txt
//
// Packetizer targets packetization-mode=1 (Non-Interleaved):
//   Single NAL (§5.6), STAP-A Type=24 (§5.7.1), FU-A Type=28 (§5.8).
// Keyframe SPS/PPS: STAP-A preferred when ≥2 parameter sets fit MTU;
// fallback is individual Single NAL (same policy as H265Packetizer AP).
// Depacketizer output is Annex-B (00 00 00 01 prefixed) for each NAL.
Object.defineProperty(exports, "__esModule", { value: true });
exports.H264Packetizer =
  exports.H264_MIN_NAL_LENGTH =
  exports.NalUnitType =
  exports.H264RtpPayload =
    void 0;
exports.splitH264NalUnits = splitH264NalUnits;
exports.selectMissingH264ParameterSets = selectMissingH264ParameterSets;
exports.buildH264StapA = buildH264StapA;
exports.parseAvcDecoderConfigurationRecord = parseAvcDecoderConfigurationRecord;
const src_1 = require("../../../common/src");
const base_1 = require("./base");
const h265_1 = require("./h265");
// FU indicator octet
// +---------------+
// |0|1|2|3|4|5|6|7|
// +-+-+-+-+-+-+-+-+
// |F|NRI|  Type   |
// +---------------+
// FU header
// +---------------+
// |0|1|2|3|4|5|6|7|
// +-+-+-+-+-+-+-+-+
// |S|E|R|  Type   |
// +---------------+
// NAL Unit Type     Content of NAL Unit              NRI (binary)
// ----------------------------------------------------------------
//  1              non-IDR coded slice                         10
//  2              Coded slice data partition A                10
//  3              Coded slice data partition B                01
//  4              Coded slice data partition C                01
// Payload Packet    Single NAL    Non-Interleaved    Interleaved
// Type    Type      Unit Mode           Mode             Mode
// -------------------------------------------------------------
// 0      reserved      ig               ig               ig
// 1-23   NAL unit     yes              yes               no
// 24     STAP-A        no              yes               no
// 25     STAP-B        no               no              yes
// 26     MTAP16        no               no              yes
// 27     MTAP24        no               no              yes
// 28     FU-A          no              yes              yes
// 29     FU-B          no               no              yes
// 30-31  reserved      ig               ig               ig
class H264RtpPayload {
  constructor() {
    /**forbidden_zero_bit */
    Object.defineProperty(this, "f", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /**nal_ref_idc */
    Object.defineProperty(this, "nri", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /**nal_unit_types */
    Object.defineProperty(this, "nalUnitType", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /**start of a fragmented NAL unit (FU-A / FU-B only) */
    Object.defineProperty(this, "s", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /**end of a fragmented NAL unit (FU-A / FU-B only) */
    Object.defineProperty(this, "e", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /**reserved bit of the FU header (FU-A / FU-B only) */
    Object.defineProperty(this, "r", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /**nal_unit_type of the fragmented NAL unit (FU-A / FU-B only) */
    Object.defineProperty(this, "nalUnitPayloadType", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /**nal_unit_types of the NAL units aggregated in a STAP-A packet */
    Object.defineProperty(this, "aggregatedNalUnitTypes", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: [],
    });
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
    const h264 = new H264RtpPayload();
    if (buf.length < 1) {
      throw new Error(
        "H.264 RTP payload too short: expected at least 1 byte (NAL/FU indicator)",
      );
    }
    let offset = 0;
    const naluHeader = buf[offset];
    h264.f = (0, src_1.getBit)(naluHeader, 0);
    h264.nri = (0, src_1.getBit)(naluHeader, 1, 2);
    h264.nalUnitType = (0, src_1.getBit)(naluHeader, 3, 5);
    offset++;
    // デフォルトでは packetization-mode=0
    // packetization-mode=0だとSingle NAL Unit Packetしか来ない
    // https://datatracker.ietf.org/doc/html/rfc6184#section-6.2
    // Single NAL Unit Packet — full payload is the NAL (no second header byte)
    if (0 < h264.nalUnitType && h264.nalUnitType < exports.NalUnitType.stap_a) {
      h264.payload = this.packaging(buf);
      return h264;
    }
    // STAP-A / FU-A need at least indicator + one more octet
    if (buf.length < 2) {
      throw new Error(
        `H.264 RTP payload too short for type ${h264.nalUnitType}: expected at least 2 bytes, got ${buf.length}`,
      );
    }
    // The FU header exists only in FU-A / FU-B (RFC 6184 §5.8).
    // For STAP-A the 2nd octet is the upper byte of the first NALU size (§5.7.1).
    if (
      h264.nalUnitType === exports.NalUnitType.fu_a ||
      h264.nalUnitType === exports.NalUnitType.fu_b
    ) {
      h264.s = (0, src_1.getBit)(buf[offset], 0);
      h264.e = (0, src_1.getBit)(buf[offset], 1);
      h264.r = (0, src_1.getBit)(buf[offset], 2);
      h264.nalUnitPayloadType = (0, src_1.getBit)(buf[offset], 3, 5);
      offset++;
    }
    // Single-time aggregation packet
    if (h264.nalUnitType === exports.NalUnitType.stap_a) {
      let stapOffset = stap_aHeaderSize;
      let result = Buffer.alloc(0);
      while (stapOffset < buf.length) {
        if (stapOffset + stap_aNALULengthSize > buf.length) {
          throw new Error("H.264 STAP-A: NALU size field exceeds buffer");
        }
        const naluSize = buf.readUInt16BE(stapOffset);
        stapOffset += stap_aNALULengthSize;
        if (stapOffset + naluSize > buf.length) {
          throw new Error(`H.264 STAP-A: NALU size ${naluSize} exceeds buffer`);
        }
        if (naluSize > 0) {
          h264.aggregatedNalUnitTypes.push(
            (0, src_1.getBit)(buf[stapOffset], 3, 5),
          );
        }
        result = Buffer.concat([
          result,
          this.packaging(buf.subarray(stapOffset, stapOffset + naluSize)),
        ]);
        stapOffset += naluSize;
      }
      h264.payload = result;
    }
    // Fragmentation Units
    else if (h264.nalUnitType === exports.NalUnitType.fu_a) {
      if (!fragment) {
        fragment = Buffer.alloc(0);
      }
      const fu = buf.subarray(offset);
      h264.fragment = Buffer.concat([fragment, fu]);
      if (h264.e && h264.nalUnitPayloadType !== undefined) {
        const bitStream = new src_1.BitStream(Buffer.alloc(1))
          .writeBits(1, 0)
          .writeBits(2, h264.nri)
          .writeBits(5, h264.nalUnitPayloadType);
        const nalu = Buffer.concat([bitStream.uint8Array, h264.fragment]);
        h264.fragment = undefined;
        h264.payload = this.packaging(nalu);
      }
    }
    return h264;
  }
  static packaging(buf) {
    return Buffer.concat([annex_bNALUStartCode, buf]);
  }
  static isDetectedFinalPacketInSequence(header) {
    return header.marker;
  }
  /** true only when this packet carries (a part of) an IDR slice */
  get isKeyframe() {
    switch (this.nalUnitType) {
      case exports.NalUnitType.idrSlice:
        return true;
      case exports.NalUnitType.fu_a:
      case exports.NalUnitType.fu_b:
        return this.nalUnitPayloadType === exports.NalUnitType.idrSlice;
      case exports.NalUnitType.stap_a:
        return this.aggregatedNalUnitTypes.includes(
          exports.NalUnitType.idrSlice,
        );
      default:
        return false;
    }
  }
  get isPartitionHead() {
    if (
      this.nalUnitType === exports.NalUnitType.fu_a ||
      this.nalUnitType === exports.NalUnitType.fu_b
    ) {
      return this.s !== 0;
    }
    return true;
  }
}
exports.H264RtpPayload = H264RtpPayload;
exports.NalUnitType = {
  idrSlice: 5,
  sps: 7,
  pps: 8,
  stap_a: 24,
  stap_b: 25,
  mtap16: 26,
  mtap24: 27,
  fu_a: 28,
  fu_b: 29,
};
const annex_bNALUStartCode = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const stap_aHeaderSize = 1;
const stap_aNALULengthSize = 2;
// ---------------------------------------------------------------------------
// Annex-B / length-prefixed (AVCC) NAL splitting
// Annex-B syntax splitting is codec-agnostic (start codes only) and shared with
// H.265; NAL contents are never interpreted or filtered at this stage.
// ---------------------------------------------------------------------------
function looksLikeAnnexB(sample) {
  if (sample.length < 3) {
    return false;
  }
  return (
    (sample[0] === 0 &&
      sample[1] === 0 &&
      sample[2] === 0 &&
      sample[3] === 1) ||
    (sample[0] === 0 && sample[1] === 0 && sample[2] === 1)
  );
}
function readUintLength(buf, offset, size) {
  if (size === 1) return buf[offset];
  if (size === 2) return buf.readUInt16BE(offset);
  if (size === 3) {
    return (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
  }
  return buf.readUInt32BE(offset);
}
/**
 * Split H.264 sample into NAL units (no start codes).
 * Accepts Annex-B (start-code split, no NAL type filtering) or length-prefixed (AVCC).
 */
function splitH264NalUnits(sample, naluLengthSize = 4, inputFormat = "auto") {
  if (
    naluLengthSize < 1 ||
    naluLengthSize > 4 ||
    !Number.isInteger(naluLengthSize)
  ) {
    throw new Error(
      `H.264 naluLengthSize must be an integer 1–4, got ${naluLengthSize}`,
    );
  }
  if (sample.length === 0) {
    return [];
  }
  const format =
    inputFormat === "auto"
      ? looksLikeAnnexB(sample)
        ? "annexb"
        : "length-prefixed"
      : inputFormat;
  if (format === "annexb") {
    if (!looksLikeAnnexB(sample)) {
      throw new Error(
        "H.264 inputFormat annexb: sample does not start with a start code",
      );
    }
    // Pure syntax split. H264AnnexBParser (MP4 demux helper) drops NAL types
    // >= 14 (prefix NAL, subset SPS, slice extension, ...), but RFC 6184 §5.6
    // carries types 1-23 as Single NAL units, so nothing may be filtered here.
    return new h265_1.H265AnnexBParser(sample).readAll();
  }
  const prefixed = parseLengthPrefixed(sample, naluLengthSize);
  if (prefixed.nalus) {
    return prefixed.nalus;
  }
  throw new Error(prefixed.error);
}
function parseLengthPrefixed(sample, naluLengthSize) {
  const nalus = [];
  let offset = 0;
  while (offset < sample.length) {
    if (offset + naluLengthSize > sample.length) {
      return { error: "H.264 length-prefixed sample truncated (length field)" };
    }
    const length = readUintLength(sample, offset, naluLengthSize);
    offset += naluLengthSize;
    if (length === 0) {
      return { error: "H.264 length-prefixed sample: NAL length 0 is invalid" };
    }
    if (offset + length > sample.length) {
      return {
        error: `H.264 length-prefixed sample: NAL length ${length} exceeds buffer`,
      };
    }
    nalus.push(sample.subarray(offset, offset + length));
    offset += length;
  }
  return { nalus, error: "" };
}
function h264NalType(nal) {
  if (nal.length < 1) return 0;
  return nal[0] & 0x1f;
}
function isH264ParameterSet(type) {
  return type === exports.NalUnitType.sps || type === exports.NalUnitType.pps;
}
/**
 * From configured `parameterSets`, return only those whose type is not already
 * present in the sample (SPS and PPS checked independently).
 * E.g. sample with SPS-only → only missing PPS are returned.
 */
function selectMissingH264ParameterSets(parameterSets, nalUnits) {
  const hasSps = nalUnits.some(
    (n) => h264NalType(n) === exports.NalUnitType.sps,
  );
  const hasPps = nalUnits.some(
    (n) => h264NalType(n) === exports.NalUnitType.pps,
  );
  return parameterSets.filter((ps) => {
    const t = h264NalType(ps);
    if (t === exports.NalUnitType.sps) return !hasSps;
    if (t === exports.NalUnitType.pps) return !hasPps;
    return false;
  });
}
/**
 * Build STAP-A payload (RFC 6184 §5.7.1 / Figure 7):
 *   STAP-A header (F/NRI/Type=24) + repeated [16-bit NALU size][NAL]
 * F = OR of F of aggregated NALs; NRI = max of NRI of aggregated NALs.
 */
/** Minimum NAL size: 1-byte header + at least 1 payload octet (packetizer contract). */
exports.H264_MIN_NAL_LENGTH = 2;
/**
 * End of sequence (10) / end of stream (11) NALs have an empty RBSP, so the
 * 1-byte header alone is valid (ITU-T H.264 §7.4.1.2.4 / §7.3.2.5-6).
 */
function minH264NalLength(nal) {
  const type = nal.length > 0 ? nal[0] & 0x1f : 0;
  return type === 10 || type === 11 ? 1 : exports.H264_MIN_NAL_LENGTH;
}
function buildH264StapA(nalus) {
  if (nalus.length < 2) {
    throw new Error("H.264 STAP-A requires at least two NAL units");
  }
  let f = 0;
  let nri = 0;
  for (const n of nalus) {
    if (n.length < minH264NalLength(n)) {
      throw new Error(
        `H.264 STAP-A: NAL unit too short (need ≥${minH264NalLength(n)} bytes, got ${n.length})`,
      );
    }
    if (n.length > 0xffff) {
      throw new Error("H.264 NAL unit too large for STAP-A size field");
    }
    f |= (n[0] >> 7) & 1;
    const nriN = (n[0] >> 5) & 0x03;
    if (nriN > nri) nri = nriN;
  }
  const header = Buffer.from([
    (f << 7) | (nri << 5) | exports.NalUnitType.stap_a,
  ]);
  const parts = [header];
  for (const n of nalus) {
    const size = Buffer.alloc(2);
    size.writeUInt16BE(n.length, 0);
    parts.push(size, n);
  }
  return Buffer.concat(parts);
}
/**
 * Packetize H.264 access units (Annex-B or length-prefixed) for mode=1.
 * Single NAL / STAP-A (SPS+PPS) / FU-A fragmentation (RFC 6184).
 */
class H264Packetizer extends base_1.PacketizerBase {
  constructor(options = {}) {
    super(options);
    Object.defineProperty(this, "naluLengthSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "inputFormat", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "parameterSets", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "defaultIsKeyframe", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    const nls = options.naluLengthSize ?? 4;
    if (nls < 1 || nls > 4 || !Number.isInteger(nls)) {
      throw new Error(
        `H264Packetizer: naluLengthSize must be an integer 1–4, got ${nls}`,
      );
    }
    this.naluLengthSize = nls;
    this.inputFormat = options.inputFormat ?? "auto";
    this.parameterSets = options.parameterSets ?? [];
    this.defaultIsKeyframe = options.isKeyframe;
  }
  packetize(data, rtpTimestamp, options = {}) {
    let nalUnits = splitH264NalUnits(
      data,
      this.naluLengthSize,
      this.inputFormat,
    );
    if (nalUnits.length === 0) {
      return [];
    }
    const hasIdr = nalUnits.some(
      (n) => h264NalType(n) === exports.NalUnitType.idrSlice,
    );
    const isKey = options.isKeyframe ?? this.defaultIsKeyframe ?? hasIdr;
    // Prepend only parameter-set types absent from the sample (SPS ≠ PPS).
    if (isKey && this.parameterSets.length > 0) {
      const missing = selectMissingH264ParameterSets(
        this.parameterSets,
        nalUnits,
      );
      if (missing.length > 0) {
        // An access unit delimiter (type 9) must stay first in the AU, so the
        // parameter sets go right after it (ITU-T H.264 §7.4.1.2.3).
        const at = nalUnits.findIndex((n) => h264NalType(n) !== 9);
        const insertAt = at === -1 ? nalUnits.length : at;
        nalUnits = [
          ...nalUnits.slice(0, insertAt),
          ...missing,
          ...nalUnits.slice(insertAt),
        ];
      }
    }
    const packets = [];
    // Try STAP-A for leading parameter sets (SPS/PPS), same policy as H265 AP
    let index = 0;
    if (nalUnits.length >= 2 && isH264ParameterSet(h264NalType(nalUnits[0]))) {
      const aggregated = [];
      let stapSize = 1; // STAP-A header
      while (
        index < nalUnits.length &&
        isH264ParameterSet(h264NalType(nalUnits[index]))
      ) {
        const n = nalUnits[index];
        const need = 2 + n.length;
        if (stapSize + need > this.maxPayloadSize) {
          break;
        }
        aggregated.push(n);
        stapSize += need;
        index++;
      }
      // STAP-A requires at least two NAL units (RFC 6184 §5.7.1)
      if (aggregated.length >= 2) {
        const isLast = index >= nalUnits.length;
        packets.push(
          this.buildPacket(buildH264StapA(aggregated), rtpTimestamp, isLast),
        );
      } else {
        // Cannot STAP-A (one set only, or too large) → fall back to Single NAL
        index = 0;
      }
    }
    for (; index < nalUnits.length; index++) {
      const nal = nalUnits[index];
      const marker = index === nalUnits.length - 1;
      // Reject empty NALs and 1-byte NALs other than end-of-seq/stream (FU needs ≥2 octets)
      if (nal.length < minH264NalLength(nal)) {
        throw new Error(
          `H.264 NAL unit too short: expected at least ${minH264NalLength(nal)} bytes (NAL header + data), got ${nal.length}`,
        );
      }
      if (nal.length <= this.maxPayloadSize) {
        // Single NAL Unit Packet (RFC 6184 §5.6)
        packets.push(this.buildPacket(nal, rtpTimestamp, marker));
        continue;
      }
      // FU-A (RFC 6184 §5.8)
      const nalHeader = nal[0];
      const fragmentPayload = nal.subarray(1);
      const fragmentSize = this.maxPayloadSize - 2; // FU indicator + FU header
      if (fragmentSize <= 0) {
        throw new Error("invalid H.264 RTP maxPayloadSize for FU-A");
      }
      const fuIndicator = (nalHeader & 0xe0) | exports.NalUnitType.fu_a;
      const nalType = nalHeader & 0x1f;
      for (
        let offset = 0;
        offset < fragmentPayload.length;
        offset += fragmentSize
      ) {
        const chunk = fragmentPayload.subarray(
          offset,
          Math.min(fragmentPayload.length, offset + fragmentSize),
        );
        const isStart = offset === 0;
        const isEnd = offset + chunk.length >= fragmentPayload.length;
        // S|E|R|Type
        const fuHeader = Buffer.from([
          (isStart ? 0x80 : 0x00) | (isEnd ? 0x40 : 0x00) | nalType,
        ]);
        packets.push(
          this.buildPacket(
            Buffer.concat([Buffer.from([fuIndicator]), fuHeader, chunk]),
            rtpTimestamp,
            marker && isEnd,
          ),
        );
      }
    }
    return packets;
  }
}
exports.H264Packetizer = H264Packetizer;
/**
 * Parse an avcC record (e.g. WebCodecs / mediabunny `decoderConfig.description`)
 * into the NAL length size and SPS/PPS NAL units (no length prefix).
 * Throws on a truncated record instead of returning partial parameter sets.
 */
function parseAvcDecoderConfigurationRecord(description) {
  const record = ArrayBuffer.isView(description)
    ? Buffer.from(
        description.buffer,
        description.byteOffset,
        description.byteLength,
      )
    : Buffer.from(description);
  if (record.length < 7) {
    throw new Error(
      `invalid H.264 avcC: expected at least 7 bytes, got ${record.length}`,
    );
  }
  const naluLengthSize = (record[4] & 0x03) + 1;
  let offset = 5;
  const readSets = (count) => {
    const sets = [];
    for (let i = 0; i < count; i++) {
      if (offset + 2 > record.length) {
        throw new Error("invalid H.264 avcC: truncated parameter set length");
      }
      const length = record.readUInt16BE(offset);
      offset += 2;
      if (offset + length > record.length) {
        throw new Error("invalid H.264 avcC: truncated parameter set");
      }
      sets.push(record.subarray(offset, offset + length));
      offset += length;
    }
    return sets;
  };
  const sps = readSets(record[offset++] & 0x1f);
  const pps = offset < record.length ? readSets(record[offset++]) : [];
  return { naluLengthSize, sps, pps, parameterSets: [...sps, ...pps] };
}
//# sourceMappingURL=h264.js.map
