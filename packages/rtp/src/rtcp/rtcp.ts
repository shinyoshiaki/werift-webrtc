import { debug } from "../imports/common";
import { RTCP_HEADER_SIZE, RtcpHeader } from "./header";
import { RtcpPayloadSpecificFeedback } from "./psfb";
import { RtcpRrPacket } from "./rr";
import { RtcpTransportLayerFeedback } from "./rtpfb";
import { RtcpSourceDescriptionPacket } from "./sdes";
import { RtcpSrPacket } from "./sr";

const log = debug("werift-rtp:packages/rtp/src/rtcp/rtcp.ts");

export type RtcpPacket =
  | RtcpRrPacket
  | RtcpSrPacket
  | RtcpPayloadSpecificFeedback
  | RtcpSourceDescriptionPacket
  | RtcpTransportLayerFeedback;

export class RtcpPacketConverter {
  static deSerialize(data: Buffer) {
    let pos = 0;
    const packets: RtcpPacket[] = [];

    while (pos < data.length) {
      const header = RtcpHeader.deSerialize(
        data.subarray(pos, pos + RTCP_HEADER_SIZE),
      );
      pos += RTCP_HEADER_SIZE;

      const payloadLen = header.length * 4;
      let payload = data.subarray(pos, pos + payloadLen);
      pos += payloadLen;

      if (header.padding && payload.length > 0) {
        const pad = payload[payload.length - 1];
        if (pad > 0 && pad <= payload.length) {
          payload = payload.subarray(0, payload.length - pad);
        }
      }

      try {
        switch (header.type) {
          case RtcpSrPacket.type:
            packets.push(RtcpSrPacket.deSerialize(payload, header.count));
            break;
          case RtcpRrPacket.type:
            packets.push(RtcpRrPacket.deSerialize(payload, header.count));
            break;
          case RtcpSourceDescriptionPacket.type:
            packets.push(
              RtcpSourceDescriptionPacket.deSerialize(payload, header),
            );
            break;
          case RtcpTransportLayerFeedback.type:
            packets.push(
              RtcpTransportLayerFeedback.deSerialize(payload, header),
            );
            break;
          case RtcpPayloadSpecificFeedback.type:
            packets.push(
              RtcpPayloadSpecificFeedback.deSerialize(payload, header),
            );
            break;
          default:
            // log("unknown rtcp packet", header.type);
            break;
        }
      } catch (error) {
        log("deSerialize RTCP", error);
      }
    }

    return packets;
  }
}

export function isRtcp(buf: Buffer) {
  return buf.length >= 2 && buf[1] >= 192 && buf[1] <= 208;
}
