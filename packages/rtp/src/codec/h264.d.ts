import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import {
  type NalInputFormat,
  PacketizerBase,
  type PacketizerBaseOptions,
} from "./base";
export declare class H264RtpPayload implements DePacketizerBase {
  /**forbidden_zero_bit */
  f: number;
  /**nal_ref_idc */
  nri: number;
  /**nal_unit_types */
  nalUnitType: number;
  /**start of a fragmented NAL unit (FU-A / FU-B only) */
  s?: number;
  /**end of a fragmented NAL unit (FU-A / FU-B only) */
  e?: number;
  /**reserved bit of the FU header (FU-A / FU-B only) */
  r?: number;
  /**nal_unit_type of the fragmented NAL unit (FU-A / FU-B only) */
  nalUnitPayloadType?: number;
  /**nal_unit_types of the NAL units aggregated in a STAP-A packet */
  aggregatedNalUnitTypes: number[];
  payload: Buffer;
  fragment?: Buffer;
  static deSerialize(buf: Buffer, fragment?: Buffer): H264RtpPayload;
  private static packaging;
  static isDetectedFinalPacketInSequence(header: RtpHeader): boolean;
  /** true only when this packet carries (a part of) an IDR slice */
  get isKeyframe(): boolean;
  get isPartitionHead(): boolean;
}
export declare const NalUnitType: {
  readonly idrSlice: 5;
  readonly sps: 7;
  readonly pps: 8;
  readonly stap_a: 24;
  readonly stap_b: 25;
  readonly mtap16: 26;
  readonly mtap24: 27;
  readonly fu_a: 28;
  readonly fu_b: 29;
};
/**
 * Split H.264 sample into NAL units (no start codes).
 * Accepts Annex-B (start-code split, no NAL type filtering) or length-prefixed (AVCC).
 */
export declare function splitH264NalUnits(
  sample: Buffer,
  naluLengthSize?: number,
  inputFormat?: NalInputFormat,
): Buffer[];
/**
 * From configured `parameterSets`, return only those whose type is not already
 * present in the sample (SPS and PPS checked independently).
 * E.g. sample with SPS-only → only missing PPS are returned.
 */
export declare function selectMissingH264ParameterSets(
  parameterSets: Buffer[],
  nalUnits: Buffer[],
): Buffer[];
/**
 * Build STAP-A payload (RFC 6184 §5.7.1 / Figure 7):
 *   STAP-A header (F/NRI/Type=24) + repeated [16-bit NALU size][NAL]
 * F = OR of F of aggregated NALs; NRI = max of NRI of aggregated NALs.
 */
/** Minimum NAL size: 1-byte header + at least 1 payload octet (packetizer contract). */
export declare const H264_MIN_NAL_LENGTH = 2;
export declare function buildH264StapA(nalus: Buffer[]): Buffer;
export type H264PacketizerOptions = PacketizerBaseOptions & {
  /** Length field size for AVCC input (default 4). Ignored for Annex-B. */
  naluLengthSize?: number;
  /** Sample layout (default "auto"); see {@link NalInputFormat}. */
  inputFormat?: NalInputFormat;
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
export declare class H264Packetizer extends PacketizerBase {
  private readonly naluLengthSize;
  private readonly inputFormat;
  private readonly parameterSets;
  private readonly defaultIsKeyframe;
  constructor(options?: H264PacketizerOptions);
  packetize(
    data: Buffer,
    rtpTimestamp: number,
    options?: H264PacketizeOptions,
  ): RtpPacket[];
}
export type AvcDecoderConfigurationRecord = {
  /** lengthSizeMinusOne + 1: NAL length field size of AVCC samples (1, 2 or 4). */
  naluLengthSize: number;
  sps: Buffer[];
  pps: Buffer[];
  /** SPS followed by PPS, ready for {@link H264PacketizerOptions.parameterSets}. */
  parameterSets: Buffer[];
};
/**
 * Parse an avcC record (e.g. WebCodecs / mediabunny `decoderConfig.description`)
 * into the NAL length size and SPS/PPS NAL units (no length prefix).
 * Throws on a truncated record instead of returning partial parameter sets.
 */
export declare function parseAvcDecoderConfigurationRecord(
  description: ArrayBuffer | ArrayBufferView,
): AvcDecoderConfigurationRecord;
