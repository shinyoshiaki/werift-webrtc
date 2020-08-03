import { RemoteStreamTrack } from "./mediastream";
import { RtcpPacket } from "../../vendor/rtp/rtcp/rtcp";
import { RtcpSrPacket } from "../../vendor/rtp/rtcp/sr";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";
import { v4 as uuid } from "uuid";
import Event from "rx.mini";
import { RTCDtlsTransport } from "../transport/dtls";

export class RTCRtpReceiver {
  uuid = uuid();
  track?: RemoteStreamTrack;
  onRtp = new Event<RtpPacket>();

  // # RTCP
  lsr: { [key: number]: BigInt } = {};
  lsrTime: { [key: number]: number } = {};
  private rtcpSsrc?: number;

  constructor(public kind: string, public dtlsTransport: RTCDtlsTransport) {
    dtlsTransport.onSrtp.subscribe(this.handleRtpPacket);
    dtlsTransport.onSrtcp.subscribe(this.handleRtcpPackets);
  }

  receive() {}

  setRtcpSsrc(ssrc: number) {
    this.rtcpSsrc = ssrc;
  }

  handleRtcpPackets = (packets: RtcpPacket[]) => {
    packets.forEach((packet) => {
      switch (packet.type) {
        case RtcpSrPacket.type:
          const sr = packet as RtcpSrPacket;
          this.lsr[sr.ssrc] =
            (sr.senderInfo.ntpTimestamp >> BigInt(16)) & BigInt(0xffffffff);
          this.lsrTime[packet.ssrc] = Date.now() / 1000;
          break;
      }
    });
  };

  handleRtpPacket = (packet: RtpPacket) => {
    this.onRtp.execute(packet);
  };
}
