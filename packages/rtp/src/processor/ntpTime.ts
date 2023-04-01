import {
  bufferReader,
  bufferWriter,
  Max32Uint,
  RtcpPacket,
  RtcpSrPacket,
  RtpPacket,
} from "..";
import { Processor } from "./interface";

export type NtpTimeInput = {
  rtp?: RtpPacket;
  eol?: boolean;
  rtcp?: RtcpPacket;
};

export interface NtpTimeOutput {
  rtp?: RtpPacket;
  /**ms */
  time?: number;
  eol?: boolean;
}

export class NtpTimeBase implements Processor<NtpTimeInput, NtpTimeOutput> {
  ntpTimestamp?: bigint;
  baseRtpTimestamp?: number;
  elapsed = 0;
  buffer: RtpPacket[] = [];

  constructor(public clockRate: number) {}

  processInput({ rtcp, rtp, eol }: NtpTimeInput): NtpTimeOutput[] {
    if (eol) {
      return [{ eol: true }];
    }

    if (rtcp && rtcp instanceof RtcpSrPacket && !this.ntpTimestamp) {
      const { ntpTimestamp, rtpTimestamp } = rtcp.senderInfo;
      this.ntpTimestamp = ntpTimestamp;
      this.baseRtpTimestamp = rtpTimestamp;
    }

    if (rtp) {
      this.buffer.push(rtp);

      const res: NtpTimeOutput[] = [];

      this.buffer = this.buffer
        .map((rtp) => {
          const ntp = this.calcNtp(rtp.header.timestamp);
          if (ntp != undefined) {
            const ms = ntp * 1000;
            res.push({ rtp, time: ms });
            return undefined;
          }
          return rtp;
        })
        .filter((r): r is NonNullable<typeof r> => r != undefined);
      return res;
    }

    return [];
  }

  /**
   *
   * @param rtpTimestamp
   * @returns sec
   */
  private calcNtp(rtpTimestamp: number) {
    if (this.baseRtpTimestamp == undefined || this.ntpTimestamp == undefined) {
      return;
    }

    const rotate =
      Math.abs(rtpTimestamp - this.baseRtpTimestamp) > (Max32Uint / 4) * 3;

    const elapsed = rotate
      ? rtpTimestamp + Max32Uint - this.baseRtpTimestamp
      : rtpTimestamp - this.baseRtpTimestamp;
    this.elapsed += elapsed / this.clockRate;

    this.baseRtpTimestamp = rtpTimestamp;

    const ntp = ntpTime2Time(this.ntpTimestamp) + this.elapsed;
    return ntp;
  }
}

export const ntpTime2Time = (ntp: bigint) => {
  const [ntpSec, ntpMsec] = bufferReader(bufferWriter([8], [ntp]), [4, 4]);

  return Number(`${ntpSec}.${ntpMsec}`);
};
