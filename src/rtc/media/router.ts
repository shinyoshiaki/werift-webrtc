import { RTCRtpReceiver } from "./rtpReceiver";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";
import { RtcpPacket } from "../../vendor/rtp/rtcp/rtcp";
import { RTCRtpReceiveParameters } from "./parameters";

export class RtpRouter {
  ssrcTable: { [ssrc: number]: RTCRtpReceiver } = {};

  private registerReceiver(receiver: RTCRtpReceiver, ssrcs: number[]) {
    ssrcs.forEach((ssrc) => {
      this.ssrcTable[ssrc] = receiver;
    });
  }

  registerRtpReceiver(
    receiver: RTCRtpReceiver,
    params: RTCRtpReceiveParameters
  ) {
    const ssrcs = params.encodings.map((encode) => encode.ssrc);
    this.registerReceiver(receiver, ssrcs);
  }

  routeRtp = (packet: RtpPacket) => {
    const ssrcReceiver = this.ssrcTable[packet.header.ssrc];
    ssrcReceiver.handleRtpPacket(packet);
  };

  routeRtcp = (packets: RtcpPacket[]) => {
    // todo impl
  };
}
