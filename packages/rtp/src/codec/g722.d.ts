import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";
/** RFC 3551 static payload type for G.722. */
export declare const G722_PAYLOAD_TYPE = 9;
/**
 * RTP clock rate for G.722 (Hz) and octet rate (octets/s).
 * RFC 3551 §4.5.2: both are 8000 (not 16000).
 */
export declare const G722_CLOCK_RATE = 8000;
/** Octets per second of G.722 RTP payload (RFC 3551 §4.5.2). */
export declare const G722_OCTET_RATE = 8000;
export type G722PacketizerOptions = PacketizerBaseOptions & {
  /**
   * Frame duration in ms (default 20 → 160 octets @ 8000 octets/s,
   * and +160 on the RTP timestamp).
   */
  frameDurationInMs?: number;
};
export declare class G722RtpPayload implements DePacketizerBase {
  payload: Buffer;
  static deSerialize(buf: Buffer): G722RtpPayload;
  static isDetectedFinalPacketInSequence(_header: RtpHeader): boolean;
  get isKeyframe(): boolean;
}
export declare class G722Packetizer extends PacketizerBase {
  /** Nominal octets per packetization frame (8000 octets/s × duration). */
  private readonly frameBytes;
  constructor(options?: G722PacketizerOptions);
  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[];
}
