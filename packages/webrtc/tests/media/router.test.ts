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

  test("SDP registration clears the learned mark of an SSRC", () => {
    // Arrange: packet から学習した扱いの SSRC を router と receiver に置く。
    const router = new RtpRouter();
    const transceiver = new RTCRtpTransceiver(
      "video",
      createDtlsTransport(),
      new RTCRtpReceiver(defaultPeerConfig, "video", 0),
      new RTCRtpSender("video"),
      "recvonly",
    );
    const ssrc = 1111;
    router.learnedSsrcs.add(ssrc);
    transceiver.receiver.learnedTrackSsrcs.add(ssrc);

    // Act: description が同じ SSRC を登録する。
    router.registerRtpReceiverBySsrc(transceiver, {
      encodings: [new RTCRtpCodingParameters({ ssrc, payloadType: 96 })],
      codecs: [],
      headerExtensions: [],
    });

    // Assert: route と track 対応は description 由来になり、学習済みの印が外れる。
    expect(router.ssrcTable[ssrc]).toBe(transceiver.receiver);
    expect(transceiver.receiver.trackBySSRC[ssrc]?.ssrc).toBe(ssrc);
    expect(router.learnedSsrcs.has(ssrc)).toBe(false);
    expect(transceiver.receiver.learnedTrackSsrcs.has(ssrc)).toBe(false);
  });
});
