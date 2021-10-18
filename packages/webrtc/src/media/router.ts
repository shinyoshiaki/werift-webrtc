import debug from "debug";

import { bufferReader } from "../../../common/src";
import {
  Extension,
  ReceiverEstimatedMaxBitrate,
  RtcpPacket,
  RtcpPayloadSpecificFeedback,
  RtcpRrPacket,
  RtcpSourceDescriptionPacket,
  RtcpSrPacket,
  RtcpTransportLayerFeedback,
  RtpPacket,
} from "../../../rtp/src";
import { RTP_EXTENSION_URI } from "./extension/rtpExtension";
import {
  RTCRtpReceiveParameters,
  RTCRtpSimulcastParameters,
} from "./parameters";
import { RTCRtpReceiver } from "./rtpReceiver";
import { RTCRtpSender } from "./rtpSender";
import { RTCRtpTransceiver } from "./rtpTransceiver";
import { MediaStreamTrack } from "./track";

const log = debug("werift:packages/webrtc/src/media/router.ts");

export type Extensions = { [uri: string]: number | string };

export class RtpRouter {
  private ssrcTable: { [ssrc: number]: RTCRtpReceiver | RTCRtpSender } = {};
  private ridTable: { [rid: string]: RTCRtpReceiver | RTCRtpSender } = {};
  private extIdUriMap: { [id: number]: string } = {};

  constructor() {}

  registerRtpSender(sender: RTCRtpSender) {
    this.ssrcTable[sender.ssrc] = sender;
  }

  private registerRtpReceiver(receiver: RTCRtpReceiver, ssrc: number) {
    this.ssrcTable[ssrc] = receiver;
  }

  registerRtpReceiverBySsrc(
    transceiver: RTCRtpTransceiver,
    params: RTCRtpReceiveParameters
  ) {
    log("registerRtpReceiverBySsrc", params);

    params.encodings
      .filter((e) => e.ssrc != undefined) // todo fix
      .forEach((encode, i) => {
        this.registerRtpReceiver(transceiver.receiver, encode.ssrc);
        transceiver.addTrack(
          new MediaStreamTrack({
            ssrc: encode.ssrc,
            kind: transceiver.kind,
            id: transceiver.sender.trackId,
            remote: true,
            codec: params.codecs[i],
          })
        );
        if (encode.rtx) {
          this.registerRtpReceiver(transceiver.receiver, encode.rtx.ssrc);
        }
      });

    params.headerExtensions.forEach((extension) => {
      this.extIdUriMap[extension.id] = extension.uri;
    });
  }

  registerRtpReceiverByRid(
    transceiver: RTCRtpTransceiver,
    param: RTCRtpSimulcastParameters,
    params: RTCRtpReceiveParameters
  ) {
    // サイマルキャスト利用時のRTXをサポートしていないのでcodecs/encodingsは常に一つ
    const [codec] = params.codecs;

    log("registerRtpReceiverByRid", param);
    transceiver.addTrack(
      new MediaStreamTrack({
        rid: param.rid,
        kind: transceiver.kind,
        id: transceiver.sender.trackId,
        remote: true,
        codec,
      })
    );
    this.ridTable[param.rid] = transceiver.receiver;
  }

  static rtpHeaderExtensionsParser(
    extensions: Extension[],
    extIdUriMap: { [id: number]: string }
  ): Extensions {
    return extensions
      .map((extension) => {
        const uri = extIdUriMap[extension.id];
        switch (uri) {
          case RTP_EXTENSION_URI.sdesMid:
          case RTP_EXTENSION_URI.sdesRTPStreamID:
          case RTP_EXTENSION_URI.repairedRtpStreamId:
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
  }

  routeRtp = (packet: RtpPacket) => {
    const extensions = RtpRouter.rtpHeaderExtensionsParser(
      packet.header.extensions,
      this.extIdUriMap
    );

    let ssrcReceiver: RTCRtpReceiver | undefined = this.ssrcTable[
      packet.header.ssrc
    ] as RTCRtpReceiver;

    const rid = extensions[RTP_EXTENSION_URI.sdesRTPStreamID];
    if (typeof rid === "string") {
      ssrcReceiver = this.ridTable[rid] as RTCRtpReceiver;
      ssrcReceiver.latestRid = rid;
      ssrcReceiver.handleRtpByRid(packet, rid, extensions);
    } else if (ssrcReceiver) {
      ssrcReceiver.handleRtpBySsrc(packet, extensions);
    } else {
      // simulcast after send receiver report
      ssrcReceiver = Object.values(this.ridTable)
        .filter((r): r is RTCRtpReceiver => r instanceof RTCRtpReceiver)
        .find((r) => r.trackBySSRC[packet.header.ssrc]);
      if (ssrcReceiver) {
        log("simulcast register receiver by ssrc", packet.header.ssrc);
        this.registerRtpReceiver(ssrcReceiver, packet.header.ssrc);
        ssrcReceiver.handleRtpBySsrc(packet, extensions);
      }
    }

    if (!ssrcReceiver) {
      log("ssrcReceiver not found");
      return;
    }

    const sdesMid = extensions[RTP_EXTENSION_URI.sdesMid];
    if (typeof sdesMid === "string") {
      ssrcReceiver.sdesMid = sdesMid;
    }

    const repairedRid = extensions[
      RTP_EXTENSION_URI.repairedRtpStreamId
    ] as string;
    if (typeof repairedRid === "string") {
      ssrcReceiver.latestRepairedRid = repairedRid;
    }
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
          // log("sdes", JSON.stringify(sdes.chunks));
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
