import { bufferReader, bufferWriter } from "../../../common/src";
import { RtcpSrPacket, RtpPacket } from "../../../rtp/src";
import { RtcpPacket } from "../rtcp/rtcp";
import { Pipeline } from "./domain";

export class LipSync implements Pipeline {
  baseNtpTimestamp?: bigint;
  baseRtpTimestamp?: number;
  private rtpPackets: { [pt: number]: RtpPacket[] } = {};
  private children?: Pipeline;

  constructor(public clockRate: number, public mismatch: number) {}

  pipe(children: Pipeline) {
    this.children = children;
  }

  pushRtcpPackets(packets: RtcpPacket[]) {
    packets.forEach((sr) => {
      if (sr instanceof RtcpSrPacket) {
        this.srReceived(sr);
      }
    });
    this.children?.pushRtcpPackets?.(packets);
  }

  private srReceived(sr: RtcpSrPacket) {
    const { ntpTimestamp, rtpTimestamp } = sr.senderInfo;
    this.baseNtpTimestamp = ntpTimestamp;
    this.baseRtpTimestamp = rtpTimestamp;
  }

  pushRtpPackets(packets: RtpPacket[]) {
    packets.forEach((p) => {
      this.rtpPackets[p.header.payloadType] =
        this.rtpPackets[p.header.payloadType] ?? [];
      this.rtpPackets[p.header.payloadType].push(p);
    });
    if (Object.keys(this.rtpPackets).length === 2) {
      const [a, b] = Object.values(this.rtpPackets);
      const lastA = this.calcNtpTime(a.slice(-1)[0].header.timestamp);
      const lastB = this.calcNtpTime(b.slice(-1)[0].header.timestamp);

      if (lastA == undefined || lastB == undefined) {
        this.children?.pushRtpPackets?.(packets);
      } else {
        //
      }
    }
  }

  private calcNtpTime(rtpTimestamp: number) {
    if (!this.baseRtpTimestamp || !this.baseNtpTimestamp) {
      return;
    }

    // base rtpTimestamp is rollover
    if (rtpTimestamp - this.baseRtpTimestamp > Max32bit - this.clockRate * 60) {
      this.baseRtpTimestamp += Max32bit;
    }
    // target rtpTimestamp is rollover
    else if (
      rtpTimestamp + (Max32bit - this.clockRate * 60) - this.baseRtpTimestamp <
      0
    ) {
      rtpTimestamp += Max32bit;
    }

    const elapsed = (rtpTimestamp - this.baseRtpTimestamp) / this.clockRate;

    return ntpTime2Time(this.baseNtpTimestamp) + elapsed;
  }
}

export const ntpTime2Time = (ntp: bigint) => {
  const [ntpSec, ntpMsec] = bufferReader(bufferWriter([8], [ntp]), [4, 4]);

  return Number(`${ntpSec}.${ntpMsec}`);
};

/**4294967295 */
export const Max32bit = Number((0x01n << 32n) - 1n);

export interface BufferResolve {
  packets: {
    packet: RtpPacket;
    offset: number;
  }[];
  /**NTP seconds */
  startAtNtpTime: number;
}
