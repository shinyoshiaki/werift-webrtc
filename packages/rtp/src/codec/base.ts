// Packetizer / Depacketizer base types for werift-rtp.
// PacketizerBase mirrors the sequence/timestamp/marker semantics of
// packages/webrtc BasePacketizer without depending on webrtc.

import { random16 } from "../../../common/src";
import { MTU } from "../const";
import { RtpHeader, RtpPacket } from "../rtp/rtp";

export abstract class DePacketizerBase {
  payload!: Buffer;
  fragment?: Buffer;

  static deSerialize(buf: Buffer, fragment?: Buffer) {
    return {} as unknown as DePacketizerBase;
  }

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return true as boolean;
  }

  get isKeyframe() {
    return true as boolean;
  }
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
export abstract class PacketizerBase implements Packetizer {
  protected sequenceNumber: number;
  protected readonly maxPayloadSize: number;
  protected readonly payloadType: number;
  protected readonly ssrc: number;

  constructor(options: PacketizerBaseOptions = {}) {
    this.maxPayloadSize = options.maxPayloadSize ?? MTU;
    this.payloadType = options.payloadType ?? 96;
    this.sequenceNumber = options.sequenceNumber ?? random16();
    this.ssrc = options.ssrc ?? 0;
  }

  abstract packetize(data: Buffer, rtpTimestamp: number): RtpPacket[];

  protected buildPacket(
    payload: Buffer,
    timestamp: number,
    marker: boolean,
  ): RtpPacket {
    const packet = new RtpPacket(
      new RtpHeader({
        payloadType: this.payloadType,
        sequenceNumber: this.sequenceNumber,
        timestamp,
        marker,
        ssrc: this.ssrc,
      }),
      payload,
    );
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    return packet;
  }
}
