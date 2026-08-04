// RFC 3551 §4.5.2 — G.722
// Codec samples at 16 kHz, but RTP clock rate is 8000 Hz (RFC 3551 §4.5.2).
// Static PT = 9. Payload is raw G.722 bitstream (no codec-specific header).

import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";

/** RFC 3551 static payload type for G.722. */
export const G722_PAYLOAD_TYPE = 9;
/**
 * RTP clock rate for G.722 (Hz).
 * Note: the codec itself is 16 kHz; RFC 3551 mandates 8000 for RTP timestamps.
 */
export const G722_CLOCK_RATE = 8000;

const DEFAULT_FRAME_DURATION_MS = 20;

export type G722PacketizerOptions = PacketizerBaseOptions & {
  /** Frame duration in ms (default 20 → 160 RTP clock units @ 8 kHz). */
  frameDurationInMs?: number;
};

export class G722RtpPayload implements DePacketizerBase {
  payload!: Buffer;

  static deSerialize(buf: Buffer) {
    const p = new G722RtpPayload();
    p.payload = buf;
    return p;
  }

  static isDetectedFinalPacketInSequence(_header: RtpHeader) {
    return true;
  }

  get isKeyframe() {
    return true;
  }
}

export class G722Packetizer extends PacketizerBase {
  private readonly frameBytes: number;
  private readonly timestampIncrement: number;

  constructor(options: G722PacketizerOptions = {}) {
    super({
      ...options,
      payloadType: options.payloadType ?? G722_PAYLOAD_TYPE,
    });
    const frameMs = options.frameDurationInMs ?? DEFAULT_FRAME_DURATION_MS;
    // G.722 produces 1 byte per sample at 16 kHz → 320 bytes for 20 ms.
    // RTP timestamp still advances at 8 kHz (RFC 3551 §4.5.2).
    this.frameBytes = Math.max(1, Math.floor((16000 * frameMs) / 1000));
    this.timestampIncrement = Math.max(
      1,
      Math.floor((G722_CLOCK_RATE * frameMs) / 1000),
    );
  }

  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[] {
    if (data.length === 0) {
      return [];
    }

    const chunkSize = Math.min(this.maxPayloadSize, this.frameBytes);
    const packets: RtpPacket[] = [];
    let ts = rtpTimestamp >>> 0;
    // Scale RTP timestamp advance by actual chunk size vs nominal frame
    // (16 kHz samples / 8 kHz clock → typically 2 bytes per timestamp unit)
    const bytesPerTsTick = this.frameBytes / this.timestampIncrement;

    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const end = Math.min(data.length, offset + chunkSize);
      const chunk = data.subarray(offset, end);
      packets.push(this.buildPacket(chunk, ts, true));
      const advance = Math.max(1, Math.round(chunk.length / bytesPerTsTick));
      ts = (ts + advance) >>> 0;
    }
    return packets;
  }
}
