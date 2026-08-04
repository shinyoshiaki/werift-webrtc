// RFC 7798 — RTP Payload Format for High Efficiency Video Coding (HEVC)
//
// PayloadHdr (2 octets, same layout as HEVC NAL unit header) §4.4:
//   F(1) | Type(6) | LayerId(6) | TID(3)
// Packet types (Type field) — RFC 7798 is authoritative (ticket "Type 0=AP, 1=FU"
// was incorrect):
//   48 = Aggregation Packet (AP)  §4.4.2
//   49 = Fragmentation Unit (FU)  §4.4.3
//   other (0–47, 50–63) = Single NAL unit packet §4.4.1
// F bit on FU: MUST equal F of the fragmented NAL unit (RFC 7798 §4.4.3),
// not forced to 1.
//
// DONL is omitted for non-interleaved mode (sprop-max-don-diff = 0).
// Depacketizer can skip DONL when `hasDonl` is set.
// Output frames are Annex-B (00 00 00 01 prefixed), matching H264RtpPayload.
// isKeyframe: IRAP NAL types 16–21 (BLA_W_LP … CRA_NUT), including IRAP inside AP.

import { getBit } from "../../../common/src";
import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";

/** RFC 7798 §4.4.2 Aggregation Packet type. */
export const H265_PAYLOAD_TYPE_AP = 48;
/** RFC 7798 §4.4.3 Fragmentation Unit type. */
export const H265_PAYLOAD_TYPE_FU = 49;

/** IRAP picture NAL unit types (HEVC); used for isKeyframe. */
export const H265_IRAP_NAL_TYPES = {
  BLA_W_LP: 16,
  BLA_W_RADL: 17,
  BLA_N_LP: 18,
  IDR_W_RADL: 19,
  IDR_N_LP: 20,
  CRA_NUT: 21,
} as const;

export const H265_NAL_TYPE = {
  VPS: 32,
  SPS: 33,
  PPS: 34,
  AUD: 35,
  ...H265_IRAP_NAL_TYPES,
  AP: H265_PAYLOAD_TYPE_AP,
  FU: H265_PAYLOAD_TYPE_FU,
} as const;

const annexBStartCode = Buffer.from([0x00, 0x00, 0x00, 0x01]);

export type H265PayloadHeader = {
  f: number;
  type: number;
  layerId: number;
  tid: number;
};

export function parseH265PayloadHeader(buf: Buffer): H265PayloadHeader {
  if (buf.length < 2) {
    throw new Error(
      `H.265 payload header too short: expected 2 bytes, got ${buf.length}`,
    );
  }
  const b0 = buf[0];
  const b1 = buf[1];
  return {
    f: getBit(b0, 0, 1),
    type: getBit(b0, 1, 6),
    layerId: (getBit(b0, 7, 1) << 5) | getBit(b1, 0, 5),
    tid: getBit(b1, 5, 3),
  };
}

export function writeH265PayloadHeader(h: H265PayloadHeader): Buffer {
  const b0 = ((h.f & 1) << 7) | ((h.type & 0x3f) << 1) | ((h.layerId >> 5) & 1);
  const b1 = ((h.layerId & 0x1f) << 3) | (h.tid & 0x07);
  return Buffer.from([b0, b1]);
}

function isIrapType(type: number): boolean {
  return type >= 16 && type <= 21;
}

function packageAnnexB(nal: Buffer): Buffer {
  return Buffer.concat([annexBStartCode, nal]);
}

export type H265DepacketizerOptions = {
  /**
   * When true, skip conditional DONL (2 bytes) after PayloadHdr for single NAL
   * and after FU header when S=1 (RFC 7798 DONL presence via sprop-max-don-diff > 0).
   * Default false (non-interleaved).
   */
  hasDonl?: boolean;
};

