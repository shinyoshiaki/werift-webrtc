import { RtpHeader, RtpPacket } from "../rtp/rtp";
/**
 * Layout of video samples handed to H.264 / H.265 packetizers.
 * - `"annexb"`: start-code delimited NAL units.
 * - `"length-prefixed"`: AVCC/HVCC (`naluLengthSize`-byte big-endian lengths).
 * - `"auto"` (default): Annex-B when the sample begins with a start code,
 *   otherwise length-prefixed. A 3-byte start code `00 00 01 HH` is
 *   byte-identical to the 4-byte length `0x1HH`, so container-sourced
 *   (MP4/MKV) input should pass `"length-prefixed"` explicitly.
 */
export type NalInputFormat = "auto" | "annexb" | "length-prefixed";
export declare abstract class DePacketizerBase {
  payload: Buffer;
  fragment?: Buffer;
  static deSerialize(buf: Buffer, fragment?: Buffer): DePacketizerBase;
  static isDetectedFinalPacketInSequence(header: RtpHeader): boolean;
  get isKeyframe(): boolean;
}
/** Codec-agnostic packetizer contract. Extra args live on concrete types. */
export interface Packetizer {
  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[];
}
export type PacketizerBaseOptions = {
  /** Max RTP payload octets (default MTU = 1200). */
  maxPayloadSize?: number;
  /** Static or dynamic payload type (default 96). */
  payloadType?: number;
  /** Initial sequence number (default random16). */
  sequenceNumber?: number;
  /** SSRC (default 0). */
  ssrc?: number;
};
/**
 * Shared RTP packet construction for package-local packetizers.
 * Sequence number increments by 1 (uint16 wrap) per packet.
 * Marker semantics are left to each codec (typically last packet of a frame;
 * telephone-event is the RFC 4733 exception: marker on the first event packet).
 */
export declare abstract class PacketizerBase implements Packetizer {
  protected sequenceNumber: number;
  protected readonly maxPayloadSize: number;
  protected readonly payloadType: number;
  protected readonly ssrc: number;
  constructor(options?: PacketizerBaseOptions);
  abstract packetize(data: Buffer, rtpTimestamp: number): RtpPacket[];
  /** Audio only: next packet begins a talkspurt (RFC 3551 §4.1 marker). */
  private talkspurtPending;
  /**
   * Mark the next audio packet as the first of a talkspurt (e.g. after
   * silence suppression). The first packet of a new packetizer is also one.
   */
  startTalkspurt(): void;
  /** Marker for audio packets: true once per talkspurt, false otherwise. */
  protected takeTalkspurtMarker(): boolean;
  protected buildPacket(
    payload: Buffer,
    timestamp: number,
    marker: boolean,
  ): RtpPacket;
}
