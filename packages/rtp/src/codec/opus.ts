// RFC 7587 — RTP Payload Format for the Opus Speech and Audio Codec
// docs/rfc/rfc7587.txt
//
// Opus RTP has no codec-specific payload header: the RTP payload is one
// complete Opus packet (RFC 7587 §3 / §4.1). Marker is always true for a
// single-packet frame. Simple MTU splitting would break the TOC and is
// rejected (caller must keep Opus packets ≤ maxPayloadSize).

import { bufferWriter, bufferWriterLE } from "../../../common/src";
import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";

/** RFC 7587 §4 / Opus default sampling rate (Hz). */
export const OPUS_CLOCK_RATE = 48000;

export class OpusRtpPayload implements DePacketizerBase {
  payload!: Buffer;

  static deSerialize(buf: Buffer) {
    const opus = new OpusRtpPayload();
    opus.payload = buf;
    return opus;
  }

  static isDetectedFinalPacketInSequence(_header: RtpHeader) {
    return true;
  }

  get isKeyframe() {
    return true;
  }

  static createCodecPrivate(samplingFrequency = 48000) {
    return Buffer.concat([
      Buffer.from("OpusHead"),
      bufferWriter([1, 1], [1, 2]),
      bufferWriterLE([2, 4, 2, 1], [312, samplingFrequency, 0, 0]),
    ]);
  }
}

export type OpusPacketizerOptions = PacketizerBaseOptions;

/**
 * Packetize one Opus packet into one RTP packet (RFC 7587 §3).
 * Throws if the Opus packet exceeds maxPayloadSize (no TOC-blind split).
 */
export class OpusPacketizer extends PacketizerBase {
  constructor(options: OpusPacketizerOptions = {}) {
    super(options);
  }

  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[] {
    if (data.length === 0) {
      return [];
    }
    if (data.length > this.maxPayloadSize) {
      throw new Error(
        `OpusPacketizer: Opus packet length ${data.length} exceeds maxPayloadSize ${this.maxPayloadSize} (RFC 7587 forbids blind MTU fragmentation of the TOC)`,
      );
    }
    // Single complete Opus packet → marker always true
    return [this.buildPacket(data, rtpTimestamp, true)];
  }
}
