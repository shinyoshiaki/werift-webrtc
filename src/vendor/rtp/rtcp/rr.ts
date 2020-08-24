import { bufferWriter, bufferReader } from "../helper";
import { RtcpPacketConverter } from "./rtcp";
import { range } from "lodash";

export class RtcpRrPacket {
  ssrc: number = 0;
  reports: RtcpReceiverInfo[] = [];
  static type = 201;
  type = RtcpRrPacket.type;

  constructor(props: Partial<RtcpRrPacket> = {}) {
    Object.assign(this, props);
  }

  serialize() {
    let payload = bufferWriter([4], [this.ssrc]);
    payload = Buffer.concat([
      payload,
      ...this.reports.map((report) => report.serialize()),
    ]);
    return RtcpPacketConverter.serialize(
      RtcpRrPacket.type,
      this.reports.length,
      payload
    );
  }

  static deSerialize(data: Buffer, count: number) {
    const [ssrc] = bufferReader(data, [4]);
    let pos = 4;
    const reports: RtcpReceiverInfo[] = [];
    range(count).forEach(() => {
      reports.push(RtcpReceiverInfo.deSerialize(data.slice(pos, pos + 24)));
      pos += 24;
    });
    return new RtcpRrPacket({ ssrc, reports });
  }
}

export class RtcpReceiverInfo {
  ssrc: number;
  fractionLost: number;
  packetsLost: number;
  highestSequence: number;
  jitter: number;
  lsr: bigint;
  dlsr: number;

  constructor(props: Partial<RtcpReceiverInfo> = {}) {
    Object.assign(this, props);
  }

  serialize() {
    return bufferWriter(
      [4, 1, 3, 4, 4, 4, 4],
      [
        this.ssrc,
        this.fractionLost,
        this.packetsLost,
        this.highestSequence,
        this.jitter,
        this.lsr,
        this.dlsr,
      ]
    );
  }

  static deSerialize(data: Buffer) {
    const [
      ssrc,
      fractionLost,
      packetsLost,
      highestSequence,
      jitter,
      lsr,
      dlsr,
    ] = bufferReader(data, [4, 1, 3, 4, 4, 4, 4]);

    return new RtcpReceiverInfo({
      ssrc,
      fractionLost,
      packetsLost,
      highestSequence,
      jitter,
      lsr: BigInt(lsr),
      dlsr,
    });
  }
}
