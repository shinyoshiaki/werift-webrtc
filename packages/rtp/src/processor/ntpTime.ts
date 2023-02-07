import debug from "debug";

import {
  bufferReader,
  bufferWriter,
  RtcpPacket,
  RtcpSrPacket,
  RtpPacket,
} from "..";
import { Max32bit } from "../processor_old/lipsync";
import { Processor } from "./interface";

const log = debug("werift-rtp : packages/rtp/src/processor/ntpTime.ts");

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

export class syncRtpBase implements Processor<NtpTimeInput, NtpTimeOutput> {
  ntpTimestamp?: bigint;
  rtpTimestamp?: number;

  buffer: RtpPacket[] = [];

  constructor(public clockRate: number) {}

  processInput({ rtcp, rtp, eol }: NtpTimeInput): NtpTimeOutput[] {
    if (eol) {
      return [{ eol: true }];
    }

    if (rtcp && rtcp instanceof RtcpSrPacket && !this.ntpTimestamp) {
      const { ntpTimestamp, rtpTimestamp } = rtcp.senderInfo;
      this.ntpTimestamp = ntpTimestamp;
      this.rtpTimestamp = rtpTimestamp;
    }

    if (rtp) {
      this.buffer.push(rtp);

      const res: NtpTimeOutput[] = [];

      this.buffer = this.buffer
        .map((rtp) => {
          const ntp = this.calcNtp(rtp.header.timestamp);
          if (ntp) {
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

  /**sec */
  private calcNtp(rtpTimestamp: number) {
    if (this.rtpTimestamp == undefined || this.ntpTimestamp == undefined) {
      return;
    }

    // base rtpTimestamp is rollover
    if (rtpTimestamp - this.rtpTimestamp > Max32bit - this.clockRate * 60) {
      this.rtpTimestamp += Max32bit;
      log("base rtpTimestamp is rollover");
    }

    // target rtpTimestamp is rollover
    else if (
      rtpTimestamp + (Max32bit - this.clockRate * 60) - this.rtpTimestamp <
      0
    ) {
      rtpTimestamp += Max32bit;
      log("target rtpTimestamp is rollover");
    }

    const elapsed = (rtpTimestamp - this.rtpTimestamp) / this.clockRate;

    const ntp = ntpTime2Time(this.ntpTimestamp) + elapsed;

    return ntp;
  }
}

export const ntpTime2Time = (ntp: bigint) => {
  const [ntpSec, ntpMsec] = bufferReader(bufferWriter([8], [ntp]), [4, 4]);

  return Number(`${ntpSec}.${ntpMsec}`);
};
