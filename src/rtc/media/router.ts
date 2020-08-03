import { RTCRtpReceiver } from "./rtpReceiver";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";

export class RtpRouter {
  receivers: { [key: string]: RTCRtpReceiver } = {};
  ssrcTable: { [key: number]: RTCRtpReceiver } = {};

  registerReceiver(receiver: RTCRtpReceiver, ssrcs: number[]) {
    this.receivers[receiver.uuid] = receiver;
    ssrcs.forEach((ssrc) => {
      this.ssrcTable[ssrc] = receiver;
    });
  }

  routeRtp(packet: RtpPacket) {
    const ssrcReceiver = this.ssrcTable[packet.header.ssrc];

    // todo impl

    return ssrcReceiver;
  }
}
