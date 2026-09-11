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

  test("unbundled RTP sessionは同じSSRCを別transportへルーティングする", () =>
    new Promise<void>((done) => {
      const router = new RtpRouter();
      const dtlsA = createDtlsTransport();
      const dtlsB = createDtlsTransport();
      const receiverA = new RTCRtpReceiver(defaultPeerConfig, "audio", 0);
      const receiverB = new RTCRtpReceiver(defaultPeerConfig, "video", 1);
      const transceiverA = new RTCRtpTransceiver(
        "audio",
        dtlsA,
        receiverA,
        new RTCRtpSender("audio"),
        "recvonly",
      );
      const transceiverB = new RTCRtpTransceiver(
        "video",
        dtlsB,
        receiverB,
        new RTCRtpSender("video"),
        "recvonly",
      );
      const ssrc = 1234;
      transceiverA.addTrack(new MediaStreamTrack({ kind: "audio", ssrc }));
      transceiverB.addTrack(new MediaStreamTrack({ kind: "video", ssrc }));
      const params = {
        encodings: [new RTCRtpCodingParameters({ ssrc, payloadType: 0 })],
        codecs: [],
        headerExtensions: [],
      };
      router.registerRtpReceiverBySsrc(transceiverA, params);
      router.registerRtpReceiverBySsrc(transceiverB, params);
      const receiveParams = {
        encodings: [],
        codecs: [
          new RTCRtpCodecParameters({
            clockRate: 90000,
            mimeType: "Video/VP6",
            payloadType: 0,
          }),
        ],
        headerExtensions: [],
      };
      receiverA.prepareReceive(receiveParams);
      receiverB.prepareReceive(receiveParams);

      let receivedA = false;
      receiverA.track.onReceiveRtp.once(() => {
        receivedA = true;
      });
      receiverB.track.onReceiveRtp.once((rtp) => {
        expect(receivedA).toBe(false);
        expect(rtp.payload.toString()).toBe("session-b");
        done();
      });

      router.routeRtp(
        new RtpPacket(
          new RtpHeader({ ssrc, payloadType: 0 }),
          Buffer.from("session-b"),
        ),
        dtlsB.id,
      );
    }));
});
