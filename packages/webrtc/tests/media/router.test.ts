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
  type RTCRtpHeaderExtensionParameters,
} from "../../src/media/parameters";
import { RtpRouter } from "../../src/media/router";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { RTCRtpSender } from "../../src/media/rtpSender";
import { createDtlsTransport } from "../fixture";

function arrangeMidRoutedReceiver(
  headerExtensions: RTCRtpHeaderExtensionParameters[] = [
    { id: 1, uri: "urn:ietf:params:rtp-hdrext:sdes:mid" },
  ],
) {
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

  const codecs = [
    new RTCRtpCodecParameters({
      clockRate: 90000,
      mimeType: "video/VP8",
      payloadType: 96,
    }),
  ];
  router.registerRtpReceiverBySsrc(transceiver, {
    encodings: [],
    codecs,
    headerExtensions,
  });
  transceiver.receiver.prepareReceive({
    encodings: [],
    codecs,
    headerExtensions: [],
  });

  return { router, track: transceiver.receiver.track };
}

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
      const { router, track } = arrangeMidRoutedReceiver();

      track.onReceiveRtp.once((rtp) => {
        // Assert: SDP に SSRC が無くても MID で配送できる。
        expect(rtp.payload.toString()).toBe("mid-routed");
        done();
      });

      // Act: 未知 SSRC の RTP を MID 拡張付きで流す。
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

  test("routeRtp は未知 RID でも MID にフォールバックする", () =>
    new Promise<void>((done) => {
      const { router, track } = arrangeMidRoutedReceiver([
        { id: 1, uri: "urn:ietf:params:rtp-hdrext:sdes:mid" },
        { id: 2, uri: "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id" },
      ]);

      track.onReceiveRtp.once((rtp) => {
        // Assert: ridTable に無い RID で throw / drop せず MID 配送する。
        expect(rtp.payload.toString()).toBe("rid-fallback");
        done();
      });

      // Act: Chrome が非サイマルキャストでも RID 拡張を載せる場合を模す。
      router.routeRtp(
        new RtpPacket(
          new RtpHeader({
            ssrc: 999,
            payloadType: 96,
            extensions: [
              { id: 1, payload: Buffer.from("3") },
              { id: 2, payload: Buffer.from("0") },
            ],
          }),
          Buffer.from("rid-fallback"),
        ),
      );
    }));

  test("routeRtp は NUL パディング付き MID でも receiver を特定する", () =>
    new Promise<void>((done) => {
      const { router, track } = arrangeMidRoutedReceiver();

      track.onReceiveRtp.once((rtp) => {
        // Assert: パディング付き MID でも midTable に当たる。
        expect(rtp.payload.toString()).toBe("padded-mid");
        done();
      });

      // Act: one-byte header extension の 32bit 境界パディングを模す。
      router.routeRtp(
        new RtpPacket(
          new RtpHeader({
            ssrc: 999,
            payloadType: 96,
            extensions: [{ id: 1, payload: Buffer.from("3\0") }],
          }),
          Buffer.from("padded-mid"),
        ),
      );
    }));
});
