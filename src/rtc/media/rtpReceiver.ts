import { RemoteStreamTrack } from "./mediastream";
import { RtcpPacket } from "../../vendor/rtp/rtcp/rtcp";
import { RtcpSrPacket } from "../../vendor/rtp/rtcp/sr";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";
import { v4 as uuid } from "uuid";
import { RTCSrtpTransport } from "../transport/srtp";
import Event from "rx.mini";

export class RTCRtpReceiver {
  uuid = uuid();
  track?: RemoteStreamTrack;
  onRtp = new Event<RtpPacket>();

  // # RTCP
  lsr: { [key: number]: BigInt } = {};
  lsrTime: { [key: number]: number } = {};
  private rtcpSsrc?: number;

  constructor(public kind: string, public srtpTransport: RTCSrtpTransport) {
    srtpTransport.onSrtp.subscribe((rtp) => {
      this.handleRtpPacket(rtp);
    });
    srtpTransport.onSrtcp.subscribe((rtcpArr) => {
      rtcpArr.forEach((rtcp) => this.handleRtcpPacket(rtcp));
    });
  }

  receive() {}

  setRtcpSsrc(ssrc: number) {
    this.rtcpSsrc = ssrc;
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

  handleRtpPacket(packet: RtpPacket) {
    const codec = packet.header.payloadType;
    // 97 is vp8

    this.onRtp.execute(packet);
  }
}
