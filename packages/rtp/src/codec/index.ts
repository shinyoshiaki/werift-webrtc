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

export function dePacketizeRtpPackets(codec: string, packets: RtpPacket[]) {
  const basicCodecParser = (DePacketizer: typeof DePacketizerBase) => {
    const partitions = packets.map((p) => DePacketizer.deSerialize(p.payload));
    const isKeyframe = !!partitions.find((f) => f.isKeyframe);
    const data = Buffer.concat(partitions.map((f) => f.payload));
    return {
      isKeyframe,
      data,
      sequence: packets.at(-1)?.header.sequenceNumber ?? 0,
      timestamp: packets.at(-1)?.header.timestamp ?? 0,
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
    case "VP8": {
      return basicCodecParser(Vp8RtpPayload);
    }
    case "VP9":
      return basicCodecParser(Vp9RtpPayload);
    case "OPUS":
      return basicCodecParser(OpusRtpPayload);
    default:
      throw new Error();
  }
}
