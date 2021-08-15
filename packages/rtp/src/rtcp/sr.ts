import { range } from "lodash";

import { bufferReader, bufferWriter } from "../../../common/src";
import { RtcpReceiverInfo } from "./rr";
import { RtcpPacketConverter } from "./rtcp";

// https://datatracker.ietf.org/doc/html/rfc3550#section-6.4.1
//         0                   1                   2                   3
//         0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// header |V=2|P|    RC   |   PT=SR=200   |             length            |
//        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//        |                         SSRC of sender                        |
//        +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
// sender |              NTP timestamp, most significant word             |
// info   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//        |             NTP timestamp, least significant word             |
//        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//        |                         RTP timestamp                         |
//        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//        |                     sender's packet count                     |
//        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//        |                      sender's octet count                     |
//        +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
// report |                 SSRC_1 (SSRC of first source)                 |
// block  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//   1    | fraction lost |       cumulative number of packets lost       |
//        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//        |           extended highest sequence number received           |
//        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//        |                      interarrival jitter                      |
//        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//        |                         last SR (LSR)                         |
//        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//        |                   delay since last SR (DLSR)                  |
//        +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
// report |                 SSRC_2 (SSRC of second source)                |
// block  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//   2    :                               ...                             :
//        +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
//        |                  profile-specific extensions                  |
//        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

export class RtcpSrPacket {
  ssrc: number = 0;
  senderInfo!: RtcpSenderInfo;
  reports: RtcpReceiverInfo[] = [];
  static readonly type = 200;
  readonly type = RtcpSrPacket.type;

  constructor(props: Pick<RtcpSrPacket, "senderInfo"> & Partial<RtcpSrPacket>) {
    Object.assign(this, props);
  }

  serialize() {
    let payload = Buffer.alloc(4);
    payload.writeUInt32BE(this.ssrc);
    payload = Buffer.concat([payload, this.senderInfo.serialize()]);
    payload = Buffer.concat([
      payload,
      ...this.reports.map((report) => report.serialize()),
    ]);
    return RtcpPacketConverter.serialize(
      RtcpSrPacket.type,
      this.reports.length,
      payload,
      Math.floor(payload.length / 4)
    );
  }

  static deSerialize(payload: Buffer, count: number) {
    const ssrc = payload.readUInt32BE();
    const senderInfo = RtcpSenderInfo.deSerialize(payload.slice(4, 24));
    let pos = 24;
    const reports: RtcpReceiverInfo[] = [];
    for (const _ of range(count)) {
      reports.push(RtcpReceiverInfo.deSerialize(payload.slice(pos, pos + 24)));
      pos += 24;
    }
    return new RtcpSrPacket({ ssrc, senderInfo, reports });
  }
}

export class RtcpSenderInfo {
  ntpTimestamp!: bigint;
  rtpTimestamp!: number;
  packetCount!: number;
  octetCount!: number;

  constructor(props: Partial<RtcpSenderInfo> = {}) {
    Object.assign(this, props);
  }

  serialize() {
    return bufferWriter(
      [8, 4, 4, 4],
      [this.ntpTimestamp, this.rtpTimestamp, this.packetCount, this.octetCount]
    );
  }

  static deSerialize(data: Buffer) {
    const [ntpTimestamp, rtpTimestamp, packetCount, octetCount] = bufferReader(
      data,
      [8, 4, 4, 4]
    );

    return new RtcpSenderInfo({
      ntpTimestamp,
      rtpTimestamp,
      packetCount,
      octetCount,
    });
  }
}
