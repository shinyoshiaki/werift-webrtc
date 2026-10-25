import type { RtpPacket } from "../rtp/rtp";
import { AV1RtpPayload } from "./av1";
import type { DePacketizerBase } from "./base";
import { PcmaRtpPayload, PcmuRtpPayload } from "./g711";
import { G722RtpPayload } from "./g722";
import { H264RtpPayload } from "./h264";
import { H265RtpPayload } from "./h265";
import { AacHbrRtpPayload } from "./mp4a";
import { OpusRtpPayload } from "./opus";
import { Vp8RtpPayload } from "./vp8";
import { Vp9RtpPayload } from "./vp9";

export * from "./av1";
export * from "./base";
export * from "./g711";
export * from "./g722";
export * from "./h264";
export * from "./h265";
export * from "./mp4a";
export * from "./opus";
export * from "./telephoneEvent";
export * from "./vp8";
export * from "./vp9";

export function dePacketizeRtpPackets(
  codec: DepacketizerCodec,
  packets: RtpPacket[],
  frameFragmentBuffer?: Buffer,
): {
  isKeyframe: boolean;
  data: Buffer;
  sequence: number;
  timestamp: number;
  frameFragmentBuffer?: Buffer;
} {
  const basicCodecParser = (Depacketizer: typeof DePacketizerBase) => {
    const partitions: DePacketizerBase[] = [];
    for (const p of packets) {
      const codec = Depacketizer.deSerialize(p.payload, frameFragmentBuffer);
      if (codec.fragment) {
        frameFragmentBuffer ??= Buffer.alloc(0);
        frameFragmentBuffer = codec.fragment;
      } else if (codec.payload) {
        frameFragmentBuffer = undefined;
      }
      partitions.push(codec);
    }
    const isKeyframe = !!partitions.find((f) => f.isKeyframe);
    const data = Buffer.concat(
      partitions.map((f) => f.payload).filter((p) => p),
    );

    return {
      isKeyframe,
      data,
      sequence: packets.at(-1)?.header.sequenceNumber ?? 0,
      timestamp: packets.at(-1)?.header.timestamp ?? 0,
      frameFragmentBuffer,
    };
  };

  switch (codec.toUpperCase()) {
    case "AV1": {
      const chunks = packets.map((p) => AV1RtpPayload.deSerialize(p.payload));
      const isKeyframe = !!chunks.find((f) => f.isKeyframe);
      const data = AV1RtpPayload.getFrame(chunks);
      return {
        isKeyframe,
        data,
        sequence: packets.at(-1)?.header.sequenceNumber ?? 0,
        timestamp: packets.at(-1)?.header.timestamp ?? 0,
      };
    }
    case "MPEG4/ISO/AVC":
      return basicCodecParser(H264RtpPayload);
    case "H265":
    case "HEVC":
      return basicCodecParser(H265RtpPayload);
    case "VP8":
      return basicCodecParser(Vp8RtpPayload);
    case "VP9":
      return basicCodecParser(Vp9RtpPayload);
    case "OPUS":
      return basicCodecParser(OpusRtpPayload);
    case "PCMU":
      return basicCodecParser(PcmuRtpPayload);
    case "PCMA":
      return basicCodecParser(PcmaRtpPayload);
    case "G722":
      return basicCodecParser(G722RtpPayload);
    case "MPEG4-GENERIC":
      return basicCodecParser(AacHbrRtpPayload);
    default:
      throw new Error();
  }
}

export const depacketizerCodecs = [
  "MPEG4/ISO/AVC",
  "H265",
  "VP8",
  "VP9",
  "OPUS",
  "AV1",
  "PCMU",
  "PCMA",
  "G722",
  "MPEG4-GENERIC",
] as const;
export type DepacketizerCodec =
  | (typeof depacketizerCodecs)[number]
  | Lowercase<(typeof depacketizerCodecs)[number]>;
