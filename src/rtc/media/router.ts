import { RTCRtpReceiver } from "./rtpReceiver";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";
import { RtcpPacket } from "../../vendor/rtp/rtcp/rtcp";
import {
  RTCRtpReceiveParameters,
  RTCRtpSimulcastParameters,
} from "./parameters";
import { RtpTrack } from "./track";
import { RTCRtpSender } from "./rtpSender";
import { RtcpSrPacket } from "../../vendor/rtp/rtcp/sr";
import { RtcpRrPacket } from "../../vendor/rtp/rtcp/rr";
import { RTCRtpTransceiver } from "./rtpTransceiver";

export class RtpRouter {
  ssrcTable: { [ssrc: number]: RTCRtpReceiver } = {};
  ridTable: { [rid: string]: RTCRtpReceiver } = {};
  extIdUriMap: { [id: number]: string } = {};

  registerRtpReceiverBySsrc(
    transceiver: RTCRtpTransceiver,
    params: RTCRtpReceiveParameters
  ) {
    const ssrcs = params.encodings
      .map((encode) => encode.ssrc)
      .filter((v) => v);
    ssrcs.forEach((ssrc) => {
      this.ssrcTable[ssrc] = transceiver.receiver;
      transceiver.addTrack(new RtpTrack({ ssrc }));
    });

    params.headerExtensions.forEach((extension) => {
      this.extIdUriMap[extension.id] = extension.uri;
    });
  }

  registerRtpReceiverByRid(
    transceiver: RTCRtpTransceiver,
    param: RTCRtpSimulcastParameters
  ) {
    transceiver.addTrack(new RtpTrack({ rid: param.rid }));
    this.ridTable[param.rid] = transceiver.receiver;
  }

  routeRtp = (packet: RtpPacket) => {
    const extensions = packet.header.extensions
      .map((extension) => {
        const uri = this.extIdUriMap[extension.id];
        switch (uri) {
          case "urn:ietf:params:rtp-hdrext:sdes:mid":
            return { uri, value: extension.payload.toString() };
          case "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id":
            return { uri, value: extension.payload.toString() };
        }
      })
      .reduce((acc, cur) => {
        acc[cur.uri] = cur.value;
        return acc;
      }, {} as { [uri: string]: any });

    let ssrcReceiver = this.ssrcTable[packet.header.ssrc];
    if (!ssrcReceiver) {
      const rid = extensions["urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id"];
      ssrcReceiver = this.ridTable[rid];
      ssrcReceiver.handleRtpByRid(packet, rid);
    } else {
      ssrcReceiver.handleRtpBySsrc(packet, packet.header.ssrc);
    }

    ssrcReceiver.sdesMid = extensions["urn:ietf:params:rtp-hdrext:sdes:mid"];
  };

  routeRtcp = (packet: RtcpPacket) => {
    const recipients: (RTCRtpReceiver | RTCRtpSender)[] = [];
    switch (packet.type) {
      case RtcpSrPacket.type:
        recipients.push(this.ssrcTable[packet.ssrc]);
        break;
      case RtcpRrPacket.type:
        const rr = packet as RtcpRrPacket;
        rr.reports.forEach((report) => {
          recipients.push(this.ssrcTable[report.ssrc]);
        });
        break;
    }
    recipients
      .filter((v) => v)
      .forEach((recipient) => recipient.handleRtcpPacket(packet));
  };
}
