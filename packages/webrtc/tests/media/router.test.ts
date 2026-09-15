import { describe, expect, test, vi } from "vitest";
import {
  GenericNack,
  MediaStreamTrack,
  RTCRtpTransceiver,
  RtcpTransportLayerFeedback,
  RtpHeader,
  RtpPacket,
  TransportWideCC,
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

  test("TWCC RTCP は同一 DTLS の全 sender に fan-out する", () => {
    // Arrange: BUNDLE 上の audio/video sender
    const dtls = createDtlsTransport();
    const audio = new RTCRtpSender("audio");
    const video = new RTCRtpSender("video");
    audio.setDtlsTransport(dtls);
    video.setDtlsTransport(dtls);
    const router = new RtpRouter();
    router.registerRtpSender(audio);
    router.registerRtpSender(video);
    const audioTwcc: unknown[] = [];
    const videoTwcc: unknown[] = [];
    audio.senderBWE.receiveTWCC = ((fb: unknown) => {
      audioTwcc.push(fb);
    }) as typeof audio.senderBWE.receiveTWCC;
    video.senderBWE.receiveTWCC = ((fb: unknown) => {
      videoTwcc.push(fb);
    }) as typeof video.senderBWE.receiveTWCC;

    // Act: media_ssrc は video だけでも TSN 全体を両 estimator へ
    const feedback = new TransportWideCC({
      senderSsrc: 1,
      mediaSourceSsrc: video.ssrc,
      baseSequenceNumber: 100,
      packetStatusCount: 0,
      referenceTime: 0,
      fbPktCount: 0,
      recvDeltas: [],
      packetChunks: [],
    });
    router.routeRtcp(new RtcpTransportLayerFeedback({ feedback }), dtls);

    // Assert
    expect(audioTwcc).toHaveLength(1);
    expect(videoTwcc).toHaveLength(1);
    expect(audioTwcc[0]).toBe(feedback);
    expect(videoTwcc[0]).toBe(feedback);
  });

  test("TWCC fan-out は別 DTLS transport の sender に届かない", () => {
    // Arrange
    const dtlsA = createDtlsTransport();
    const dtlsB = createDtlsTransport();
    const senderA = new RTCRtpSender("audio");
    const senderB = new RTCRtpSender("video");
    senderA.setDtlsTransport(dtlsA);
    senderB.setDtlsTransport(dtlsB);
    const router = new RtpRouter();
    router.registerRtpSender(senderA);
    router.registerRtpSender(senderB);
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    senderA.senderBWE.receiveTWCC = ((fb: unknown) => {
      seenA.push(fb);
    }) as typeof senderA.senderBWE.receiveTWCC;
    senderB.senderBWE.receiveTWCC = ((fb: unknown) => {
      seenB.push(fb);
    }) as typeof senderB.senderBWE.receiveTWCC;

    // Act
    router.routeRtcp(
      new RtcpTransportLayerFeedback({
        feedback: new TransportWideCC({
          senderSsrc: 1,
          mediaSourceSsrc: senderA.ssrc,
          baseSequenceNumber: 1,
          packetStatusCount: 0,
          referenceTime: 0,
          fbPktCount: 0,
          recvDeltas: [],
          packetChunks: [],
        }),
      }),
      dtlsA,
    );

    // Assert
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(0);
  });

  test("NACK は mediaSourceSsrc の sender だけに届く", () => {
    // Arrange
    const dtls = createDtlsTransport();
    const audio = new RTCRtpSender("audio");
    const video = new RTCRtpSender("video");
    audio.setDtlsTransport(dtls);
    video.setDtlsTransport(dtls);
    const router = new RtpRouter();
    router.registerRtpSender(audio);
    router.registerRtpSender(video);
    const audioNack = vi.fn();
    const videoNack = vi.fn();
    audio.onGenericNack.subscribe(audioNack);
    video.onGenericNack.subscribe(videoNack);

    // Act
    router.routeRtcp(
      new RtcpTransportLayerFeedback({
        feedback: new GenericNack({
          senderSsrc: 1,
          mediaSourceSsrc: video.ssrc,
          lost: [10],
        }),
      }),
      dtls,
    );

    // Assert: NACK は SSRC 単位のまま
    expect(videoNack).toHaveBeenCalledTimes(1);
    expect(audioNack).not.toHaveBeenCalled();
  });
});
