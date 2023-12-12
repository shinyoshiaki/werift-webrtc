import { RtpPacket } from "../rtp/rtp";
import { AV1RtpPayload } from "./av1";
import { DePacketizerBase } from "./base";
import { H264RtpPayload } from "./h264";
import { OpusRtpPayload } from "./opus";
import { Vp8RtpPayload } from "./vp8";
import { Vp9RtpPayload } from "./vp9";

export * from "./av1";
export * from "./base";
export * from "./h264";
export * from "./opus";
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
    case "VP8":
      return basicCodecParser(Vp8RtpPayload);
    case "VP9":
      return basicCodecParser(Vp9RtpPayload);
    case "OPUS":
      return basicCodecParser(OpusRtpPayload);
    default:
      throw new Error();
  }
}

export const depacketizerCodecs = [
  "MPEG4/ISO/AVC",
  "VP8",
  "VP9",
  "OPUS",
  "AV1",
] as const;
export type DepacketizerCodec =
  | (typeof depacketizerCodecs)[number]
  | Lowercase<(typeof depacketizerCodecs)[number]>;
