import { bufferReader, bufferWriter } from "../../../common/src";
import { RtcpSrPacket, RtpPacket } from "../../../rtp/src";

export class LipSync {
  baseNtpTimestamp?: bigint;
  baseRtpTimestamp?: number;

  constructor(public clockRate: number) {}

  srReceived(sr: RtcpSrPacket) {
    const { ntpTimestamp, rtpTimestamp } = sr.senderInfo;
    this.baseNtpTimestamp = ntpTimestamp;
    this.baseRtpTimestamp = rtpTimestamp;
  }

  calcNtpTime(rtpTimestamp: number) {
    if (!this.baseRtpTimestamp || !this.baseNtpTimestamp) {
      return 0;
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
