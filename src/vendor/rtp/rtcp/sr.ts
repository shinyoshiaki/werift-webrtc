import { bufferWriter, bufferReader } from "../helper";
import { range } from "lodash";
import { RtcpReceiverInfo } from "./rr";
import { RtcpPacket } from "./rtcp";

export class RtcpSrPacket {
  ssrc: number = 0;
  senderInfo: RtcpSenderInfo;
  reports: RtcpReceiverInfo[] = [];
  static type = 200;
  type = RtcpSrPacket.type;

  constructor(props: Partial<RtcpSrPacket> = {}) {
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
    return RtcpPacket.serialize(
      RtcpSrPacket.type,
      this.reports.length,
      payload
    );
  }

  static deSerialize(data: Buffer, count: number) {
    const ssrc = data.readUInt32BE();
    const senderInfo = RtcpSenderInfo.deSerialize(data.slice(4, 24));
    let pos = 24;
    const reports = [];
    for (const _ of range(count)) {
      reports.push(RtcpReceiverInfo.deSerialize(data.slice(pos, pos + 24)));
      pos += 24;
    }
    return new RtcpSrPacket({ ssrc, senderInfo, reports });
  }
}

class RtcpSenderInfo {
  ntpTimestamp: bigint;
  rtpTimestamp: number;
  packetCount: number;
  octetCount: number;

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
    const [
      ntpTimestamp,
      rtpTimestamp,
      packetCount,
      octetCount,
    ] = bufferReader(data, [8, 4, 4, 4]);

    return new RtcpSenderInfo({
      ntpTimestamp,
      rtpTimestamp,
      packetCount,
      octetCount,
    });
  }
}
