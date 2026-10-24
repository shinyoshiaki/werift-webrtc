import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";
export declare class AV1RtpPayload {
  /**
   * RtpStartsWithFragment
   * MUST be set to 1 if the first OBU element is an OBU fragment that is a continuation of an OBU fragment from the previous packet, and MUST be set to 0 otherwise.
   */
  zBit_RtpStartsWithFragment: number;
  /**
   * RtpEndsWithFragment
   * MUST be set to 1 if the last OBU element is an OBU fragment that will continue in the next packet, and MUST be set to 0 otherwise.
   */
  yBit_RtpEndsWithFragment: number;
  /**
   * RtpNumObus
   * two bit field that describes the number of OBU elements in the packet. This field MUST be set equal to 0 or equal to the number of OBU elements contained in the packet. If set to 0, each OBU element MUST be preceded by a length field.
   */
  w_RtpNumObus: number;
  /**
   * RtpStartsNewCodedVideoSequence
   * MUST be set to 1 if the packet is the first packet of a coded video sequence, and MUST be set to 0 otherwise.
   */
  nBit_RtpStartsNewCodedVideoSequence: number;
  obu_or_fragment: {
    data: Buffer;
    isFragment: boolean;
    /** Fragment continues in the next packet (last element with Y=1). */
    continues?: boolean;
    /** Fragment continues an OBU from the previous packet (first element with Z=1). */
    isContinuation?: boolean;
  }[];
  static deSerialize: (buf: Buffer) => AV1RtpPayload;
  static isDetectedFinalPacketInSequence(header: RtpHeader): boolean;
  get isKeyframe(): boolean;
  static getFrame(payloads: AV1RtpPayload[]): Buffer<ArrayBuffer>;
}
export declare class AV1Obu {
  obu_forbidden_bit: number;
  obu_type: OBU_TYPE;
  obu_extension_flag: number;
  obu_has_size_field: number;
  obu_reserved_1bit: number;
  /** Present when obu_extension_flag=1 (TID/SID byte). */
  extension_header?: number;
  /** OBU payload body only (LEB128 size field is not part of payload). */
  payload: Buffer;
  /**
   * Parse one OBU element.
   * When `obu_has_size_field` is set, consumes LEB128 size and takes exactly
   * that many payload octets (AV1 bitstream / AV1 RTP OBU element).
   */
  static deSerialize(buf: Buffer): AV1Obu;
  serialize(): Buffer<ArrayBuffer>;
}
export declare function leb128decode(buf: Buffer): number[];
declare const OBU_TYPES: {
  readonly 0: "Reserved";
  readonly 1: "OBU_SEQUENCE_HEADER";
  readonly 2: "OBU_TEMPORAL_DELIMITER";
  readonly 3: "OBU_FRAME_HEADER";
  readonly 4: "OBU_TILE_GROUP";
  readonly 5: "OBU_METADATA";
  readonly 6: "OBU_FRAME";
  readonly 7: "OBU_REDUNDANT_FRAME_HEADER";
  readonly 8: "OBU_TILE_LIST";
  readonly 15: "OBU_PADDING";
};
type OBU_TYPE = (typeof OBU_TYPES)[keyof typeof OBU_TYPES];
/**
 * Build the 1-byte AV1 Aggregation Header (AV1 RTP §4.4).
 * N=1 and Z=1 must not both be set (deSerialize throws).
 */
export declare function createAv1AggregationHeader({
  startsWithFragment,
  endsWithFragment,
  startsNewCodedVideoSequence,
  obuCount,
}: {
  startsWithFragment: boolean;
  endsWithFragment: boolean;
  startsNewCodedVideoSequence: boolean;
  /** W field: number of OBU elements (1..3); the last one has no length. */
  obuCount?: number;
}): Buffer;
/**
 * Split an AV1 sample into OBU elements.
 * Accepts size-field and no-size-field (remainder is last OBU) layouts.
 */
export declare function splitAv1Obus(sample: Buffer): Buffer[];
export type Av1PacketizerOptions = PacketizerBaseOptions & {
  /**
   * Default keyframe flag. Keyframe-ness alone does not set the N bit; see
   * {@link Av1PacketizeOptions.startsNewCodedVideoSequence}.
   * Override per call via packetize(..., { isKeyframe }).
   */
  isKeyframe?: boolean;
};
export type Av1PacketizeOptions = {
  /** Keyframe flag. Does NOT by itself set the N bit (see below). */
  isKeyframe?: boolean;
  frameType?: "key" | "delta";
  /**
   * N bit (RFC 9628 §4.4): first packet of a new coded video sequence.
   * A keyframe in the middle of a sequence must not set it. When omitted,
   * N is set only for a keyframe whose temporal unit contains a Sequence
   * Header OBU (a new coded video sequence cannot start without one); pass
   * `false` to force it off for in-band repeated headers, `true` to force on
   * (e.g. when the sequence header is carried out of band).
   */
  startsNewCodedVideoSequence?: boolean;
};
/**
 * Packetize one AV1 access unit (OBU sequence) into RTP packets.
 * Packs OBU elements (W=1..3) and fragments them across packets with Z/Y bits.
 */
export declare class Av1Packetizer extends PacketizerBase {
  private readonly defaultIsKeyframe;
  constructor(options?: Av1PacketizerOptions);
  packetize(
    data: Buffer,
    rtpTimestamp: number,
    options?: Av1PacketizeOptions,
  ): RtpPacket[];
}
