import {
  Max32Uint,
  ntpTime2Sec,
  Processor,
  RtcpPacket,
  RtcpSrPacket,
  RtpPacket,
} from "..";

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
  baseNtpTimestamp?: bigint;
  baseRtpTimestamp?: number;
  latestNtpTimestamp?: bigint;
  latestRtpTimestamp?: number;
  elapsed = 0;
  buffer: RtpPacket[] = [];
  private internalStats = {};

  constructor(public clockRate: number) {}

  toJSON(): Record<string, any> {
    return {
      baseRtpTimestamp: this.baseRtpTimestamp,
      latestRtpTimestamp: this.latestRtpTimestamp,
      baseNtpTimestamp:
        this.baseNtpTimestamp && ntpTime2Sec(this.baseNtpTimestamp),
      latestNtpTimestamp:
        this.latestNtpTimestamp && ntpTime2Sec(this.latestNtpTimestamp),
      bufferLength: this.buffer.length,
      elapsed: this.elapsed,
      ...this.internalStats,
    };
  }

  processInput({ rtcp, rtp, eol }: NtpTimeInput): NtpTimeOutput[] {
    if (eol) {
      return [{ eol: true }];
    }

    if (rtcp && rtcp instanceof RtcpSrPacket) {
      const { ntpTimestamp, rtpTimestamp } = rtcp.senderInfo;
      this.latestNtpTimestamp = ntpTimestamp;
      this.latestRtpTimestamp = rtpTimestamp;

      if (this.baseNtpTimestamp == undefined) {
        this.baseNtpTimestamp = ntpTimestamp;
        this.baseRtpTimestamp = rtpTimestamp;
      }
    }

    if (rtp) {
      this.buffer.push(rtp);

      const res: NtpTimeOutput[] = [];

      this.buffer = this.buffer
        .map((rtp) => {
          const ntp = this.updateNtp(rtp.header.timestamp);
          if (ntp != undefined) {
            const ms = ntp * 1000;
            res.push({ rtp, time: Math.round(ms) });
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
  private calcNtp({
    rtpTimestamp,
    baseNtpTimestamp,
    baseRtpTimestamp,
    elapsedOffset,
  }: {
    rtpTimestamp: number;
    baseRtpTimestamp: number;
    baseNtpTimestamp: bigint;
    elapsedOffset: number;
  }) {
    const rotate =
      Math.abs(rtpTimestamp - baseRtpTimestamp) > (Max32Uint / 4) * 3;

    const elapsed = rotate
      ? rtpTimestamp + Max32Uint - baseRtpTimestamp
      : rtpTimestamp - baseRtpTimestamp;
    const elapsedSec = elapsed / this.clockRate;

    const ntp = ntpTime2Sec(baseNtpTimestamp) + elapsedOffset + elapsedSec;
    return { ntp, elapsedSec };
  }

  private updateNtp(rtpTimestamp: number) {
    if (
      this.baseRtpTimestamp == undefined ||
      this.baseNtpTimestamp == undefined ||
      this.latestNtpTimestamp == undefined ||
      this.latestRtpTimestamp == undefined
    ) {
      return;
    }

    this.internalStats["inputRtp"] = rtpTimestamp;

    const base = this.calcNtp({
      rtpTimestamp,
      baseNtpTimestamp: this.baseNtpTimestamp,
      baseRtpTimestamp: this.baseRtpTimestamp,
      elapsedOffset: this.elapsed,
    });
    const latest = this.calcNtp({
      rtpTimestamp,
      baseNtpTimestamp: this.latestNtpTimestamp,
      baseRtpTimestamp: this.latestRtpTimestamp,
      elapsedOffset: 0,
    });

    this.internalStats["calcBaseNtp"] = base.ntp;
    this.internalStats["calcLatestNtp"] = latest.ntp;

    if (base.ntp < latest.ntp) {
      // update baseNtp
      this.baseNtpTimestamp = this.latestNtpTimestamp;
      this.baseRtpTimestamp = this.latestRtpTimestamp;
      this.elapsed = 0;
      this.internalStats["calcNtp"] = latest.ntp;
      return latest.ntp;
    } else {
      this.elapsed += base.elapsedSec;
      this.baseRtpTimestamp = rtpTimestamp;
      this.internalStats["calcNtp"] = base.ntp;
      return base.ntp;
    }
  }
}
