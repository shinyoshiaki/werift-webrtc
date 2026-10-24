import { vi } from "vitest";
import {
  MediaStreamTrack,
  RTCRtpTransceiver,
  ReceiverEstimatedMaxBitrate,
  RtcpHeader,
  RtcpPayloadSpecificFeedback,
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
import {
  createDtlsTransport,
  createFirPacket,
  createPliPacket,
  createRtcpFeedbackRouter,
  createSingleVideoSenderRouter,
  outboundRtpStats,
} from "../fixture";

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

  describe("routeRtcp payload-specific feedback", () => {
    test("PLI is routed by media SSRC even when sender SSRC matches another stream", () => {
      // Arrange
      const { router, senderA, senderB, remoteSsrc, rtcpSpies } =
        createRtcpFeedbackRouter();
      const pliOfB = vi.fn();
      senderB.onPictureLossIndication.subscribe(pliOfB);

      // Act: sender SSRC が自分の sender A / 受信 stream に一致する PLI を B 宛に送る
      router.routeRtcp(
        createPliPacket({ senderSsrc: senderA.ssrc, mediaSsrc: senderB.ssrc }),
      );
      router.routeRtcp(
        createPliPacket({ senderSsrc: remoteSsrc, mediaSsrc: senderB.ssrc }),
      );

      // Assert: media SSRC の sender B にだけ届き、PLI として処理される
      expect(rtcpSpies.senderB).toHaveBeenCalledTimes(2);
      expect(pliOfB).toHaveBeenCalledTimes(2);
      expect(rtcpSpies.senderA).not.toHaveBeenCalled();
      expect(rtcpSpies.senderC).not.toHaveBeenCalled();
      expect(rtcpSpies.receiver).not.toHaveBeenCalled();
    });

    test("PLI with an unknown media SSRC is not routed when several video senders exist", () => {
      // Arrange
      const { router, senderA, rtcpSpies } = createRtcpFeedbackRouter();

      // Act: sender SSRC は登録済みだが media SSRC は未登録の PLI を配送する
      router.routeRtcp(
        createPliPacket({ senderSsrc: senderA.ssrc, mediaSsrc: 0x12345678 }),
      );

      // Assert: sender SSRC へフォールバックせず、video sender が複数あるので対象も決められず誰にも配送されない
      Object.values(rtcpSpies).forEach((spy) =>
        expect(spy).not.toHaveBeenCalled(),
      );
    });

    test("compatible: PLI for the RTX SSRC reaches the sender of the primary stream", () => {
      // Arrange
      const { router, senderA, senderB, remoteSsrc, rtcpSpies } =
        createRtcpFeedbackRouter();
      const pliOfB = vi.fn();
      senderB.onPictureLossIndication.subscribe(pliOfB);

      // Act: B の RTX SSRC を media SSRC にした PLI を配送する
      router.routeRtcp(
        createPliPacket({ senderSsrc: remoteSsrc, mediaSsrc: senderB.rtxSsrc }),
      );

      // Assert: RTX SSRC の持ち主 B に PLI として届き、他の stream には届かない
      expect(pliOfB).toHaveBeenCalledTimes(1);
      expect(rtcpSpies.senderA).not.toHaveBeenCalled();
      expect(rtcpSpies.senderC).not.toHaveBeenCalled();
      expect(rtcpSpies.receiver).not.toHaveBeenCalled();
    });

    test("compatible: PLI with an unknown media SSRC reaches the only video sender", () => {
      // Arrange
      const { router, video, remoteSsrc, rtcpSpies } =
        createSingleVideoSenderRouter();
      const pli = vi.fn();
      video.onPictureLossIndication.subscribe(pli);

      // Act: media SSRC が 0 / 未登録 (古い SSRC 相当) の PLI を、sender SSRC = 受信 stream で配送する
      router.routeRtcp(
        createPliPacket({ senderSsrc: remoteSsrc, mediaSsrc: 0 }),
      );
      router.routeRtcp(
        createPliPacket({ senderSsrc: remoteSsrc, mediaSsrc: 0x12345678 }),
      );

      // Assert: 唯一の video sender に届き、audio sender と sender SSRC の receiver には届かない
      expect(pli).toHaveBeenCalledTimes(2);
      expect(rtcpSpies.audio).not.toHaveBeenCalled();
      expect(rtcpSpies.receiver).not.toHaveBeenCalled();
    });

    test("strict: PLI is routed only by a registered media SSRC", () => {
      // Arrange
      const { router, video, remoteSsrc, rtcpSpies } =
        createSingleVideoSenderRouter("strict");

      // Act: media SSRC が 0 / RTX SSRC / 自分の SSRC の PLI を順に配送する
      router.routeRtcp(
        createPliPacket({ senderSsrc: remoteSsrc, mediaSsrc: 0 }),
      );
      router.routeRtcp(
        createPliPacket({ senderSsrc: remoteSsrc, mediaSsrc: video.rtxSsrc }),
      );
      router.routeRtcp(
        createPliPacket({ senderSsrc: remoteSsrc, mediaSsrc: video.ssrc }),
      );

      // Assert: 登録済みの media SSRC 宛の 1 件だけが video sender に届く
      expect(rtcpSpies.video).toHaveBeenCalledTimes(1);
      expect(rtcpSpies.audio).not.toHaveBeenCalled();
      expect(rtcpSpies.receiver).not.toHaveBeenCalled();
    });

    test("FIR with media SSRC 0 is routed by its FCI SSRC", () => {
      // Arrange
      const { router, senderA, senderB, rtcpSpies } =
        createRtcpFeedbackRouter();

      // Act: libwebrtc 形式 (media SSRC = 0) の FIR を B 宛に送る
      router.routeRtcp(
        createFirPacket({
          senderSsrc: senderA.ssrc,
          fir: [{ ssrc: senderB.ssrc, sequenceNumber: 1 }],
        }),
      );

      // Assert: FCI の SSRC の sender B にだけ届く
      expect(rtcpSpies.senderB).toHaveBeenCalledTimes(1);
      expect(rtcpSpies.senderA).not.toHaveBeenCalled();
      expect(rtcpSpies.senderC).not.toHaveBeenCalled();
      expect(rtcpSpies.receiver).not.toHaveBeenCalled();
    });

    test("FIR with multiple and duplicated entries reaches each target once", () => {
      // Arrange
      const { router, senderA, senderB, senderC, rtcpSpies } =
        createRtcpFeedbackRouter();

      // Act: B, C, B (重複) と未登録 SSRC を含む FIR を配送する
      router.routeRtcp(
        createFirPacket({
          senderSsrc: senderA.ssrc,
          fir: [
            { ssrc: senderB.ssrc, sequenceNumber: 1 },
            { ssrc: senderC.ssrc, sequenceNumber: 1 },
            { ssrc: senderB.ssrc, sequenceNumber: 1 },
            { ssrc: 0x12345678, sequenceNumber: 1 },
          ],
        }),
      );

      // Assert: B と C に 1 回ずつ届き、sender SSRC の A には届かない
      expect(rtcpSpies.senderB).toHaveBeenCalledTimes(1);
      expect(rtcpSpies.senderC).toHaveBeenCalledTimes(1);
      expect(rtcpSpies.senderA).not.toHaveBeenCalled();
      expect(rtcpSpies.receiver).not.toHaveBeenCalled();
    });

    test("compatible: FIR entries for the RTX SSRC or an unknown SSRC count on the resolved sender", async () => {
      // Arrange
      const { router, video, remoteSsrc } = createSingleVideoSenderRouter();
      const onFir = vi.fn();
      video.onFullIntraRequest.subscribe(onFir);

      // Act: RTX SSRC 宛と未登録 SSRC 宛のエントリを持つ FIR を 1 つ配送する
      router.routeRtcp(
        createFirPacket({
          senderSsrc: remoteSsrc,
          fir: [
            { ssrc: video.rtxSsrc, sequenceNumber: 1 },
            { ssrc: 0x12345678, sequenceNumber: 1 },
          ],
        }),
      );

      // Assert: 両エントリが video sender に解決され、1 回だけ通知されて firCount に 2 件数えられる
      expect(onFir).toHaveBeenCalledTimes(1);
      expect((await outboundRtpStats(video)).firCount).toBe(2);
    });

    test("strict: FIR entries for an unregistered SSRC are not routed", async () => {
      // Arrange
      const { router, video, remoteSsrc, rtcpSpies } =
        createSingleVideoSenderRouter("strict");

      // Act: RTX SSRC 宛と未登録 SSRC 宛のエントリだけを持つ FIR を配送する
      router.routeRtcp(
        createFirPacket({
          senderSsrc: remoteSsrc,
          fir: [
            { ssrc: video.rtxSsrc, sequenceNumber: 1 },
            { ssrc: 0x12345678, sequenceNumber: 1 },
          ],
        }),
      );

      // Assert: どの endpoint にも配送されず、firCount も増えない
      Object.values(rtcpSpies).forEach((spy) =>
        expect(spy).not.toHaveBeenCalled(),
      );
      expect((await outboundRtpStats(video)).firCount).toBeUndefined();
    });

    test("FIR without entries falls back to a non-zero media SSRC only", () => {
      // Arrange
      const { router, senderA, senderB, rtcpSpies } =
        createRtcpFeedbackRouter();

      // Act: FCI が空の FIR を media SSRC = 0 / B でそれぞれ配送する
      router.routeRtcp(createFirPacket({ senderSsrc: senderA.ssrc, fir: [] }));
      router.routeRtcp(
        createFirPacket({
          senderSsrc: senderA.ssrc,
          mediaSsrc: senderB.ssrc,
          fir: [],
        }),
      );

      // Assert: media SSRC が 0 のものは配送されず、B 宛のものだけ B に届く
      expect(rtcpSpies.senderB).toHaveBeenCalledTimes(1);
      expect(rtcpSpies.senderA).not.toHaveBeenCalled();
    });

    test("REMB is still routed by its first SSRC feedback", () => {
      // Arrange
      const { router, senderA, senderB, rtcpSpies } =
        createRtcpFeedbackRouter();

      // Act: B を対象とする REMB を配送する
      router.routeRtcp(
        new RtcpPayloadSpecificFeedback({
          feedback: new ReceiverEstimatedMaxBitrate({
            senderSsrc: senderA.ssrc,
            mediaSsrc: 0,
            ssrcNum: 1,
            ssrcFeedbacks: [senderB.ssrc],
            bitrate: 300000n,
          }),
        }),
      );

      // Assert: 従来どおり ssrcFeedbacks[0] の B に届き、推定値が反映される
      expect(rtcpSpies.senderB).toHaveBeenCalledTimes(1);
      expect(rtcpSpies.senderA).not.toHaveBeenCalled();
      expect(senderB.receiverEstimatedMaxBitrate).toBe(300000n);
    });

    test("PSFB with an unknown FMT is not routed and does not throw", () => {
      // Arrange
      const { router, senderB, rtcpSpies } = createRtcpFeedbackRouter();
      const payload = Buffer.alloc(8);
      payload.writeUInt32BE(senderB.ssrc, 4);
      // FMT=2 (SLI) は parse されず feedback が undefined になる
      const sli = RtcpPayloadSpecificFeedback.deSerialize(
        payload,
        new RtcpHeader({ type: RtcpPayloadSpecificFeedback.type, count: 2 }),
      );

      // Act / Assert: 例外を投げず、誰にも配送されない
      expect(sli.feedback).toBeUndefined();
      expect(() => router.routeRtcp(sli)).not.toThrow();
      Object.values(rtcpSpies).forEach((spy) =>
        expect(spy).not.toHaveBeenCalled(),
      );
    });
  });
});
