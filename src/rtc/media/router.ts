import { RTCRtpReceiver } from "./rtpReceiver";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";
import { RtcpPacket } from "../../vendor/rtp/rtcp/rtcp";
import { RTCRtpReceiveParameters } from "./parameters";

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
      // todo rid
      const rid = extensions["urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id"];
      ssrcReceiver = this.ridTable[rid];
    }

    ssrcReceiver.sdesMid = extensions["urn:ietf:params:rtp-hdrext:sdes:mid"];

    ssrcReceiver.handleRtpPacket(packet);
  };

  routeRtcp = (packets: RtcpPacket[]) => {
    // todo impl
  };
}
