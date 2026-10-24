import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";
/** SDP encoding name for RFC 3640 mpeg4-generic. */
export declare const MPEG4_GENERIC_ENCODING_NAME = "MPEG4-GENERIC";
/** AAC-hbr default AU-header layout (RFC 3640 §3.3.6). */
export declare const AAC_HBR_SIZE_LENGTH = 13;
export declare const AAC_HBR_INDEX_LENGTH = 3;
export declare const AAC_HBR_INDEX_DELTA_LENGTH = 3;
export declare const AAC_HBR_AU_HEADER_BITS: number;
/**
 * Options for extended AU-header parsing beyond default aac-hbr (size+index).
 * Default aac-hbr does not include CTS/DTS; pass these when SDP signals them
 * (e.g. generic mode with CTSDeltaLength / DTSDeltaLength).
 */
export type AacHbrDepacketizerOptions = {
  /**
   * When true, each AU-header after size+index includes CTS-flag (1 bit) and
   * optionally CTS-delta / DTS-flag / DTS-delta when flags are set (RFC 3640 §3.2.1.1).
   */
  ctsDtsPresent?: boolean;
  /** Bit length of CTS-delta when CTS-flag=1 (default 14). */
  ctsDeltaLength?: number;
  /** Bit length of DTS-delta when DTS-flag=1 (default 14). */
  dtsDeltaLength?: number;
};
export type AuHeader = {
  /**
   * Access Unit size in octets (RFC 3640 AU-size).
   * This is the byte count itself, not (bytes − 1).
   */
  size: number;
  /** AU-Index (first) or AU-Index-delta (subsequent). */
  index: number;
  /** True when CTS-flag was present and set (extended parse only). */
  hasCts?: boolean;
  ctsDelta?: number;
  /** True when DTS-flag was present and set (extended parse only). */
  hasDts?: boolean;
  dtsDelta?: number;
};
/**
 * AAC-hbr RTP payload (RFC 3640 §3.3.6).
 * deSerialize validates AU-headers-length and AU sizes before concatenation.
 */
export declare class AacHbrRtpPayload implements DePacketizerBase {
  payload: Buffer;
  fragment?: Buffer;
  auHeaders: AuHeader[];
  isContinuationFragment: boolean;
  /**
   * True when AU-headers-length is not explained by pure aac-hbr 16-bit headers
   * alone (optional CTS/DTS or other fields may be present). See RFC 3640 §3.2.1.
   */
  optionalAuHeaderFieldsDetected: boolean;
  /**
   * @param buf RTP payload
   * @param fragment prior fragment accumulator (length-prefixed internal form)
   * @param options extended AU-header layout (CTS/DTS); default = aac-hbr only
   */
  static deSerialize(
    buf: Buffer,
    fragment?: Buffer,
    options?: AacHbrDepacketizerOptions,
  ): AacHbrRtpPayload;
  static isDetectedFinalPacketInSequence(header: RtpHeader): boolean;
  get isKeyframe(): boolean;
}
export type AacHbrPacketizerOptions = PacketizerBaseOptions & {
  /**
   * RTP clock ticks per AU (default 1024 = AAC-LC frame). Used to give AUs that
   * land in different packets distinct timestamps (RFC 3640 §3.1).
   */
  auDurationInSamples?: number;
};
/**
 * AAC-hbr packetizer (RFC 3640 §3.3.6).
 * AU-size fields store the Access Unit size in octets (not size−1).
 */
export declare class AacHbrPacketizer extends PacketizerBase {
  private readonly auDurationInSamples;
  constructor(options?: AacHbrPacketizerOptions);
  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[];
  /**
   * Packetize consecutive AUs. AUs are aggregated greedily into packets; an AU
   * that cannot fit in a single packet is fragmented. Each packet's timestamp
   * is that of its first AU (rtpTimestamp + n × auDurationInSamples).
   */
  packetizeAccessUnits(aus: Buffer[], rtpTimestamp: number): RtpPacket[];
  private tsOf;
  private fragmentAu;
}
