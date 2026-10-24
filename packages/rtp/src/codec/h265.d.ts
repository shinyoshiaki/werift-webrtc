import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import {
  type NalInputFormat,
  PacketizerBase,
  type PacketizerBaseOptions,
} from "./base";
/** RFC 7798 §4.4.2 Aggregation Packet type. */
export declare const H265_PAYLOAD_TYPE_AP = 48;
/** RFC 7798 §4.4.3 Fragmentation Unit type. */
export declare const H265_PAYLOAD_TYPE_FU = 49;
/** PACI payload structure (RFC 7798 §4.4.4); not supported by the depacketizer. */
export declare const H265_PAYLOAD_TYPE_PACI = 50;
/** IRAP picture NAL unit types (HEVC); used for isKeyframe. */
export declare const H265_IRAP_NAL_TYPES: {
  readonly BLA_W_LP: 16;
  readonly BLA_W_RADL: 17;
  readonly BLA_N_LP: 18;
  readonly IDR_W_RADL: 19;
  readonly IDR_N_LP: 20;
  readonly CRA_NUT: 21;
};
export declare const H265_NAL_TYPE: {
  readonly AP: 48;
  readonly FU: 49;
  readonly BLA_W_LP: 16;
  readonly BLA_W_RADL: 17;
  readonly BLA_N_LP: 18;
  readonly IDR_W_RADL: 19;
  readonly IDR_N_LP: 20;
  readonly CRA_NUT: 21;
  readonly VPS: 32;
  readonly SPS: 33;
  readonly PPS: 34;
  readonly AUD: 35;
};
export type H265PayloadHeader = {
  f: number;
  type: number;
  layerId: number;
  tid: number;
};
export declare function parseH265PayloadHeader(buf: Buffer): H265PayloadHeader;
export declare function writeH265PayloadHeader(h: H265PayloadHeader): Buffer;
export type H265DepacketizerOptions = {
  /**
   * When true, skip conditional DONL (2 bytes) after PayloadHdr for single NAL
   * and after FU header when S=1 (RFC 7798 DONL presence via sprop-max-don-diff > 0).
   * Default false (non-interleaved).
   */
  hasDonl?: boolean;
};
export declare class H265RtpPayload implements DePacketizerBase {
  f: number;
  type: number;
  layerId: number;
  tid: number;
  /** FU start bit (S). */
  s: number;
  /** FU end bit (E). */
  e: number;
  /** FU FuType (original NAL type). */
  fuType: number;
  /** True when an AP contained at least one IRAP NAL (types 16–21). */
  private apContainsIrap;
  payload: Buffer;
  fragment?: Buffer;
  static deSerialize(
    buf: Buffer,
    fragment?: Buffer,
    options?: H265DepacketizerOptions,
  ): H265RtpPayload;
  static isDetectedFinalPacketInSequence(header: RtpHeader): boolean;
  get isKeyframe(): boolean;
  get isPartitionHead(): boolean;
}
export declare class H265AnnexBParser {
  private data;
  private currentStartcodeOffset;
  private eof;
  constructor(data: Buffer);
  private findNextStartCodeOffset;
  /** Returns next NAL unit without start code, or null at EOF. */
  readNextNalu(): Buffer | null;
  readAll(): Buffer[];
}
/**
 * Split H.265 sample into NAL units.
 * Accepts Annex-B (start codes) or length-prefixed (HVCC) with `naluLengthSize`.
 */
export declare function splitH265NalUnits(
  sample: Buffer,
  naluLengthSize?: number,
  inputFormat?: NalInputFormat,
): Buffer[];
export type H265PacketizerOptions = PacketizerBaseOptions & {
  /** Length field size for HVCC input (default 4). Ignored for Annex-B. */
  naluLengthSize?: number;
  /** Sample layout (default "auto"); see {@link NalInputFormat}. */
  inputFormat?: NalInputFormat;
  /**
   * Parameter sets (VPS/SPS/PPS as raw NAL units without start codes).
   * Prepended via AP on keyframe when not already present in the sample.
   */
  parameterSets?: Buffer[];
};
export declare class H265Packetizer extends PacketizerBase {
  private readonly naluLengthSize;
  private readonly inputFormat;
  private readonly parameterSets;
  constructor(options?: H265PacketizerOptions);
  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[];
}
