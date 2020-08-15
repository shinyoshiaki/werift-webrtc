import { RTCRtpReceiver } from "./rtpReceiver";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";
import { RtcpPacket } from "../../vendor/rtp/rtcp/rtcp";
import { RTCRtpReceiveParameters } from "./parameters";
import { RtpTrack } from "./track";

export class RtpRouter {
  ssrcTable: { [ssrc: number]: RTCRtpReceiver } = {};
  ridTable: { [rid: string]: RTCRtpReceiver } = {};
  extIdUriMap: { [id: number]: string } = {};

  registerRtpReceiver(
    receiver: RTCRtpReceiver,
    params: RTCRtpReceiveParameters
  ) {
    const ssrcs = params.encodings
      .map((encode) => encode.ssrc)
      .filter((v) => v);
    ssrcs.forEach((ssrc) => {
      this.ssrcTable[ssrc] = receiver;
      receiver.addTrack(new RtpTrack({ ssrc }));
    });

    params.headerExtensions.forEach((extension) => {
      this.extIdUriMap[extension.id] = extension.uri;
    });
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

  routeRtcp = (packets: RtcpPacket[]) => {
    // todo impl
  };
}
