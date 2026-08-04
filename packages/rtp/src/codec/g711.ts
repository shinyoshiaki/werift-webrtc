// RFC 3551 §4.5.14 — PCMA and PCMU (G.711)
// Payload is raw 8-bit samples with no codec-specific header.
// Static PT: PCMU = 0, PCMA = 8; clock rate 8000 Hz (RFC 3551 Table 4 / §6).

import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";

/** RFC 3551 static payload type for PCMU (μ-law). */
export const PCMU_PAYLOAD_TYPE = 0;
/** RFC 3551 static payload type for PCMA (A-law). */
export const PCMA_PAYLOAD_TYPE = 8;
/** RFC 3551 clock rate for PCMU/PCMA (Hz). */
export const G711_CLOCK_RATE = 8000;

/** Default frame duration for packetization (20 ms → 160 samples @ 8 kHz). */
const DEFAULT_FRAME_DURATION_MS = 20;

export type G711PacketizerOptions = PacketizerBaseOptions & {
  /** Frame duration in ms used when splitting large buffers (default 20). */
  frameDurationInMs?: number;
};

export class PcmuRtpPayload implements DePacketizerBase {
  payload!: Buffer;

  static deSerialize(buf: Buffer) {
    const p = new PcmuRtpPayload();
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

export class PcmaRtpPayload implements DePacketizerBase {
  payload!: Buffer;

  static deSerialize(buf: Buffer) {
    const p = new PcmaRtpPayload();
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

abstract class G711Packetizer extends PacketizerBase {
  protected readonly frameBytes: number;

  constructor(options: G711PacketizerOptions = {}) {
    super(options);
    const frameMs = options.frameDurationInMs ?? DEFAULT_FRAME_DURATION_MS;
    // 8 kHz, 1 byte/sample → samples = bytes
    this.frameBytes = Math.max(
      1,
      Math.floor((G711_CLOCK_RATE * frameMs) / 1000),
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
      // G.711: each packet is a complete sample frame → marker always true
      packets.push(this.buildPacket(chunk, ts, true));
      // Advance timestamp by samples in this packet (1 sample = 1 byte)
      ts = (ts + chunk.length) >>> 0;
    }
    return packets;
  }
}

export class PcmuPacketizer extends G711Packetizer {
  constructor(options: G711PacketizerOptions = {}) {
    super({
      ...options,
      payloadType: options.payloadType ?? PCMU_PAYLOAD_TYPE,
    });
  }
}

export class PcmaPacketizer extends G711Packetizer {
  constructor(options: G711PacketizerOptions = {}) {
    super({
      ...options,
      payloadType: options.payloadType ?? PCMA_PAYLOAD_TYPE,
    });
  }
}
