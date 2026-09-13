import {
  MediaStreamTrack,
  RTCRtpTransceiver,
  RTP_EXTENSION_URI,
  RtcpReceiverInfo,
  RtcpRrPacket,
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

  test("未知のtransportIdのRTCPはglobal tableへfallbackしない", () => {
    // Arrange: 2 session に同じ SSRC の sender を置き、誤配送しやすい状態にする。
    const router = new RtpRouter();
    const dtlsA = createDtlsTransport();
    const dtlsB = createDtlsTransport();
    const senderA = new RTCRtpSender("audio");
    const senderB = new RTCRtpSender("video");
    senderA.setDtlsTransport(dtlsA);
    senderB.setDtlsTransport(dtlsB);
    router.registerRtpSender(senderA);
    router.registerRtpSender(senderB);
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    senderA.onRtcp.subscribe((packet) => receivedA.push(packet));
    senderB.onRtcp.subscribe((packet) => receivedB.push(packet));
    const packet = new RtcpRrPacket({
      ssrc: 1,
      reports: [
        new RtcpReceiverInfo({
          ssrc: senderA.ssrc,
          fractionLost: 0,
          packetsLost: 0,
          highestSequence: 1,
          jitter: 0,
          lsr: 0,
          dlsr: 0,
        }),
      ],
    });

    // Act: 存在しない transport と、正しい session へ同じ RR を流す。
    router.routeRtcp(packet, "missing-transport");
    router.routeRtcp(packet, dtlsA.id);

    // Assert: 未知 id では drop し、指定 session だけが受信する。
    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);
  });

  test("同じtarget sessionへ同時に載るpending extmap衝突を検出する", () => {
    // Arrange: live map には id=3 がまだない。
    const router = new RtpRouter();
    const sessionId = "bundle-t0";

    // Act / Assert: pending 同士の id 衝突と同一URIの別IDを reject する。
    expect(() =>
      router.assertPendingExtmapsForSession(sessionId, [
        [{ id: 3, uri: RTP_EXTENSION_URI.sdesMid }],
        [{ id: 3, uri: RTP_EXTENSION_URI.transportWideCC }],
      ]),
    ).toThrow(/extmap id 3 remapped/);
    expect(() =>
      router.assertPendingExtmapsForSession(sessionId, [
        [{ id: 1, uri: RTP_EXTENSION_URI.sdesMid }],
        [{ id: 2, uri: RTP_EXTENSION_URI.sdesMid }],
      ]),
    ).toThrow(/extmap uri .* remapped from id 1 to 2/);
  });
});
