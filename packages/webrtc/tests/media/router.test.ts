import {
  MediaStreamTrack,
  RTCRtpTransceiver,
  RtpHeader,
  RtpPacket,
  defaultPeerConfig,
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

  test("routeRtp は未知 SSRC でも MID で receiver を特定する", () =>
    new Promise<void>((done) => {
      const router = new RtpRouter();
      const dtls = createDtlsTransport();
      const transceiver = new RTCRtpTransceiver(
        "video",
        dtls,
        new RTCRtpReceiver(defaultPeerConfig, "video", 0),
        new RTCRtpSender("video"),
        "recvonly",
      );
      transceiver.mid = "3";

      router.registerRtpReceiverBySsrc(transceiver, {
        encodings: [],
        codecs: [
          new RTCRtpCodecParameters({
            clockRate: 90000,
            mimeType: "video/VP8",
            payloadType: 96,
          }),
        ],
        headerExtensions: [
          { id: 1, uri: "urn:ietf:params:rtp-hdrext:sdes:mid" },
        ],
      });

      transceiver.receiver.prepareReceive({
        encodings: [],
        codecs: [
          new RTCRtpCodecParameters({
            clockRate: 90000,
            mimeType: "video/VP8",
            payloadType: 96,
          }),
        ],
        headerExtensions: [],
      });

      const track = transceiver.receiver.track;
      track.onReceiveRtp.once((rtp) => {
        expect(rtp.payload.toString()).toBe("mid-routed");
        done();
      });

      router.routeRtp(
        new RtpPacket(
          new RtpHeader({
            ssrc: 999,
            payloadType: 96,
            extensions: [{ id: 1, payload: Buffer.from("3") }],
          }),
          Buffer.from("mid-routed"),
        ),
      );
    }));
});
