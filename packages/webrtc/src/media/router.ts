import debug from "debug";
import {
  ReceiverEstimatedMaxBitrate,
  RtcpPacket,
  RtcpPayloadSpecificFeedback,
  RtcpRrPacket,
  RtcpSourceDescriptionPacket,
  RtcpSrPacket,
  RtcpTransportLayerFeedback,
  RtpPacket,
} from "../../../rtp/src";
import { bufferReader } from "../../../rtp/src/helper";
import { RTP_EXTENSION_URI } from "../extension/rtpExtension";
import {
  RTCRtpReceiveParameters,
  RTCRtpSimulcastParameters,
} from "./parameters";
import { RTCRtpReceiver } from "./rtpReceiver";
import { RTCRtpSender } from "./rtpSender";
import { RTCRtpTransceiver } from "./rtpTransceiver";
import { MediaStreamTrack } from "./track";

const log = debug("werift/webrtc/media/router");

export type Extensions = { [uri: string]: number | string };

export class RtpRouter {
  ssrcTable: { [ssrc: number]: RTCRtpReceiver | RTCRtpSender } = {};
  ridTable: { [rid: string]: RTCRtpReceiver | RTCRtpSender } = {};
  extIdUriMap: { [id: number]: string } = {};

  registerRtpReceiverBySsrc(
    transceiver: RTCRtpTransceiver,
    params: RTCRtpReceiveParameters
  ) {
    log("registerRtpReceiverBySsrc", params);

    const ssrcs = params.encodings
      .map((encode) => encode.ssrc)
      .filter((v) => v);
    ssrcs.forEach((ssrc) => {
      this.ssrcTable[ssrc] = transceiver.receiver;
      transceiver.addTrack(
        new MediaStreamTrack({
          ssrc,
          kind: transceiver.kind,
          id: transceiver.sender.streamId,
          remote: true,
        })
      );
    });

    params.headerExtensions.forEach((extension) => {
      this.extIdUriMap[extension.id] = extension.uri;
    });
  }

  registerRtpReceiverByRid(
    transceiver: RTCRtpTransceiver,
    param: RTCRtpSimulcastParameters
  ) {
    log("registerRtpReceiverByRid", param);
    transceiver.addTrack(
      new MediaStreamTrack({
        rid: param.rid,
        kind: transceiver.kind,
        id: transceiver.sender.streamId,
        remote: true,
      })
    );
    this.ridTable[param.rid] = transceiver.receiver;
  }

  routeRtp = (packet: RtpPacket) => {
    const extensions: Extensions = packet.header.extensions
      .map((extension) => {
        const uri = this.extIdUriMap[extension.id];
        switch (uri) {
          case RTP_EXTENSION_URI.sdesMid:
          case RTP_EXTENSION_URI.sdesRTPStreamID:
            return { uri, value: extension.payload.toString() };
          case RTP_EXTENSION_URI.transportWideCC:
            return { uri, value: extension.payload.readUInt16BE() };
          case RTP_EXTENSION_URI.absSendTime:
            return {
              uri,
              value: bufferReader(extension.payload, [3])[0],
            };
        }
      })
      .reduce((acc: { [uri: string]: any }, cur) => {
        if (cur) acc[cur.uri] = cur.value;
        return acc;
      }, {});

    let ssrcReceiver = this.ssrcTable[packet.header.ssrc] as RTCRtpReceiver;
    const rid = extensions[RTP_EXTENSION_URI.sdesRTPStreamID] as string;

    if (rid) {
      ssrcReceiver = this.ridTable[rid] as RTCRtpReceiver;
      ssrcReceiver.handleRtpByRid(packet, rid, extensions);
    } else {
      if (!ssrcReceiver) return; // simulcast + absSendTime

      ssrcReceiver.handleRtpBySsrc(packet, extensions);
    }

    ssrcReceiver.sdesMid = extensions[
      "urn:ietf:params:rtp-hdrext:sdes:mid"
    ] as string;
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
      case RtcpTransportLayerFeedback.type:
        {
          const rtpfb = packet as RtcpTransportLayerFeedback;
          if (rtpfb.feedback) {
            recipients.push(this.ssrcTable[rtpfb.feedback.mediaSourceSsrc]);
          }
        }
        break;
      case RtcpPayloadSpecificFeedback.type:
        {
          const psfb = packet as RtcpPayloadSpecificFeedback;
          switch (psfb.feedback.count) {
            case ReceiverEstimatedMaxBitrate.count:
              const remb = psfb.feedback as ReceiverEstimatedMaxBitrate;
              recipients.push(this.ssrcTable[remb.ssrcFeedbacks[0]]);
              break;
            default:
              recipients.push(this.ssrcTable[psfb.feedback.senderSsrc]);
          }
        }
        break;
    }
    recipients
      .filter((v) => v) // todo simulcast
      .forEach((recipient) => recipient.handleRtcpPacket(packet));
  };
}
