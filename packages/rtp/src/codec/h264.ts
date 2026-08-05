// RFC 6184 — RTP Payload Format for H.264 Video
// docs/rfc/rfc6184.txt
//
// Packetizer targets packetization-mode=1 (Non-Interleaved):
//   Single NAL (§5.6), STAP-A Type=24 (§5.7.1), FU-A Type=28 (§5.8).
// Keyframe SPS/PPS: STAP-A preferred when ≥2 parameter sets fit MTU;
// fallback is individual Single NAL (same policy as H265Packetizer AP).
// Depacketizer output is Annex-B (00 00 00 01 prefixed) for each NAL.

import { BitStream, getBit } from "../../../common/src";
import { H264AnnexBParser } from "../extra/container/mp4/h264";
import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";

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

export class H264RtpPayload implements DePacketizerBase {
  /**forbidden_zero_bit */
  f!: number;
  /**nal_ref_idc */
  nri!: number;
  /**nal_unit_types */
  nalUnitType!: number;
  /**start of a fragmented NAL unit */
  s!: number;
  /**end of a fragmented NAL unit */
  e!: number;
  r!: number;
  nalUnitPayloadType!: number;
  payload!: Buffer;
  fragment?: Buffer;

  static deSerialize(buf: Buffer, fragment?: Buffer) {
    const h264 = new H264RtpPayload();

    let offset = 0;

    const naluHeader = buf[offset];
    h264.f = getBit(naluHeader, 0);
    h264.nri = getBit(naluHeader, 1, 2);
    h264.nalUnitType = getBit(naluHeader, 3, 5);
    offset++;

    h264.s = getBit(buf[offset], 0);
    h264.e = getBit(buf[offset], 1);
    h264.r = getBit(buf[offset], 2);
    h264.nalUnitPayloadType = getBit(buf[offset], 3, 5);
    offset++;

    // デフォルトでは packetization-mode=0
    // packetization-mode=0だとSingle NAL Unit Packetしか来ない
    // https://datatracker.ietf.org/doc/html/rfc6184#section-6.2

    // Single NAL Unit Packet
    if (0 < h264.nalUnitType && h264.nalUnitType < NalUnitType.stap_a) {
      h264.payload = this.packaging(buf);
    }
    // Single-time aggregation packet
    else if (h264.nalUnitType === NalUnitType.stap_a) {
      let offset = stap_aHeaderSize;
      let result: Buffer = Buffer.alloc(0);
      while (offset < buf.length) {
        const naluSize = buf.readUInt16BE(offset);
        offset += stap_aNALULengthSize;

        result = Buffer.concat([
          result,
          this.packaging(buf.subarray(offset, offset + naluSize)),
        ]);
        offset += naluSize;
      }
      h264.payload = result;
    }
    // Fragmentation Units
    else if (h264.nalUnitType === NalUnitType.fu_a) {
      if (!fragment) {
        fragment = Buffer.alloc(0);
      }
      const fu = buf.subarray(offset);
      h264.fragment = Buffer.concat([fragment, fu]);

      if (h264.e) {
        const bitStream = new BitStream(Buffer.alloc(1))
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

  private static packaging(buf: Buffer) {
    return Buffer.concat([annex_bNALUStartCode, buf]);
  }

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return header.marker;
  }

  get isKeyframe() {
    return (
      this.nalUnitType === NalUnitType.idrSlice ||
      this.nalUnitPayloadType === NalUnitType.idrSlice
    );
  }

  get isPartitionHead() {
    if (
      this.nalUnitType === NalUnitType.fu_a ||
      this.nalUnitType === NalUnitType.fu_b
    ) {
      return this.s !== 0;
    }

    return true;
  }
}

export const NalUnitType = {
  idrSlice: 5,
  sps: 7,
  pps: 8,
  stap_a: 24,
  stap_b: 25,
  mtap16: 26,
  mtap24: 27,
  fu_a: 28,
  fu_b: 29,
} as const;

const annex_bNALUStartCode = Buffer.from([0x00, 0x00, 0x00, 0x01]);

const stap_aHeaderSize = 1;
const stap_aNALULengthSize = 2;

// ---------------------------------------------------------------------------
// Annex-B / length-prefixed (AVCC) NAL splitting
// Uses shared H264AnnexBParser (extra/container/mp4) — no duplicate splitter.
// ---------------------------------------------------------------------------

function looksLikeAnnexB(sample: Buffer): boolean {
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

function readUintLength(buf: Buffer, offset: number, size: number): number {
  if (size === 1) return buf[offset];
  if (size === 2) return buf.readUInt16BE(offset);
  if (size === 3) {
    return (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
  }
  return buf.readUInt32BE(offset);
}

/**
 * Split H.264 sample into NAL units (no start codes).
 * Accepts Annex-B (via shared `H264AnnexBParser`) or length-prefixed (AVCC).
 */
export function splitH264NalUnits(
  sample: Buffer,
  naluLengthSize = 4,
): Buffer[] {
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
  if (looksLikeAnnexB(sample)) {
    const parser = new H264AnnexBParser(sample);
    const nalus: Buffer[] = [];
    let payload = parser.readNextNaluPayload();
    while (payload) {
      nalus.push(Buffer.from(payload.data));
      payload = parser.readNextNaluPayload();
    }
    return nalus;
  }

  const nalus: Buffer[] = [];
  let offset = 0;
  while (offset < sample.length) {
    if (offset + naluLengthSize > sample.length) {
      throw new Error("H.264 length-prefixed sample truncated (length field)");
    }
    const length = readUintLength(sample, offset, naluLengthSize);
    offset += naluLengthSize;
    if (length === 0) {
      throw new Error("H.264 length-prefixed sample: NAL length 0 is invalid");
    }
    if (offset + length > sample.length) {
      throw new Error(
        `H.264 length-prefixed sample: NAL length ${length} exceeds buffer`,
      );
    }
    nalus.push(sample.subarray(offset, offset + length));
    offset += length;
  }
  return nalus;
}

function h264NalType(nal: Buffer): number {
  if (nal.length < 1) return 0;
  return nal[0] & 0x1f;
}

function isH264ParameterSet(type: number): boolean {
  return type === NalUnitType.sps || type === NalUnitType.pps;
}

/**
 * From configured `parameterSets`, return only those whose type is not already
 * present in the sample (SPS and PPS checked independently).
 * E.g. sample with SPS-only → only missing PPS are returned.
 */
export function selectMissingH264ParameterSets(
  parameterSets: Buffer[],
  nalUnits: Buffer[],
): Buffer[] {
  const hasSps = nalUnits.some((n) => h264NalType(n) === NalUnitType.sps);
  const hasPps = nalUnits.some((n) => h264NalType(n) === NalUnitType.pps);
  return parameterSets.filter((ps) => {
    const t = h264NalType(ps);
    if (t === NalUnitType.sps) return !hasSps;
    if (t === NalUnitType.pps) return !hasPps;
    return false;
  });
}

/**
 * Build STAP-A payload (RFC 6184 §5.7.1 / Figure 7):
 *   STAP-A header (F/NRI/Type=24) + repeated [16-bit NALU size][NAL]
 * F = OR of F of aggregated NALs; NRI = max of NRI of aggregated NALs.
 */
export function buildH264StapA(nalus: Buffer[]): Buffer {
  if (nalus.length < 2) {
    throw new Error("H.264 STAP-A requires at least two NAL units");
  }
  let f = 0;
  let nri = 0;
  for (const n of nalus) {
    if (n.length < 1) {
      throw new Error("H.264 STAP-A: empty NAL unit");
    }
    if (n.length > 0xffff) {
      throw new Error("H.264 NAL unit too large for STAP-A size field");
    }
    f |= (n[0] >> 7) & 1;
    const nriN = (n[0] >> 5) & 0x03;
    if (nriN > nri) nri = nriN;
  }
  const header = Buffer.from([(f << 7) | (nri << 5) | NalUnitType.stap_a]);
  const parts: Buffer[] = [header];
  for (const n of nalus) {
    const size = Buffer.alloc(2);
    size.writeUInt16BE(n.length, 0);
    parts.push(size, n);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Packetizer (packetization-mode=1)
// ---------------------------------------------------------------------------

export type H264PacketizerOptions = PacketizerBaseOptions & {
  /** Length field size for AVCC input (default 4). Ignored for Annex-B. */
  naluLengthSize?: number;
  /**
   * Parameter sets (SPS/PPS as raw NAL units without start codes).
   * On IDR / keyframe, only types missing from the sample are prepended
   * (SPS and PPS checked independently — partial sample SPS-only gets PPS only).
   * Prefer STAP-A when ≥2 leading sets fit; else individual Single NAL.
   */
  parameterSets?: Buffer[];
  /**
   * Force keyframe path for parameter-set prepending even without IDR NAL.
   * Default: auto-detect IDR (type 5).
   */
  isKeyframe?: boolean;
};

export type H264PacketizeOptions = {
  isKeyframe?: boolean;
};

/**
 * Packetize H.264 access units (Annex-B or length-prefixed) for mode=1.
 * Single NAL / STAP-A (SPS+PPS) / FU-A fragmentation (RFC 6184).
 */
export class H264Packetizer extends PacketizerBase {
  private readonly naluLengthSize: number;
  private readonly parameterSets: Buffer[];
  private readonly defaultIsKeyframe: boolean | undefined;

  constructor(options: H264PacketizerOptions = {}) {
    super(options);
    const nls = options.naluLengthSize ?? 4;
    if (nls < 1 || nls > 4 || !Number.isInteger(nls)) {
      throw new Error(
        `H264Packetizer: naluLengthSize must be an integer 1–4, got ${nls}`,
      );
    }
    this.naluLengthSize = nls;
    this.parameterSets = options.parameterSets ?? [];
    this.defaultIsKeyframe = options.isKeyframe;
  }

  packetize(
    data: Buffer,
    rtpTimestamp: number,
    options: H264PacketizeOptions = {},
  ): RtpPacket[] {
    let nalUnits = splitH264NalUnits(data, this.naluLengthSize);
    if (nalUnits.length === 0) {
      return [];
    }

    const hasIdr = nalUnits.some((n) => h264NalType(n) === NalUnitType.idrSlice);
    const isKey =
      options.isKeyframe ?? this.defaultIsKeyframe ?? hasIdr;

    // Prepend only parameter-set types absent from the sample (SPS ≠ PPS).
    if (isKey && this.parameterSets.length > 0) {
      const missing = selectMissingH264ParameterSets(
        this.parameterSets,
        nalUnits,
      );
      if (missing.length > 0) {
        nalUnits = [...missing, ...nalUnits];
      }
    }

    const packets: RtpPacket[] = [];

    // Try STAP-A for leading parameter sets (SPS/PPS), same policy as H265 AP
    let index = 0;
    if (nalUnits.length >= 2 && isH264ParameterSet(h264NalType(nalUnits[0]))) {
      const aggregated: Buffer[] = [];
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

      if (nal.length === 0) {
        throw new Error("H.264 empty NAL unit");
      }

      if (nal.length <= this.maxPayloadSize) {
        // Single NAL Unit Packet (RFC 6184 §5.6)
        packets.push(this.buildPacket(nal, rtpTimestamp, marker));
        continue;
      }

      // FU-A (RFC 6184 §5.8)
      if (nal.length < 2) {
        throw new Error("H.264 NAL too short to fragment");
      }
      const nalHeader = nal[0];
      const fragmentPayload = nal.subarray(1);
      const fragmentSize = this.maxPayloadSize - 2; // FU indicator + FU header
      if (fragmentSize <= 0) {
        throw new Error("invalid H.264 RTP maxPayloadSize for FU-A");
      }

      const fuIndicator = (nalHeader & 0xe0) | NalUnitType.fu_a;
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
