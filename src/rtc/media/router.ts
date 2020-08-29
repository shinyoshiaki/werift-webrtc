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
import { RtcpPayloadSpecificFeedback } from "../../vendor/rtp/rtcp/psfb";
import { RtcpSourceDescriptionPacket } from "../../vendor/rtp/rtcp/sdes";

export class RtpRouter {
  ssrcTable: { [ssrc: number]: RTCRtpReceiver | RTCRtpSender } = {};
  ridTable: { [rid: string]: RTCRtpReceiver | RTCRtpSender } = {};
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

    let ssrcReceiver = this.ssrcTable[packet.header.ssrc] as RTCRtpReceiver;
    const rid = extensions["urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id"];

    if (rid) {
      ssrcReceiver = this.ridTable[rid] as RTCRtpReceiver;
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
        {
          packet = packet as RtcpSrPacket;
          recipients.push(this.ssrcTable[packet.ssrc]);
        }
        break;
      case RtcpRrPacket.type:
        {
          packet = packet as RtcpRrPacket;
          packet.reports.forEach((report) => {
            recipients.push(this.ssrcTable[report.ssrc]);
          });
        }
        break;
      case RtcpSourceDescriptionPacket.type:
        {
          const sdes = packet as RtcpSourceDescriptionPacket;
          // console.log("sdes", JSON.stringify(sdes.chunks));
        }
        break;
      case RtcpPayloadSpecificFeedback.type:
        {
          const psfb = packet as RtcpPayloadSpecificFeedback;
          if (psfb.feedback)
            recipients.push(this.ssrcTable[psfb.feedback.senderSsrc]);
        }
        break;
    }
    recipients
      .filter((v) => v) // todo simulcast
      .forEach((recipient) => recipient.handleRtcpPacket(packet));
  };
}
