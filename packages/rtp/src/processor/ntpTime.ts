import { randomUUID } from "crypto";

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
  readonly id = randomUUID();
  private baseNtpTimestamp?: bigint;
  private baseRtpTimestamp?: number;
  private latestNtpTimestamp?: bigint;
  private latestRtpTimestamp?: number;
  private currentElapsed = 0;
  private buffer: RtpPacket[] = [];
  private internalStats = {};
  started = false;

  constructor(public clockRate: number) {}

  toJSON(): Record<string, any> {
    return {
      ...this.internalStats,
      id: this.id,
      baseRtpTimestamp: this.baseRtpTimestamp,
      latestRtpTimestamp: this.latestRtpTimestamp,
      baseNtpTimestamp:
        this.baseNtpTimestamp && ntpTime2Sec(this.baseNtpTimestamp),
      latestNtpTimestamp:
        this.latestNtpTimestamp && ntpTime2Sec(this.latestNtpTimestamp),
      bufferLength: this.buffer.length,
      currentElapsed: this.currentElapsed,
      clockRate: this.clockRate,
    };
  }

  private stop() {
    this.buffer = [];
    this.internalStats = {};
  }

  processInput({ rtcp, rtp, eol }: NtpTimeInput): NtpTimeOutput[] {
    if (eol) {
      this.stop();
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

      this.internalStats["ntpReceived"] = new Date().toISOString();
      this.started = true;
    }

    if (rtp) {
      this.buffer.push(rtp);
      this.internalStats["payloadType"] = rtp.header.payloadType;

      const res: NtpTimeOutput[] = [];

      if (
        this.baseRtpTimestamp == undefined ||
        this.baseNtpTimestamp == undefined ||
        this.latestNtpTimestamp == undefined ||
        this.latestRtpTimestamp == undefined
      ) {
        return [];
      }

      for (const rtp of this.buffer) {
        const ntp = this.updateNtp(rtp.header.timestamp);
        const ms = ntp * 1000;
        const time = Math.round(ms);
        res.push({ rtp, time });

        this.internalStats["timeSource"] =
          new Date().toISOString() + " time:" + time;
      }
      this.buffer = [];
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

    // sec
    const ntp = ntpTime2Sec(baseNtpTimestamp) + elapsedOffset + elapsedSec;
    return { ntp, elapsedSec };
  }

  private updateNtp(rtpTimestamp: number) {
    this.internalStats["inputRtp"] = rtpTimestamp;

    const base = this.calcNtp({
      rtpTimestamp,
      baseNtpTimestamp: this.baseNtpTimestamp!,
      baseRtpTimestamp: this.baseRtpTimestamp!,
      elapsedOffset: this.currentElapsed,
    });
    const latest = this.calcNtp({
      rtpTimestamp,
      baseNtpTimestamp: this.latestNtpTimestamp!,
      baseRtpTimestamp: this.latestRtpTimestamp!,
      elapsedOffset: 0,
    });

    this.internalStats["calcBaseNtp"] = base.ntp;
    this.internalStats["calcLatestNtp"] = latest.ntp;

    if (base.ntp < latest.ntp) {
      // update baseNtp
      this.baseNtpTimestamp = this.latestNtpTimestamp;
      this.baseRtpTimestamp = this.latestRtpTimestamp;
      this.currentElapsed = 0;
      this.internalStats["calcNtp"] = latest.ntp;
      return latest.ntp;
    } else {
      this.currentElapsed += base.elapsedSec;
      this.baseRtpTimestamp = rtpTimestamp;
      this.internalStats["calcNtp"] = base.ntp;
      return base.ntp;
    }
  }
}
