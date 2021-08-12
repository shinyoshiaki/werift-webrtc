import Event from "rx.mini";

import { bufferReader, bufferWriter } from "../../../common/src";
import { RtcpSrPacket, RtpPacket } from "../../../rtp/src";

export class LipSync {
  audio = new MediaBuffer(this.audioClockRate);
  video = new MediaBuffer(this.videoClockRate);

  onBufferResolve = new Event<
    [
      {
        audio: BufferResolve;
        video: BufferResolve;
      }
    ]
  >();

  constructor(
    public bufferTimeMs: number,
    public audioClockRate: number,
    public videoClockRate: number
  ) {
    setInterval(() => {
      this.onBufferResolve.execute({
        audio: this.calcLipSync(this.audio),
        video: this.calcLipSync(this.video),
      });
      this.audio.clearPackets();
      this.video.clearPackets();
    }, bufferTimeMs);
  }

  calcLipSync = (media: MediaBuffer) => {
    const packets = media.sortedPackets;
    const startAtNtpTime = packets[0]
      ? media.calcNtpTime(packets[0].header.timestamp)
      : 0;
    return { packets, startAtNtpTime };
  };
}

export class MediaBuffer {
  baseNtpTimestamp?: bigint;
  baseRtpTimestamp?: number;
  private packets: { [sequenceNumber: number]: RtpPacket } = {};

  constructor(public clockRate: number) {}

  get sortedPackets() {
    const packets = Object.keys(this.packets)
      .sort()
      .map((key) => this.packets[Number(key)]);
    return packets;
  }

  clearPackets() {
    this.packets = {};
  }

  rtpReceived(rtp: RtpPacket) {
    this.packets[rtp.header.sequenceNumber] = rtp;
  }

  srReceived(sr: RtcpSrPacket) {
    const { ntpTimestamp, rtpTimestamp } = sr.senderInfo;
    this.baseNtpTimestamp = ntpTimestamp;
    this.baseRtpTimestamp = rtpTimestamp;
  }

  calcNtpTime(rtpTimestamp: number) {
    if (!this.baseRtpTimestamp || !this.baseNtpTimestamp) return 0;

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

export type BufferResolve = { packets: RtpPacket[]; startAtNtpTime: number };
