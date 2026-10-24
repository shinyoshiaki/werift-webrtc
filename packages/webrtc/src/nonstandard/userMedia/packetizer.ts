// EncodedPacket adapters over the packages/rtp packetizers.
// Codec payload formats live in packages/rtp; this file maps mediabunny
// EncodedPacket (data + key/delta) and SDP codec parameters onto them.

import type { EncodedPacket } from "mediabunny";
import {
  Av1Packetizer,
  H264Packetizer,
  OpusPacketizer,
  parseAvcDecoderConfigurationRecord,
  type RtpPacket,
  Vp8Packetizer,
  Vp9Packetizer,
} from "../../imports/rtp";
import type { RTCRtpCodecParameters } from "../../media/parameters";

export { Vp8Packetizer } from "../../imports/rtp";

const DEFAULT_MAX_RTP_PAYLOAD_SIZE = 1_200;

export const supportedSourceCodecs = [
  "avc",
  "vp8",
  "vp9",
  "av1",
  "opus",
] as const;
export type SupportedSourceCodec = (typeof supportedSourceCodecs)[number];

type SupportedMimeType =
  | "video/h264"
  | "video/vp8"
  | "video/vp9"
  | "video/av1x"
  | "audio/opus";

export interface Packetizer {
  packetize(packet: EncodedPacket, rtpTimestamp: number): RtpPacket[];
}

export function toSupportedMimeType(
  codec: SupportedSourceCodec,
): SupportedMimeType {
  switch (codec) {
    case "avc":
      return "video/h264";
    case "vp8":
      return "video/vp8";
    case "vp9":
      return "video/vp9";
    case "av1":
      return "video/av1x";
    case "opus":
      return "audio/opus";
  }
}

export function createPacketizer({
  codec,
  sourceCodec,
  decoderDescription,
}: {
  codec: RTCRtpCodecParameters;
  sourceCodec: SupportedSourceCodec;
  decoderDescription?:
    | ArrayBufferLike
    | ArrayBufferView<ArrayBufferLike>
    | null;
}): Packetizer {
  const options = {
    payloadType: codec.payloadType ?? 96,
    maxPayloadSize: DEFAULT_MAX_RTP_PAYLOAD_SIZE,
  };

  switch (sourceCodec) {
    case "avc": {
      const packetizationMode = getH264PacketizationMode(codec.parameters);
      if (packetizationMode !== 1) {
        throw new Error(
          `Unsupported H264 packetization-mode=${packetizationMode}. File playback requires packetization-mode=1.`,
        );
      }
      const avcConfig = decoderDescription
        ? parseAvcDecoderConfigurationRecord(decoderDescription)
        : undefined;
      const packetizer = new H264Packetizer({
        ...options,
        naluLengthSize: avcConfig?.naluLengthSize,
        parameterSets: avcConfig?.parameterSets,
        // avcC means container (AVCC) samples; never guess Annex-B from bytes
        inputFormat: avcConfig ? "length-prefixed" : "auto",
      });
      return {
        packetize: (packet, rtpTimestamp) =>
          packetizer.packetize(toBuffer(packet.data), rtpTimestamp, {
            isKeyframe: packet.type === "key",
          }),
      };
    }
    case "vp8": {
      const packetizer = new Vp8Packetizer(options);
      return {
        packetize: (packet, rtpTimestamp) =>
          packetizer.packetize(toBuffer(packet.data), rtpTimestamp),
      };
    }
    case "vp9": {
      const packetizer = new Vp9Packetizer(options);
      return {
        packetize: (packet, rtpTimestamp) =>
          packetizer.packetize(toBuffer(packet.data), rtpTimestamp, {
            frameType: packet.type,
          }),
      };
    }
    case "av1": {
      const packetizer = new Av1Packetizer(options);
      return {
        packetize: (packet, rtpTimestamp) =>
          packetizer.packetize(toBuffer(packet.data), rtpTimestamp, {
            frameType: packet.type,
            // Sources may carry the sequence header only out of band (av1C),
            // so every key packet starts a coded video sequence (N=1).
            startsNewCodedVideoSequence: packet.type === "key",
          }),
      };
    }
    case "opus": {
      const packetizer = new OpusPacketizer(options);
      return {
        packetize: (packet, rtpTimestamp) => {
          // userMedia has always marked every Opus packet; receivers split
          // audio frames on the marker, so keep that instead of talkspurts.
          packetizer.startTalkspurt();
          return packetizer.packetize(toBuffer(packet.data), rtpTimestamp);
        },
      };
    }
  }
}

function getH264PacketizationMode(parameters?: string) {
  if (!parameters) {
    return 1;
  }

  const packetizationMode = parameters
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("packetization-mode="));

  if (!packetizationMode) {
    return 1;
  }

  return Number(packetizationMode.split("=")[1] ?? 1);
}

function toBuffer(data: Uint8Array) {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
