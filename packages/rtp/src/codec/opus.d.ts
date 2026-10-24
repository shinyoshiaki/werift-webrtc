import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";
/** RFC 7587 §4 / Opus default sampling rate (Hz). */
export declare const OPUS_CLOCK_RATE = 48000;
export declare class OpusRtpPayload implements DePacketizerBase {
  payload: Buffer;
  static deSerialize(buf: Buffer): OpusRtpPayload;
  static isDetectedFinalPacketInSequence(_header: RtpHeader): boolean;
  get isKeyframe(): boolean;
  static createCodecPrivate(samplingFrequency?: number): Buffer<ArrayBuffer>;
}
export type OpusPacketizerOptions = PacketizerBaseOptions;
/**
 * Packetize one Opus packet into one RTP packet (RFC 7587 §3).
 * Throws if the Opus packet exceeds maxPayloadSize (no TOC-blind split).
 */
export declare class OpusPacketizer extends PacketizerBase {
  constructor(options?: OpusPacketizerOptions);
  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[];
}
