// RFC 3551 §4.5.2 — G.722
//
// "Even though the actual sampling rate for G.722 audio is 16,000 Hz,
//  the RTP clock rate for the G722 payload format is 8,000 Hz ...
//  The octet rate or sample-pair rate is 8,000 Hz."
//
// Therefore payload size and RTP timestamp both track **8000 octets/second**
// (1 octet ↔ 1 RTP clock tick). A 20 ms packet is 160 octets, not 320.
// Static PT = 9. Payload is raw G.722 bitstream (no codec-specific header).

import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";

/** RFC 3551 static payload type for G.722. */
export const G722_PAYLOAD_TYPE = 9;
/**
 * RTP clock rate for G.722 (Hz) and octet rate (octets/s).
 * RFC 3551 §4.5.2: both are 8000 (not 16000).
 */
export const G722_CLOCK_RATE = 8000;
/** Octets per second of G.722 RTP payload (RFC 3551 §4.5.2). */
export const G722_OCTET_RATE = 8000;

const DEFAULT_FRAME_DURATION_MS = 20;

export type G722PacketizerOptions = PacketizerBaseOptions & {
  /**
   * Frame duration in ms (default 20 → 160 octets @ 8000 octets/s,
   * and +160 on the RTP timestamp).
   */
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
  /** Nominal octets per packetization frame (8000 octets/s × duration). */
  private readonly frameBytes: number;

  constructor(options: G722PacketizerOptions = {}) {
    super({
      ...options,
      payloadType: options.payloadType ?? G722_PAYLOAD_TYPE,
    });
    const frameMs = options.frameDurationInMs ?? DEFAULT_FRAME_DURATION_MS;
    // RFC 3551 §4.5.2: octet rate = 8000 Hz → 20 ms = 160 octets
    this.frameBytes = Math.max(
      1,
      Math.floor((G722_OCTET_RATE * frameMs) / 1000),
    );
  }

  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[] {
    if (data.length === 0) {
      return [];
    }

    const chunkSize = Math.min(this.maxPayloadSize, this.frameBytes);
    const packets: RtpPacket[] = [];
    let ts = rtpTimestamp >>> 0;

    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const end = Math.min(data.length, offset + chunkSize);
      const chunk = data.subarray(offset, end);
      packets.push(this.buildPacket(chunk, ts, true));
      // 1 octet = 1 RTP clock unit @ 8000 Hz (RFC 3551 §4.5.2)
      ts = (ts + chunk.length) >>> 0;
    }
    return packets;
  }
}
