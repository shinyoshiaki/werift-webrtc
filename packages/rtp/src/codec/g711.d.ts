import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";
/** RFC 3551 static payload type for PCMU (μ-law). */
export declare const PCMU_PAYLOAD_TYPE = 0;
/** RFC 3551 static payload type for PCMA (A-law). */
export declare const PCMA_PAYLOAD_TYPE = 8;
/** RFC 3551 clock rate for PCMU/PCMA (Hz). */
export declare const G711_CLOCK_RATE = 8000;
export type G711PacketizerOptions = PacketizerBaseOptions & {
  /** Frame duration in ms used when splitting large buffers (default 20). */
  frameDurationInMs?: number;
};
export declare class PcmuRtpPayload implements DePacketizerBase {
  payload: Buffer;
  static deSerialize(buf: Buffer): PcmuRtpPayload;
  static isDetectedFinalPacketInSequence(_header: RtpHeader): boolean;
  get isKeyframe(): boolean;
}
export declare class PcmaRtpPayload implements DePacketizerBase {
  payload: Buffer;
  static deSerialize(buf: Buffer): PcmaRtpPayload;
  static isDetectedFinalPacketInSequence(_header: RtpHeader): boolean;
  get isKeyframe(): boolean;
}
declare abstract class G711Packetizer extends PacketizerBase {
  protected readonly frameBytes: number;
  constructor(options?: G711PacketizerOptions);
  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[];
}
export declare class PcmuPacketizer extends G711Packetizer {
  constructor(options?: G711PacketizerOptions);
}
export declare class PcmaPacketizer extends G711Packetizer {
  constructor(options?: G711PacketizerOptions);
}
