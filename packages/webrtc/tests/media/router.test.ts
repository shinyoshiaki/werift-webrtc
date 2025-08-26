import {
  MediaStreamTrack,
  RTCRtpTransceiver,
  RtpHeader,
  RtpPacket,
  defaultPeerConfig,
} from "../../src/index.js";
import {
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
} from "../../src/media/parameters.js";
import { RtpRouter } from "../../src/media/router.js";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver.js";
import { RTCRtpSender } from "../../src/media/rtpSender.js";
import { createDtlsTransport } from "../fixture.js";

describe("media/router", () => {
  test("routeRtp", () =>
    new Promise<void>((done) => {
      const router = new RtpRouter();
      const dtls = createDtlsTransport();
      const transceiver = new RTCRtpTransceiver(
        "audio",
        dtls,
        new RTCRtpReceiver(defaultPeerConfig, "audio", 0),
        new RTCRtpSender("audio"),
        "recvonly",
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
        Buffer.from("hello"),
      );
      track.onReceiveRtp.once((rtp) => {
        expect(rtp.payload.toString()).toBe("hello");
        done();
      });
      router.routeRtp(packet);
    }));
});
