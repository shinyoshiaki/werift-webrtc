import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";
export declare class Vp9RtpPayload implements DePacketizerBase {
  /**Picture ID (PID) present */
  iBit: number;
  /**Inter-picture predicted frame */
  pBit: number;
  /**Layer indices present */
  lBit: number;
  /**Flexible mode */
  fBit: number;
  /**Start of a frame */
  bBit: number;
  /**End of a frame */
  eBit: number;
  /**Scalability structure */
  vBit: number;
  zBit: number;
  m?: number;
  pictureId?: number;
  tid?: number;
  u?: number;
  sid?: number;
  /**inter_layer_predicted */
  d?: number;
  tl0PicIdx?: number;
  pDiff: number[];
  n_s?: number;
  y?: number;
  g?: number;
  width: number[];
  height: number[];
  n_g: number;
  pgT: number[];
  pgU: number[];
  pgP_Diff: number[][];
  payload: Buffer;
  static deSerialize(buf: Buffer): Vp9RtpPayload;
  static parseRtpPayload(buf: Buffer): {
    offset: number;
    p: Vp9RtpPayload;
  };
  static isDetectedFinalPacketInSequence(header: RtpHeader): boolean;
  get isKeyframe(): boolean;
  get isPartitionHead(): boolean | 0;
}
export type Vp9PacketizerOptions = PacketizerBaseOptions & {
  /**
   * When true, set P=0 (not inter-predicted = keyframe).
   * When false, set P=1 (inter-predicted / delta). Default false.
   * Also accept via packetize(..., { isKeyframe }) override.
   */
  isKeyframe?: boolean;
};
export type Vp9PacketizeOptions = {
  /** Override keyframe (P bit). Key → P=0, delta → P=1 (RFC 9628). */
  isKeyframe?: boolean;
  /** Alias for isKeyframe false / true: "key" | "delta". */
  frameType?: "key" | "delta";
};
/**
 * Packetize one VP9 frame with the minimal 1-byte descriptor (RFC 9628).
 * Picture ID / layer / SS extensions are not sent (legal optional subset).
 */
export declare class Vp9Packetizer extends PacketizerBase {
  private readonly defaultIsKeyframe;
  constructor(options?: Vp9PacketizerOptions);
  packetize(
    data: Buffer,
    rtpTimestamp: number,
    options?: Vp9PacketizeOptions,
  ): RtpPacket[];
}
