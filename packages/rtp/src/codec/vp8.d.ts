import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";
export declare class Vp8RtpPayload implements DePacketizerBase {
  xBit: number;
  nBit: number;
  sBit: number;
  pid: number;
  iBit?: number;
  lBit?: number;
  tBit?: number;
  kBit?: number;
  mBit?: number;
  pictureId?: number;
  payload: Buffer;
  size0: number;
  hBit?: number;
  ver?: number;
  pBit?: number;
  size1: number;
  size2: number;
  static deSerialize(buf: Buffer): Vp8RtpPayload;
  static isDetectedFinalPacketInSequence(header: RtpHeader): boolean;
  get isKeyframe(): boolean;
  get isPartitionHead(): boolean;
  get payloadHeaderExist(): boolean;
  get size(): number;
}
export type Vp8PacketizerOptions = PacketizerBaseOptions & {
  /** Initial 15-bit PictureID (default random). */
  pictureId?: number;
};
/** Length of the descriptor emitted by {@link createVp8PayloadDescriptor}. */
export declare const VP8_PAYLOAD_DESCRIPTOR_LENGTH = 4;
/**
 * Build the 4-octet VP8 payload descriptor X=1, I=1, M=1 (RFC 7741 §4.2).
 * `start` sets S (first packet of the frame, PID=0).
 */
export declare function createVp8PayloadDescriptor({
  start,
  pictureId,
}: {
  start: boolean;
  pictureId: number;
}): Buffer;
/**
 * Packetize one VP8 frame (single partition PID=0) into RTP packets.
 * Each packet carries the 4-octet descriptor from
 * {@link createVp8PayloadDescriptor}; PictureID advances once per frame.
 */
export declare class Vp8Packetizer extends PacketizerBase {
  private pictureId;
  constructor(options?: Vp8PacketizerOptions);
  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[];
}
