import { RtcpPacket } from "../../vendor/rtp/rtcp/rtcp";
import { RtcpSrPacket } from "../../vendor/rtp/rtcp/sr";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";
import { v4 as uuid } from "uuid";
import Event from "rx.mini";
import { RtpTrack } from "./track";
import { RtcpRrPacket } from "../../vendor/rtp/rtcp/rr";
import { RTCDtlsTransport } from "../transport/dtls";
import { sleep } from "../../helper";

export class RTCRtpReceiver {
  uuid = uuid();
  readonly tracks: RtpTrack[] = [];
  onTrack = new Event<RtpTrack>();

  // # RTCP
  lsr: { [key: number]: BigInt } = {};
  lsrTime: { [key: number]: number } = {};
  rtcpSsrc: number;

  sdesMid: string;
  rid: string;

  constructor(public kind: string, public dtlsTransport: RTCDtlsTransport) {}

  rtcpRunner = false;
  async runRtcp() {
    if (this.rtcpRunner) return;
    this.rtcpRunner = true;

    while (true) {
      await sleep(500 + Math.random() * 1000);

      const reports = [];
      const packet = new RtcpRrPacket({ ssrc: this.rtcpSsrc, reports });
      this.dtlsTransport.sendRtcp([packet]);
    }
  }

  addTrack(track: RtpTrack) {
    this.tracks.push(track);
    this.onTrack.execute(track);
  }

  handleRtcpPacket(packet: RtcpPacket) {
    switch (packet.type) {
      case RtcpSrPacket.type:
        const sr = packet as RtcpSrPacket;
        this.lsr[sr.ssrc] =
          (sr.senderInfo.ntpTimestamp >> BigInt(16)) & BigInt(0xffffffff);
        this.lsrTime[packet.ssrc] = Date.now() / 1000;
        break;
    }
  }

  handleRtpBySsrc = (packet: RtpPacket, ssrc: number) => {
    const track = this.tracks.find((track) => track.ssrc === ssrc);
    track.onRtp.execute(packet);
    this.runRtcp();
  };

  handleRtpByRid = (packet: RtpPacket, rid: string) => {
    const track = this.tracks.find((track) => track.rid === rid);
    track.onRtp.execute(packet);
    this.runRtcp();
  };
}
