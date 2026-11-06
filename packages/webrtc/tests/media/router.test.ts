import { vi } from "vitest";
import {
  defaultPeerConfig,
  GenericNack,
  MediaStreamTrack,
  ReceiverEstimatedMaxBitrate,
  RTCRtpTransceiver,
  RtcpHeader,
  RtcpPacketConverter,
  RtcpPayloadSpecificFeedback,
  RtcpTransportLayerFeedback,
  RtpHeader,
  RtpPacket,
  TransportWideCC,
} from "../../src";
import {
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
} from "../../src/media/parameters";
import { RtpRouter } from "../../src/media/router";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { RTCRtpSender } from "../../src/media/rtpSender";
import type { RTCDtlsTransport } from "../../src/transport/dtls";
import {
  createCompoundFeedbackBytes,
  createDtlsTransport,
  createFirPacket,
  createPliPacket,
  createRtcpFeedbackRouter,
  createSingleVideoSenderRouter,
  outboundRtpStats,
} from "../fixture";
import {
  collectDeliveredRtp,
  createSimulcastMediaPacket,
  createSimulcastRtxPacket,
  createSimulcastRtxReceiver,
} from "./rtpReceiverTestUtils";

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

  test("最後の sender が別 transport に移ったあと、旧 transport に届いた TWCC はその sender に渡さない", () => {
    // Arrange: transport A の唯一の sender を transport B に移す
    const dtlsA = createDtlsTransport();
    const dtlsB = createDtlsTransport();
    const sender = new RTCRtpSender("video");
    sender.setDtlsTransport(dtlsA);
    const router = new RtpRouter();
    router.registerRtpSender(sender);
    sender.setDtlsTransport(dtlsB);
    const seen: RTCDtlsTransport[] = [];
    let via: RTCDtlsTransport = dtlsA;
    sender.senderBWE.receiveTWCC = (() => {
      seen.push(via);
    }) as typeof sender.senderBWE.receiveTWCC;
    const twcc = () =>
      new RtcpTransportLayerFeedback({
        feedback: new TransportWideCC({
          senderSsrc: 1,
          mediaSourceSsrc: sender.ssrc,
          baseSequenceNumber: 1,
          packetStatusCount: 0,
          referenceTime: 0,
          fbPktCount: 0,
          recvDeltas: [],
          packetChunks: [],
        }),
      });

    // Act: 旧 transport A 経由で遅れた TWCC、続いて B 経由の TWCC が届く
    router.routeRtcp(twcc(), dtlsA);
    via = dtlsB;
    router.routeRtcp(twcc(), dtlsB);

    // Assert: SSRC で別 transport の sender に fallback せず、B 経由の TWCC だけが届く
    expect(seen).toEqual([dtlsB]);
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

      // Assert: 両エントリが video sender に解決され、1 回だけ通知されて firCount は 1 パケット分の 1
      expect(onFir).toHaveBeenCalledTimes(1);
      expect((await outboundRtpStats(video)).firCount).toBe(1);
    });

    test("compatible: a retransmitted FIR with entries resolved to one sender does not notify again", async () => {
      // Arrange
      const { router, video, remoteSsrc } = createSingleVideoSenderRouter();
      const onRequest = vi.fn();
      video.onKeyFrameRequest.subscribe(onRequest);
      const fir = createFirPacket({
        senderSsrc: remoteSsrc,
        fir: [
          { ssrc: video.ssrc, sequenceNumber: 3 },
          { ssrc: video.rtxSsrc, sequenceNumber: 8 },
        ],
      });

      // Act: primary / RTX 宛のエントリを持つ FIR を、シリアライズした実バイト列から復号して配送する
      const routeWire = () =>
        RtcpPacketConverter.deSerialize(fir.serialize()).forEach((packet) =>
          router.routeRtcp(packet),
        );
      routeWire();

      // Assert: 両エントリとも同じ sender に解決され、初回は通知 1 回・firCount 1
      expect(onRequest.mock.calls).toEqual([["fir"]]);
      expect((await outboundRtpStats(video)).firCount).toBe(1);

      // Act: 同じ FIR を再送として配送する
      routeWire();

      // Assert: 再送なので通知は増えず、firCount はパケット数の 2
      expect(onRequest.mock.calls).toEqual([["fir"]]);
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

    test("decoded compound RTCP routes FIR and PLI to their own targets only", async () => {
      // Arrange: B は同じ送信元から FIR (Seq nr 7) を受信済み
      const { router, senderA, senderB, remoteSsrc } =
        createRtcpFeedbackRouter();
      const events = { a: [] as string[], b: [] as string[] };
      senderA.onKeyFrameRequest.subscribe((kind) => events.a.push(kind));
      senderB.onKeyFrameRequest.subscribe((kind) => events.b.push(kind));
      router.routeRtcp(
        createFirPacket({
          senderSsrc: remoteSsrc,
          fir: [{ ssrc: senderB.ssrc, sequenceNumber: 7 }],
        }),
      );
      events.b.length = 0;
      const compound = createCompoundFeedbackBytes({
        senderSsrc: remoteSsrc,
        fir: { ssrc: senderA.ssrc, sequenceNumber: 7 },
        pliMediaSsrc: senderB.ssrc,
      });
      const routeCompound = () =>
        RtcpPacketConverter.deSerialize(compound).forEach((packet) =>
          router.routeRtcp(packet),
        );

      // Act: RR + SDES + FIR(A 宛) + PLI(B 宛) の実バイト列を復号して配送する
      routeCompound();

      // Assert: A は FIR、B は PLI だけを受け、B の FIR は後続 PLI のバイトで増えない
      expect(events).toEqual({ a: ["fir"], b: ["pli"] });
      expect(await outboundRtpStats(senderA)).toMatchObject({ firCount: 1 });
      expect(await outboundRtpStats(senderB)).toMatchObject({
        firCount: 1,
        pliCount: 1,
      });

      // Act: 同じ複合パケットを再送として再び配送する
      routeCompound();

      // Assert: A の FIR は再送なので通知されず数だけ増え、B は PLI を再び受ける
      expect(events).toEqual({ a: ["fir"], b: ["pli", "pli"] });
      expect(await outboundRtpStats(senderA)).toMatchObject({ firCount: 2 });
      expect(await outboundRtpStats(senderB)).toMatchObject({
        firCount: 1,
        pliCount: 2,
      });
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

  describe("simulcast RTX (repaired-rtp-stream-id)", () => {
    const high = { rid: "high", ssrc: 1000, rtxSsrc: 1001 };
    const low = { rid: "low", ssrc: 2000, rtxSsrc: 2001 };

    test("RID の track の codec は先頭の RTX ではなく媒体 codec になる", () => {
      // Arrange / Act: RTX を先頭に並べた codec 列で RID receiver を登録する。
      const { receiver } = createSimulcastRtxReceiver();

      // Assert: どの RID の track も VP8 を codec に持つ。
      for (const rid of ["high", "low"]) {
        expect(receiver.trackByRID[rid].codec?.mimeType).toBe("video/VP8");
      }
    });

    test("rrid 付き RTX は該当 RID の track に元の SSRC / seq / PT で届く", () => {
      // Arrange
      const { router, receiver } = createSimulcastRtxReceiver();
      const highReceived = collectDeliveredRtp(receiver.trackByRID.high);
      const lowReceived = collectDeliveredRtp(receiver.trackByRID.low);
      const lost = createSimulcastMediaPacket({
        ssrc: high.ssrc,
        sequenceNumber: 11,
        rid: high.rid,
      });

      // Act: 両レイヤーの媒体を受けたあと、high の seq 11 を RTX で受ける。
      router.routeRtp(
        createSimulcastMediaPacket({
          ssrc: high.ssrc,
          sequenceNumber: 10,
          rid: high.rid,
        }),
      );
      router.routeRtp(
        createSimulcastMediaPacket({
          ssrc: low.ssrc,
          sequenceNumber: 500,
          rid: low.rid,
        }),
      );
      router.routeRtp(
        createSimulcastRtxPacket(lost, {
          rtxSsrc: high.rtxSsrc,
          rtxSequenceNumber: 7,
          rrid: high.rid,
        }),
      );

      // Assert: 復元パケットは high の track にだけ、媒体 SSRC / seq / PT で届く。
      expect(highReceived).toEqual([
        {
          ssrc: high.ssrc,
          seq: 10,
          payloadType: 96,
          payload: "media-10",
          type: "media",
        },
        {
          ssrc: high.ssrc,
          seq: 11,
          payloadType: 96,
          payload: "media-11",
          type: "retransmission",
        },
      ]);
      expect(lowReceived.map((p) => p.seq)).toEqual([500]);
      // Assert: 媒体 SSRC と RTX SSRC は学習済みの route として登録される。
      for (const ssrc of [high.ssrc, low.ssrc, high.rtxSsrc]) {
        expect(router.ssrcTable[ssrc]).toBe(receiver);
        expect(router.learnedSsrcs.has(ssrc)).toBe(true);
      }
    });

    test("rid / rrid 拡張が省略された後続パケットも SSRC で届き、RTX は復元される", () => {
      // Arrange: 最初の拡張付きパケットで媒体 SSRC と RTX SSRC を学習させる。
      const { router, receiver } = createSimulcastRtxReceiver();
      const lowReceived = collectDeliveredRtp(receiver.trackByRID.low);
      router.routeRtp(
        createSimulcastMediaPacket({
          ssrc: low.ssrc,
          sequenceNumber: 1,
          rid: low.rid,
        }),
      );
      router.routeRtp(
        createSimulcastRtxPacket(
          createSimulcastMediaPacket({ ssrc: low.ssrc, sequenceNumber: 0 }),
          { rtxSsrc: low.rtxSsrc, rtxSequenceNumber: 1, rrid: low.rid },
        ),
      );

      // Act: RR 受信後のブラウザのように rid / rrid を付けずに送る。
      router.routeRtp(
        createSimulcastMediaPacket({ ssrc: low.ssrc, sequenceNumber: 3 }),
      );
      router.routeRtp(
        createSimulcastRtxPacket(
          createSimulcastMediaPacket({ ssrc: low.ssrc, sequenceNumber: 2 }),
          { rtxSsrc: low.rtxSsrc, rtxSequenceNumber: 2 },
        ),
      );

      // Assert: 媒体も RTX も low の track に媒体 SSRC で届く。
      expect(
        lowReceived.map(({ ssrc, seq, type }) => ({ ssrc, seq, type })),
      ).toEqual([
        { ssrc: low.ssrc, seq: 1, type: "media" },
        { ssrc: low.ssrc, seq: 0, type: "retransmission" },
        { ssrc: low.ssrc, seq: 3, type: "media" },
        { ssrc: low.ssrc, seq: 2, type: "retransmission" },
      ]);
    });

    test("同じ RID の媒体 SSRC が切り替わっても、遅れて届いた旧 RTX は旧 SSRC で復元される", () => {
      // Arrange: 媒体 1000 と RTX 1001 を学習させる。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      const rtxOf = (sequenceNumber: number, rtxSequenceNumber: number) =>
        createSimulcastRtxPacket(
          createSimulcastMediaPacket({ ssrc: high.ssrc, sequenceNumber }),
          { rtxSsrc: high.rtxSsrc, rtxSequenceNumber, rrid: high.rid },
        );
      router.routeRtp(
        createSimulcastMediaPacket({
          ssrc: high.ssrc,
          sequenceNumber: 1,
          rid: high.rid,
        }),
      );
      router.routeRtp(rtxOf(0, 1));

      // Act: 同じ RID が新しい媒体 SSRC 5000 に切り替わったあと、旧 RTX が遅れて届く。
      router.routeRtp(
        createSimulcastMediaPacket({
          ssrc: 5000,
          sequenceNumber: 100,
          rid: high.rid,
        }),
      );
      router.routeRtp(rtxOf(2, 2));

      // Assert: 遅延 RTX は切り替え前の媒体 SSRC 1000 で復元される。
      const retransmissions = received.filter(
        (p) => p.type === "retransmission",
      );
      expect(retransmissions.map((p) => [p.ssrc, p.seq])).toEqual([
        [high.ssrc, 0],
        [high.ssrc, 2],
      ]);
    });

    test("媒体 SSRC 切り替え後に初めて届く RTX は、旧新どちらか判定できないため固定せず破棄する", () => {
      // Arrange: 媒体 1000 を学習し、RTX 1001 は未学習のまま RID が媒体 5000 に切り替わる。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      router.routeRtp(
        createSimulcastMediaPacket({
          ssrc: high.ssrc,
          sequenceNumber: 1,
          rid: high.rid,
        }),
      );
      router.routeRtp(
        createSimulcastMediaPacket({
          ssrc: 5000,
          sequenceNumber: 100,
          rid: high.rid,
        }),
      );

      // Act: 切り替え後に初めて RTX 1001 が届く。
      router.routeRtp(
        createSimulcastRtxPacket(
          createSimulcastMediaPacket({ ssrc: high.ssrc, sequenceNumber: 0 }),
          { rtxSsrc: high.rtxSsrc, rtxSequenceNumber: 1, rrid: high.rid },
        ),
      );

      // Assert: どちらの媒体 SSRC にも復元されず、対応も固定されない。
      expect(received.filter((p) => p.type === "retransmission")).toEqual([]);
      expect(receiver.pinnedMediaSsrcByRtx[high.rtxSsrc]).toBeUndefined();
    });

    test("同じ RID を使う複数 m-line でも、学習済み RTX SSRC は MID 省略後に元の受信先へ届く", () => {
      // Arrange: mid "1" を先に登録し、同じ RID を使う mid "0" の receiver に RTX を学習させる。
      const { router, receiver: other } = createSimulcastRtxReceiver({
        mid: "1",
      });
      const { receiver } = createSimulcastRtxReceiver({ mid: "0", router });
      const received = collectDeliveredRtp(receiver.trackByRID.low);
      const otherReceived = collectDeliveredRtp(other.trackByRID.low);
      router.routeRtp(
        createSimulcastMediaPacket({
          ssrc: low.ssrc,
          sequenceNumber: 1,
          rid: low.rid,
        }),
      );
      router.routeRtp(
        createSimulcastRtxPacket(
          createSimulcastMediaPacket({ ssrc: low.ssrc, sequenceNumber: 0 }),
          { rtxSsrc: low.rtxSsrc, rtxSequenceNumber: 1, rrid: low.rid },
        ),
      );

      // Act: MID を省略し rrid だけを付けた RTX が届く。
      router.routeRtp(
        createSimulcastRtxPacket(
          createSimulcastMediaPacket({ ssrc: low.ssrc, sequenceNumber: 2 }),
          { rtxSsrc: low.rtxSsrc, rtxSequenceNumber: 2, rrid: low.rid, mid: null },
        ),
      );

      // Assert: RTX は学習済みの mid "0" 側にだけ届く。
      expect(
        received.filter((p) => p.type === "retransmission").map((p) => p.seq),
      ).toEqual([0, 2]);
      expect(otherReceived).toEqual([]);
    });

    test("媒体 SSRC 未学習の RTX は破棄し、RID の学習後は同じ RTX SSRC を復元する", () => {
      // Arrange
      const { router, receiver } = createSimulcastRtxReceiver();
      const highReceived = collectDeliveredRtp(receiver.trackByRID.high);
      const rtxOf = (sequenceNumber: number, rtxSequenceNumber: number) =>
        createSimulcastRtxPacket(
          createSimulcastMediaPacket({ ssrc: high.ssrc, sequenceNumber }),
          { rtxSsrc: high.rtxSsrc, rtxSequenceNumber, rrid: high.rid },
        );

      // Act: 媒体より先に RTX が届く。
      expect(() => router.routeRtp(rtxOf(5, 1))).not.toThrow();

      // Assert: 媒体 SSRC が分からないので何も届かない。
      expect(highReceived).toEqual([]);

      // Act: 媒体を受けて RID の SSRC を学習したあと、rrid なしの RTX を受ける。
      router.routeRtp(
        createSimulcastMediaPacket({
          ssrc: high.ssrc,
          sequenceNumber: 7,
          rid: high.rid,
        }),
      );
      const late = rtxOf(6, 2);
      late.header.extensions = [];
      router.routeRtp(late);

      // Assert: 先に学習した RTX SSRC → RID の対応で復元される。
      expect(highReceived.map(({ ssrc, seq }) => ({ ssrc, seq }))).toEqual([
        { ssrc: high.ssrc, seq: 7 },
        { ssrc: high.ssrc, seq: 6 },
      ]);
    });

    test("未知の rrid、rrid なしの未知 RTX SSRC、apt codec のない RTX は破棄される", () => {
      // Arrange
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = [
        ...["high", "low"].map((rid) =>
          collectDeliveredRtp(receiver.trackByRID[rid]),
        ),
      ];
      router.routeRtp(
        createSimulcastMediaPacket({
          ssrc: high.ssrc,
          sequenceNumber: 1,
          rid: high.rid,
        }),
      );
      const lost = createSimulcastMediaPacket({
        ssrc: high.ssrc,
        sequenceNumber: 0,
      });
      const before = received.map((r) => r.length);

      // Act: 未知の rrid と、rrid のない未知 SSRC の RTX を受ける。
      router.routeRtp(
        createSimulcastRtxPacket(lost, {
          rtxSsrc: 3001,
          rtxSequenceNumber: 1,
          rrid: "unknown",
        }),
      );
      router.routeRtp(
        createSimulcastRtxPacket(lost, { rtxSsrc: 3002, rtxSequenceNumber: 1 }),
      );

      // Assert: どの track にも届かず、route も学習しない。
      expect(received.map((r) => r.length)).toEqual(before);
      expect(router.ssrcTable[3001]).toBeUndefined();
      expect(router.ssrcTable[3002]).toBeUndefined();

      // Act: apt (VP8) を持たない codec 表のまま RTX を受ける。
      const { router: noApt, receiver: noAptReceiver } =
        createSimulcastRtxReceiver();
      noAptReceiver.resyncCodecs({
        codecs: [
          new RTCRtpCodecParameters({
            mimeType: "video/rtx",
            clockRate: 90000,
            payloadType: 97,
            parameters: "apt=96",
          }),
        ],
        encodings: [],
        headerExtensions: [],
      });
      const noAptReceived = collectDeliveredRtp(
        noAptReceiver.trackByRID.high,
      );

      // Assert: 例外なく破棄される。
      expect(() =>
        noApt.routeRtp(
          createSimulcastRtxPacket(lost, {
            rtxSsrc: high.rtxSsrc,
            rtxSequenceNumber: 1,
            rrid: high.rid,
          }),
        ),
      ).not.toThrow();
      expect(noAptReceived).toEqual([]);
    });

    test("RTX なし simulcast は従来どおり rid で届き、rid 省略後も SSRC で届く", () => {
      // Arrange
      const { router, receiver } = createSimulcastRtxReceiver({ rtx: false });
      const highReceived = collectDeliveredRtp(receiver.trackByRID.high);

      // Act: rid 付きのあと rid なしの媒体を受ける。
      router.routeRtp(
        createSimulcastMediaPacket({
          ssrc: high.ssrc,
          sequenceNumber: 1,
          rid: high.rid,
        }),
      );
      router.routeRtp(
        createSimulcastMediaPacket({ ssrc: high.ssrc, sequenceNumber: 2 }),
      );

      // Assert
      expect(highReceived.map((p) => p.seq)).toEqual([1, 2]);
    });

    test("レイヤーごとの NACK は自分の媒体 SSRC 宛てで、交互受信で偽ロスが出ない", async () => {
      // Arrange
      vi.useFakeTimers();
      try {
        const { router, receiver, sentNacks } = createSimulcastRtxReceiver();
        const send = (layer: typeof high, sequenceNumber: number) =>
          router.routeRtp(
            createSimulcastMediaPacket({
              ssrc: layer.ssrc,
              sequenceNumber,
              rid: layer.rid,
            }),
          );

        // Act: 2 レイヤーを交互に受け、low だけ seq 502 を失う。
        send(high, 10);
        send(low, 500);
        send(high, 11);
        send(low, 501);
        send(high, 12);
        send(low, 503);
        await vi.advanceTimersByTimeAsync(10);

        // Assert: NACK は low の SSRC 宛てで 502 だけを要求する。
        const nacks = sentNacks();
        expect(nacks.length).toBeGreaterThan(0);
        for (const nack of nacks) {
          expect(nack.mediaSourceSsrc).toBe(low.ssrc);
          expect(nack.lost).toEqual([502]);
        }

        // Act: low の 502 を RTX で受ける。
        router.routeRtp(
          createSimulcastRtxPacket(
            createSimulcastMediaPacket({ ssrc: low.ssrc, sequenceNumber: 502 }),
            { rtxSsrc: low.rtxSsrc, rtxSequenceNumber: 1, rrid: low.rid },
          ),
        );
        const sent = sentNacks().length;
        await vi.advanceTimersByTimeAsync(20);

        // Assert: ロスが解消され、以降 NACK は送られない。
        expect(sentNacks().length).toBe(sent);
        receiver.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
