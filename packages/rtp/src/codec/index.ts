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
    return { isKeyframe, data, partitions };
  };

  switch (codec.toUpperCase()) {
    case "AV1": {
      const chunks = packets.map((p) => AV1RtpPayload.deSerialize(p.payload));
      const isKeyframe = !!chunks.find((f) => f.isKeyframe);
      const data = AV1RtpPayload.getFrame(chunks);
      return { isKeyframe, data };
    }
    case "MPEG4/ISO/AVC":
      return basicCodecParser(H264RtpPayload);
    case "VP8": {
      const { partitions, data, isKeyframe } = basicCodecParser(Vp8RtpPayload);
      if (!(partitions[0] as Vp8RtpPayload).payloadHeaderExist) {
        throw new Error();
      }

      return { data, isKeyframe };
    }
    case "VP9":
      return basicCodecParser(Vp9RtpPayload);
    case "OPUS":
      return basicCodecParser(OpusRtpPayload);
    default:
      throw new Error();
  }
}

export function dePacketizeRtpPacket(codec: string, packet: RtpPacket) {
  const depacketizer = (DePacketizer: typeof DePacketizerBase) => {
    return DePacketizer.deSerialize(packet.payload);
  };

  switch (codec.toUpperCase()) {
    case "AV1":
      return depacketizer(AV1RtpPayload as any);
    case "MPEG4/ISO/AVC":
      return depacketizer(H264RtpPayload);
    case "VP8":
      return depacketizer(Vp8RtpPayload);
    case "VP9":
      return depacketizer(Vp9RtpPayload);
    case "OPUS":
      return depacketizer(OpusRtpPayload);
    default:
      throw new Error();
  }
}
