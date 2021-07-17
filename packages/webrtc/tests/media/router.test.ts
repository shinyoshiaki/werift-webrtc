import {
  MediaStreamTrack,
  RTCRtpTransceiver,
  RtpHeader,
  RtpPacket,
} from "../../src";
import {
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
} from "../../src/media/parameters";
import { RtpRouter } from "../../src/media/router";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { RTCRtpSender } from "../../src/media/rtpSender";
import { createDtlsTransport } from "../fixture";

describe("media/router", () => {
  test("routeRtp", (done) => {
    const router = new RtpRouter();
    const dtls = createDtlsTransport();
    const transceiver = new RTCRtpTransceiver(
      "audio",
      new RTCRtpReceiver("audio", dtls, 0),
      new RTCRtpSender("audio", dtls),
      "recvonly",
      dtls
    );
    const ssrc = 123;
    const track = new MediaStreamTrack({ kind: "audio", ssrc });
    transceiver.addTrack(track);

    router.registerRtpReceiverBySsrc(transceiver, {
      encodings: [new RTCRtpCodingParameters({ ssrc, payloadType: 0 })],
      codecs: [],
      headerExtensions: [],
    });

    transceiver.receiver.prepareReceive({
      encodings: [],
      codecs: [
        new RTCRtpCodecParameters({
          clockRate: 90000,
          mimeType: "Video/VP6",
          payloadType: 0,
        }),
      ],
      headerExtensions: [],
    });

    const packet = new RtpPacket(
      new RtpHeader({ ssrc, payloadType: 0 }),
      Buffer.from("hello")
    );
    track.onReceiveRtp.once((rtp) => {
      expect(rtp.payload.toString()).toBe("hello");
      done();
    });
    router.routeRtp(packet);
  });
});
