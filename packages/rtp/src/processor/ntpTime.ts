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
  presentNtpTimestamp?: bigint;
  presentRtpTimestamp?: number;
  elapsed = 0;
  buffer: RtpPacket[] = [];
  private internalStats = {};

  constructor(public clockRate: number) {}

  toJSON(): Record<string, any> {
    return {
      baseRtpTimestamp: this.baseRtpTimestamp,
      presentRtpTimestamp: this.presentRtpTimestamp,
      baseNtpTimestamp:
        this.baseNtpTimestamp && ntpTime2Sec(this.baseNtpTimestamp),
      presentNtpTimestamp:
        this.presentNtpTimestamp && ntpTime2Sec(this.presentNtpTimestamp),
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
      this.presentNtpTimestamp = ntpTimestamp;
      this.presentRtpTimestamp = rtpTimestamp;

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

  private updateNtp(rtpTimestamp: number) {
    if (
      this.baseRtpTimestamp == undefined ||
      this.baseNtpTimestamp == undefined ||
      this.presentNtpTimestamp == undefined ||
      this.presentRtpTimestamp == undefined
    ) {
      return;
    }

    this.internalStats["latestInputRtp"] = rtpTimestamp;

    const base = this.calcNtp({
      rtpTimestamp,
      baseNtpTimestamp: this.baseNtpTimestamp,
      baseRtpTimestamp: this.baseRtpTimestamp,
      elapsedOffset: this.elapsed,
    });
    const present = this.calcNtp({
      rtpTimestamp,
      baseNtpTimestamp: this.presentNtpTimestamp,
      baseRtpTimestamp: this.presentRtpTimestamp,
      elapsedOffset: 0,
    });

    this.internalStats["latestCalcBaseNtp"] = base.ntp;
    this.internalStats["latestCalcPresentNtp"] = present.ntp;

    if (base.ntp >= present.ntp) {
      this.elapsed += base.elapsedSec;
      this.baseRtpTimestamp = rtpTimestamp;
      this.internalStats["latestCalcNtp"] = base.ntp;
      return base.ntp;
    } else {
      this.baseNtpTimestamp = this.presentNtpTimestamp;
      this.baseRtpTimestamp = this.presentRtpTimestamp;
      this.elapsed = 0;
      this.internalStats["latestCalcNtp"] = present.ntp;
      return present.ntp;
    }
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
}
