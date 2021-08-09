import { bufferReader, bufferWriter } from "../../../common/src";
import { RtcpSrPacket, RtpPacket } from "../../../rtp/src";

export class LipSync {
  audio: { [sequenceNumber: number]: RtpPacket } = {};
  video: { [sequenceNumber: number]: RtpPacket } = {};

  constructor(
    public bufferTime: number,
    public audioClockRate: number,
    public videoClockRate: number
  ) {}

  audioReceived() {}
}

export class MediaBuffer {
  baseNtpTimestamp?: bigint;
  baseRtpTimestamp?: number;
  packets: { [sequenceNumber: number]: RtpPacket } = {};

  constructor(public clockRate: number) {}

  rtpReceived(rtp: RtpPacket) {
    this.packets[rtp.header.sequenceNumber] = rtp;
  }

  srReceived(sr: RtcpSrPacket) {
    const { ntpTimestamp, rtpTimestamp } = sr.senderInfo;
    this.baseNtpTimestamp = ntpTimestamp;
    this.baseRtpTimestamp = rtpTimestamp;
  }

  calcNtpTime(rtpTimestamp: number) {
    if (!this.baseRtpTimestamp || !this.baseNtpTimestamp) {
      throw new Error("props not exist");
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
