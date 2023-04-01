import { int, Max32Uint, RtpPacket } from "..";
import { Processor } from "./interface";

export type RtpTimeInput = {
  rtp?: RtpPacket;
  eol?: boolean;
};

export interface RtpTimeOutput {
  rtp?: RtpPacket;
  /**ms */
  time?: number;
  eol?: boolean;
}

export class RtpTimeBase implements Processor<RtpTimeInput, RtpTimeOutput> {
  baseTimestamp?: number;
  /**ms */
  elapsed = 0;

  constructor(public clockRate: number) {}

  processInput({ rtp, eol }: RtpTimeInput): RtpTimeOutput[] {
    if (eol) {
      return [{ eol: true }];
    }

    if (rtp) {
      const elapsed = this.update(rtp.header.timestamp);
      return [{ rtp, time: elapsed }];
    }

    return [];
  }

  /**
   *
   * @param timestamp
   * @returns ms
   */
  private update(timestamp: number) {
    if (this.baseTimestamp == undefined) {
      this.baseTimestamp = timestamp;
    }

    const rotate =
      Math.abs(timestamp - this.baseTimestamp) > (Max32Uint / 4) * 3;

    const elapsed = rotate
      ? timestamp + Max32Uint - this.baseTimestamp
      : timestamp - this.baseTimestamp;
    this.elapsed += int((elapsed / this.clockRate) * 1000);

    this.baseTimestamp = timestamp;

    return this.elapsed;
  }
}