export class H265RtpPayload implements DePacketizerBase {
  f = 0;
  type = 0;
  layerId = 0;
  tid = 0;
  /** FU start bit (S). */
  s = 0;
  /** FU end bit (E). */
  e = 0;
  /** FU FuType (original NAL type). */
  fuType = 0;
  /** True when an AP contained at least one IRAP NAL (types 16–21). */
  private apContainsIrap = false;
  payload!: Buffer;
  fragment?: Buffer;

  static deSerialize(
    buf: Buffer,
    fragment?: Buffer,
    options: H265DepacketizerOptions = {},
  ): H265RtpPayload {
    const h265 = new H265RtpPayload();
    if (buf.length < 2) {
      throw new Error(
        `H.265 RTP payload too short: expected at least 2 bytes, got ${buf.length}`,
      );
    }

    const hdr = parseH265PayloadHeader(buf);
    h265.f = hdr.f;
    h265.type = hdr.type;
    h265.layerId = hdr.layerId;
    h265.tid = hdr.tid;

    // Aggregation Packet (RFC 7798 §4.4.2)
    if (hdr.type === H265_PAYLOAD_TYPE_AP) {
      let offset = 2;
      // Optional DONL on first aggregation unit only
      if (options.hasDonl) {
        if (offset + 2 > buf.length) {
          throw new Error("H.265 AP: DONL exceeds buffer");
        }
        offset += 2;
      }

      const parts: Buffer[] = [];
      let first = true;
      while (offset < buf.length) {
        // Subsequent units may have DOND (1 byte) when DON is used
        if (!first && options.hasDonl) {
          if (offset + 1 > buf.length) {
            throw new Error("H.265 AP: DOND exceeds buffer");
          }
          offset += 1;
        }
        if (offset + 2 > buf.length) {
          throw new Error("H.265 AP: NALU size field exceeds buffer");
        }
        const naluSize = buf.readUInt16BE(offset);
        offset += 2;
        if (naluSize < 2) {
          throw new Error(
            `H.265 AP: NALU size ${naluSize} too small for header`,
          );
        }
        if (offset + naluSize > buf.length) {
          throw new Error(
            `H.265 AP: NALU size ${naluSize} at offset ${offset} exceeds buffer ${buf.length}`,
          );
        }
        const nalu = buf.subarray(offset, offset + naluSize);
        if (isIrapType(nalTypeOf(nalu))) {
          h265.apContainsIrap = true;
        }
        parts.push(packageAnnexB(nalu));
        offset += naluSize;
        first = false;
      }
      if (parts.length === 0) {
        throw new Error("H.265 AP: no aggregation units in payload");
      }
      h265.payload = Buffer.concat(parts);
      return h265;
    }

    // Fragmentation Unit (RFC 7798 §4.4.3)
    if (hdr.type === H265_PAYLOAD_TYPE_FU) {
      if (buf.length < 3) {
        throw new Error("H.265 FU: payload shorter than PayloadHdr+FU header");
      }
      const fuHeader = buf[2];
      h265.s = getBit(fuHeader, 0, 1);
      h265.e = getBit(fuHeader, 1, 1);
      h265.fuType = getBit(fuHeader, 2, 6);

      let offset = 3;
      if (options.hasDonl && h265.s) {
        if (offset + 2 > buf.length) {
          throw new Error("H.265 FU: DONL exceeds buffer");
        }
        offset += 2;
      }

      const fuPayload = buf.subarray(offset);
      if (fuPayload.length === 0) {
        throw new Error("H.265 FU: empty FU payload (RFC 7798 forbids empty)");
      }

      // On start: reconstruct NAL header (F, LayerId, TID from PayloadHdr; Type from FuType)
      // Non-start FU without prior fragment is malformed (RFC 7798 §4.4.3 order).
      let acc: Buffer;
      if (h265.s) {
        const nalHeader = writeH265PayloadHeader({
          f: h265.f,
          type: h265.fuType,
          layerId: h265.layerId,
          tid: h265.tid,
        });
        acc = Buffer.concat([nalHeader, fuPayload]);
      } else {
        if (!fragment || fragment.length === 0) {
          throw new Error(
            "H.265 FU: received non-start fragment (S=0) without prior FU start (S=1)",
          );
        }
        acc = Buffer.concat([fragment, fuPayload]);
      }

      if (h265.e) {
        h265.fragment = undefined;
        h265.payload = packageAnnexB(acc);
      } else {
        h265.fragment = acc;
      }
      return h265;
    }

    // Single NAL unit packet (RFC 7798 §4.4.1)
    // Wire: PayloadHdr (= NAL header) [+ DONL] + NAL body
    let bodyStart = 2;
    if (options.hasDonl) {
      if (buf.length < 4) {
        throw new Error("H.265 single NAL: DONL exceeds buffer");
      }
      bodyStart = 4;
    }
    const nal = Buffer.concat([buf.subarray(0, 2), buf.subarray(bodyStart)]);
    h265.payload = packageAnnexB(nal);
    return h265;
  }

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return header.marker;
  }

  get isKeyframe() {
    if (this.type === H265_PAYLOAD_TYPE_FU) {
      return isIrapType(this.fuType);
    }
    if (this.type === H265_PAYLOAD_TYPE_AP) {
      // Scan aggregation units at deSerialize time for IRAP (types 16–21)
      return this.apContainsIrap;
    }
    return isIrapType(this.type);
  }

  get isPartitionHead() {
    if (this.type === H265_PAYLOAD_TYPE_FU) {
      return this.s !== 0;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Annex-B / length-prefixed (HVCC) NAL splitting
// ---------------------------------------------------------------------------

export class H265AnnexBParser {
  private data: Buffer;
  private currentStartcodeOffset = 0;
  private eof = false;

  constructor(data: Buffer) {
    this.data = data;
    this.currentStartcodeOffset = this.findNextStartCodeOffset(0);
  }

  private findNextStartCodeOffset(start: number): number {
    const data = this.data;
    let i = start;
    for (;;) {
      if (i + 3 >= data.length) {
        this.eof = true;
        return data.length;
      }
      const u32 =
        (data[i] << 24) |
        (data[i + 1] << 16) |
        (data[i + 2] << 8) |
        data[i + 3];
      const u24 = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      if (u32 === 0x00000001 || u24 === 0x000001) {
        return i;
      }
      i++;
    }
  }

  /** Returns next NAL unit without start code, or null at EOF. */
  readNextNalu(): Buffer | null {
    if (this.eof) {
      return null;
    }
    const startcodeOffset = this.currentStartcodeOffset;
    let offset = startcodeOffset;
    const u32 =
      (this.data[offset] << 24) |
      (this.data[offset + 1] << 16) |
      (this.data[offset + 2] << 8) |
      this.data[offset + 3];
    offset += u32 === 0x00000001 ? 4 : 3;

    const next = this.findNextStartCodeOffset(offset);
    this.currentStartcodeOffset = next;
    if (offset >= next) {
      return this.eof ? null : this.readNextNalu();
    }
    return this.data.subarray(offset, next);
  }

  readAll(): Buffer[] {
    const nalus: Buffer[] = [];
    let n = this.readNextNalu();
    while (n) {
      nalus.push(n);
      n = this.readNextNalu();
    }
    return nalus;
  }
}

function looksLikeAnnexB(sample: Buffer): boolean {
  if (sample.length < 4) {
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

function readUintLength(buf: Buffer, offset: number, size: number): number {
  if (size === 1) return buf[offset];
  if (size === 2) return buf.readUInt16BE(offset);
  if (size === 3) {
    return (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
  }
  return buf.readUInt32BE(offset);
}

/**
 * Split H.265 sample into NAL units.
 * Accepts Annex-B (start codes) or length-prefixed (HVCC) with `naluLengthSize`.
 */
export function splitH265NalUnits(
  sample: Buffer,
  naluLengthSize = 4,
): Buffer[] {
  if (
    naluLengthSize < 1 ||
    naluLengthSize > 4 ||
    !Number.isInteger(naluLengthSize)
  ) {
    throw new Error(
      `H.265 naluLengthSize must be an integer 1–4, got ${naluLengthSize}`,
    );
  }
  if (sample.length === 0) {
    return [];
  }
  if (looksLikeAnnexB(sample)) {
    return new H265AnnexBParser(sample).readAll();
  }

  const nalus: Buffer[] = [];
  let offset = 0;
  while (offset < sample.length) {
    if (offset + naluLengthSize > sample.length) {
      throw new Error("H.265 length-prefixed sample truncated (length field)");
    }
    const length = readUintLength(sample, offset, naluLengthSize);
    offset += naluLengthSize;
    if (length === 0) {
      throw new Error("H.265 length-prefixed sample: NAL length 0 is invalid");
    }
    if (offset + length > sample.length) {
      throw new Error(
        `H.265 length-prefixed sample: NAL length ${length} exceeds buffer`,
      );
    }
    nalus.push(sample.subarray(offset, offset + length));
    offset += length;
  }
  return nalus;
}

function nalTypeOf(nal: Buffer): number {
  if (nal.length < 2) {
    return 0;
  }
  return parseH265PayloadHeader(nal).type;
}

// ---------------------------------------------------------------------------
// Packetizer
// ---------------------------------------------------------------------------

export type H265PacketizerOptions = PacketizerBaseOptions & {
  /** Length field size for HVCC input (default 4). Ignored for Annex-B. */
  naluLengthSize?: number;
  /**
   * Parameter sets (VPS/SPS/PPS as raw NAL units without start codes).
   * Prepended via AP on keyframe when not already present in the sample.
   */
  parameterSets?: Buffer[];
};

export class H265Packetizer extends PacketizerBase {
  private readonly naluLengthSize: number;
  private readonly parameterSets: Buffer[];

  constructor(options: H265PacketizerOptions = {}) {
    super(options);
    const nls = options.naluLengthSize ?? 4;
    if (nls < 1 || nls > 4 || !Number.isInteger(nls)) {
      throw new Error(
        `H265Packetizer: naluLengthSize must be an integer 1–4, got ${nls}`,
      );
    }
    this.naluLengthSize = nls;
    this.parameterSets = options.parameterSets ?? [];
  }

  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[] {
    let nalUnits = splitH265NalUnits(data, this.naluLengthSize);
    if (nalUnits.length === 0) {
      return [];
    }

    const hasIrap = nalUnits.some((n) => isIrapType(nalTypeOf(n)));
    if (
      hasIrap &&
      this.parameterSets.length > 0 &&
      !containsParameterSets(nalUnits)
    ) {
      nalUnits = [...this.parameterSets, ...nalUnits];
    }

    const packets: RtpPacket[] = [];

    // Try to aggregate small leading parameter sets into an AP
    let index = 0;
    if (nalUnits.length >= 2 && isParameterSet(nalTypeOf(nalUnits[0]))) {
      const aggregated: Buffer[] = [];
      let apSize = 2; // PayloadHdr
      while (
        index < nalUnits.length &&
        isParameterSet(nalTypeOf(nalUnits[index]))
      ) {
        const n = nalUnits[index];
        const need = 2 + n.length;
        if (aggregated.length > 0 && apSize + need > this.maxPayloadSize) {
          break;
        }
        if (aggregated.length === 0 && apSize + need > this.maxPayloadSize) {
          break;
        }
        aggregated.push(n);
        apSize += need;
        index++;
      }
      // AP requires at least two NAL units (RFC 7798 §4.4.2)
      if (aggregated.length >= 2) {
        const isLast = index >= nalUnits.length;
        packets.push(
          this.buildPacket(
            buildAggregationPacket(aggregated),
            rtpTimestamp,
            isLast,
          ),
        );
      } else {
        // Not enough for AP — send individually
        index = 0;
      }
    }

    for (; index < nalUnits.length; index++) {
      const nal = nalUnits[index];
      const marker = index === nalUnits.length - 1;
      if (nal.length <= this.maxPayloadSize) {
        // Single NAL unit packet: NAL unit is the payload (no DONL)
        packets.push(this.buildPacket(nal, rtpTimestamp, marker));
        continue;
      }

      // FU fragmentation (RFC 7798 §4.4.3)
      if (nal.length < 3) {
        throw new Error("H.265 NAL too short to fragment");
      }
      const nalHdr = parseH265PayloadHeader(nal);
      const fuPayloadHdr = writeH265PayloadHeader({
        f: nalHdr.f,
        type: H265_PAYLOAD_TYPE_FU,
        layerId: nalHdr.layerId,
        tid: nalHdr.tid,
      });
      // NAL body excludes 2-byte NAL header
      const body = nal.subarray(2);
      // FU overhead: PayloadHdr(2) + FU header(1)
      const fragmentSize = this.maxPayloadSize - 3;
      if (fragmentSize <= 0) {
        throw new Error("invalid H.265 RTP maxPayloadSize for FU");
      }

      for (let offset = 0; offset < body.length; offset += fragmentSize) {
        const chunk = body.subarray(
          offset,
          Math.min(body.length, offset + fragmentSize),
        );
        const isStart = offset === 0;
        const isEnd = offset + chunk.length >= body.length;
        // S(1) E(1) FuType(6)
        const fuHeader = Buffer.from([
          (isStart ? 0x80 : 0x00) |
            (isEnd ? 0x40 : 0x00) |
            (nalHdr.type & 0x3f),
        ]);
        packets.push(
          this.buildPacket(
            Buffer.concat([fuPayloadHdr, fuHeader, chunk]),
            rtpTimestamp,
            marker && isEnd,
          ),
        );
      }
    }

    return packets;
  }
}

function isParameterSet(type: number): boolean {
  return (
    type === H265_NAL_TYPE.VPS ||
    type === H265_NAL_TYPE.SPS ||
    type === H265_NAL_TYPE.PPS
  );
}

function containsParameterSets(nalus: Buffer[]): boolean {
  const types = new Set(nalus.map(nalTypeOf));
  return (
    types.has(H265_NAL_TYPE.VPS) &&
    types.has(H265_NAL_TYPE.SPS) &&
    types.has(H265_NAL_TYPE.PPS)
  );
}

/** Build AP payload without DONL (RFC 7798 Figure 7). */
/**
 * Build AP payload without DONL (RFC 7798 §4.4.2 / Figure 7).
 * PayloadHdr (RFC 7798 p.25):
 *   F = OR of F of all aggregated NAL units (0 only if every F is 0)
 *   Type = 48
 *   LayerId = lowest LayerId among aggregated NAL units
 *   TID = lowest TID among aggregated NAL units
 */
function buildAggregationPacket(nalus: Buffer[]): Buffer {
  if (nalus.length < 2) {
    throw new Error("H.265 AP requires at least two NAL units");
  }
  const headers = nalus.map((n) => {
    if (n.length < 2) {
      throw new Error("H.265 AP: NAL unit shorter than 2-byte header");
    }
    return parseH265PayloadHeader(n);
  });
  let f = 0;
  let layerId = headers[0].layerId;
  let tid = headers[0].tid;
  for (const h of headers) {
    f |= h.f;
    if (h.layerId < layerId) layerId = h.layerId;
    if (h.tid < tid) tid = h.tid;
  }
  const hdr = writeH265PayloadHeader({
    f,
    type: H265_PAYLOAD_TYPE_AP,
    layerId,
    tid,
  });
  const parts: Buffer[] = [hdr];
  for (const n of nalus) {
    if (n.length > 0xffff) {
      throw new Error("H.265 NAL unit too large for AP size field");
    }
    const size = Buffer.alloc(2);
    size.writeUInt16BE(n.length, 0);
    parts.push(size, n);
  }
  return Buffer.concat(parts);
}
