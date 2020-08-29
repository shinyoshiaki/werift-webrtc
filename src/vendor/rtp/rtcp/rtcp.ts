import { HEADER_SIZE, RtcpHeader } from "./header";
import { RtcpRrPacket } from "./rr";
import { RtcpSrPacket } from "./sr";
import { RtcpPayloadSpecificFeedback } from "./psfb";
import { RtcpSourceDescriptionPacket } from "./sdes";
export type RtcpPacket =
  | RtcpRrPacket
  | RtcpSrPacket
  | RtcpPayloadSpecificFeedback
  | RtcpSourceDescriptionPacket;

export class RtcpPacketConverter {
  static serialize(
    type: number,
    count: number,
    payload: Buffer,
    length: number
  ) {
    const header = new RtcpHeader({
      type,
      count,
      version: 2,
      length,
    });
    const buf = header.serialize();
    return Buffer.concat([buf, payload]);
  }

  static deSerialize(data: Buffer) {
    let pos = 0;
    const packets: RtcpPacket[] = [];

    while (pos < data.length) {
      const header = RtcpHeader.deSerialize(data.slice(pos, pos + HEADER_SIZE));
      pos += HEADER_SIZE;

      let payload = data.slice(pos);
      pos += header.length * 4;

      if (header.padding) {
        payload = payload.slice(0, payload.length - payload.slice(-1)[0]);
      }

      switch (header.type) {
        case RtcpSrPacket.type:
          packets.push(RtcpSrPacket.deSerialize(payload, header.count));
          break;
        case RtcpRrPacket.type:
          packets.push(RtcpRrPacket.deSerialize(payload, header.count));
          break;
        case RtcpSourceDescriptionPacket.type:
          packets.push(RtcpSourceDescriptionPacket.deSerialize(payload));
          break;
        case RtcpPayloadSpecificFeedback.type:
          packets.push(
            RtcpPayloadSpecificFeedback.deSerialize(payload, header.count)
          );
          break;
        default:
          break;
      }
    }

    return packets;
  }
}
