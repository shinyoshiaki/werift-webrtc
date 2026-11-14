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
  createSimulcastRtxFor,
  createSimulcastRtxPacket,
  createSimulcastRtxReceiver,
  getReceiverNack,
  retransmissionsOf,
  simulcastTimestampBase,
} from "./rtpReceiverTestUtils";
import {
  collectRtcpRecipients,
  collectTrackPayloads,
  collidingRouteCount,
  createCollidingSsrcLessRouter,
  createPayloadTypeSharingRouter,
  createSsrcLessRouter,
  inboundRtpSsrcs,
  opus,
  pcmu,
  rtcpNamingSsrc,
  rtxOf,
  ssrcLessPacket,
  vp8,
} from "./ssrcLessTestUtils";

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
    const mediaOf = (ssrc: number, sequenceNumber: number, rid?: string) =>
      createSimulcastMediaPacket({ ssrc, sequenceNumber, rid });

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
          ssrc: high.ssrc,
          sequenceNumber: 12,
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
          seq: 12,
          payloadType: 96,
          payload: "media-12",
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
      router.routeRtp(mediaOf(low.ssrc, 1, low.rid));
      router.routeRtp(mediaOf(low.ssrc, 3, low.rid));
      router.routeRtp(
        createSimulcastRtxFor(low.ssrc, 2, {
          rtxSsrc: low.rtxSsrc,
          rtxSequenceNumber: 1,
          rrid: low.rid,
        }),
      );

      // Act: RR 受信後のブラウザのように rid / rrid を付けずに送る。
      router.routeRtp(mediaOf(low.ssrc, 4));
      router.routeRtp(mediaOf(low.ssrc, 6));
      router.routeRtp(
        createSimulcastRtxFor(low.ssrc, 5, {
          rtxSsrc: low.rtxSsrc,
          rtxSequenceNumber: 2,
        }),
      );

      // Assert: 媒体も RTX も low の track に媒体 SSRC で届く。
      expect(
        lowReceived.map(({ ssrc, seq, type }) => ({ ssrc, seq, type })),
      ).toEqual([
        { ssrc: low.ssrc, seq: 1, type: "media" },
        { ssrc: low.ssrc, seq: 3, type: "media" },
        { ssrc: low.ssrc, seq: 2, type: "retransmission" },
        { ssrc: low.ssrc, seq: 4, type: "media" },
        { ssrc: low.ssrc, seq: 6, type: "media" },
        { ssrc: low.ssrc, seq: 5, type: "retransmission" },
      ]);
    });

    test("受信済みの番号や、前後の受信済みパケットがない番号の RTX は NACK に応えたものではないので破棄される", () => {
      // Arrange: high の 10, 12 を受信する。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      router.routeRtp(mediaOf(high.ssrc, 10, high.rid));
      router.routeRtp(mediaOf(high.ssrc, 12, high.rid));
      const rtx = (sequenceNumber: number, rtxSequenceNumber: number) =>
        createSimulcastRtxFor(high.ssrc, sequenceNumber, {
          rtxSsrc: high.rtxSsrc,
          rtxSequenceNumber,
          rrid: high.rid,
        });

      // Act: 受信済み 10、最新より先の 13、最古より前の 9 の RTX を受ける。
      router.routeRtp(rtx(10, 1));
      router.routeRtp(rtx(13, 2));
      router.routeRtp(rtx(9, 3));

      // Assert: どれも復元されない。
      expect(retransmissionsOf(received)).toEqual([]);

      // Act: 穴の 11 の RTX を 2 回受ける。
      router.routeRtp(rtx(11, 4));
      router.routeRtp(rtx(11, 5));

      // Assert: 1 回目だけ復元され、2 回目は受信済みとして破棄される。
      expect(retransmissionsOf(received)).toEqual([[high.ssrc, 11]]);
    });

    test("表示順と送信順が異なるフレーム (B フレーム) の欠落も RTX で復元される", () => {
      // Arrange: seq 10, 11, 12 の timestamp が 12000, 6000, 9000 (送信順で単調でない)。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      const base = simulcastTimestampBase(high.ssrc);
      const at = (sequenceNumber: number, offset: number) => ({
        sequenceNumber,
        timestamp: (base + offset) >>> 0,
      });
      const [i, b, p] = [at(10, 12000), at(11, 6000), at(12, 9000)];
      for (const packet of [i, p]) {
        router.routeRtp(
          createSimulcastMediaPacket({
            ssrc: high.ssrc,
            rid: high.rid,
            ...packet,
          }),
        );
      }

      // Act: 失った seq 11 (timestamp 6000) が RTX で届く。
      router.routeRtp(
        createSimulcastRtxFor(high.ssrc, b.sequenceNumber, {
          rtxSsrc: high.rtxSsrc,
          rrid: high.rid,
          timestamp: b.timestamp,
        }),
      );

      // Assert: 元の timestamp のまま復元される。
      expect(retransmissionsOf(received)).toEqual([[high.ssrc, 11]]);
      expect(received.find((p) => p.type === "retransmission")?.payload).toBe(
        "media-11",
      );
    });

    test("長い連続欠落でも、NACK した番号の RTX は欠落の位置によらず復元される", () => {
      // Arrange: seq 1 の次に 602 を受け、2〜601 を失う。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      router.routeRtp(mediaOf(high.ssrc, 1, high.rid));
      router.routeRtp(mediaOf(high.ssrc, 602, high.rid));

      // Act: 欠落の末尾 (600)、中央 (300)、先頭 (2) の RTX が届く。
      for (const [seq, rtxSequenceNumber] of [
        [600, 1],
        [300, 2],
        [2, 3],
      ]) {
        router.routeRtp(
          createSimulcastRtxFor(high.ssrc, seq, {
            rtxSsrc: high.rtxSsrc,
            rtxSequenceNumber,
            rrid: high.rid,
          }),
        );
      }

      // Assert: すべて元の SSRC で復元される。
      expect(retransmissionsOf(received)).toEqual([
        [high.ssrc, 600],
        [high.ssrc, 300],
        [high.ssrc, 2],
      ]);
    });

    test("長い連続欠落の直前のパケットが履歴から外れても、欠落の末尾の RTX は復元される", () => {
      // Arrange: seq 1 の次に 1000 を受け、その後 1001〜1100 を受けて seq 1 が履歴の範囲外になる。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      router.routeRtp(mediaOf(high.ssrc, 1, high.rid));
      for (let seq = 1000; seq <= 1100; seq++) {
        router.routeRtp(mediaOf(high.ssrc, seq, high.rid));
      }

      // Act: 欠落の末尾 999 の RTX が届く。
      router.routeRtp(
        createSimulcastRtxFor(high.ssrc, 999, {
          rtxSsrc: high.rtxSsrc,
          rrid: high.rid,
        }),
      );

      // Assert: 記録された欠落直前のパケットを下側の隣として復元される。
      expect(retransmissionsOf(received)).toEqual([[high.ssrc, 999]]);
    });

    test("履歴の窓より古い遅着パケットは受信記録を消さず、受信済みの番号の重複 RTX は二重に届かない", () => {
      // Arrange: seq 2000〜2002 を受けた後、1024 以上古い seq 977 (2001 と同じ枠) が遅れて届く。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      for (const seq of [2000, 2001, 2002]) {
        router.routeRtp(mediaOf(high.ssrc, seq, high.rid));
      }
      router.routeRtp(mediaOf(high.ssrc, 977));

      // Act: 受信済みの seq 2001 の重複 RTX が届く。
      router.routeRtp(
        createSimulcastRtxFor(high.ssrc, 2001, {
          rtxSsrc: high.rtxSsrc,
          rrid: high.rid,
        }),
      );

      // Assert: 2001 は一度だけ (媒体として) 届き、再送としては届かない。
      expect(received.filter((p) => p.seq === 2001)).toHaveLength(1);
      expect(retransmissionsOf(received)).toEqual([]);
    });

    test("旧 SSRC に古い遅着パケットが届いても、受信済みの番号では候補にならず、新 SSRC の RTX は復元される", () => {
      // Arrange: 旧 1000 は 2000〜2002 を受信済み、新 2000 は 2001 を失う (timestamp も同じ並び)。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      const media = (ssrc: number, seq: number, rid?: string) =>
        createSimulcastMediaPacket({
          ssrc,
          sequenceNumber: seq,
          rid,
          timestamp: seq * 3000,
        });
      for (const seq of [2000, 2001, 2002]) {
        router.routeRtp(media(1000, seq, high.rid));
      }
      for (const seq of [2000, 2002]) {
        router.routeRtp(media(2000, seq, high.rid));
      }
      // 旧 1000 の 1024 以上古い遅着パケット (2001 と同じ枠)。
      router.routeRtp(media(1000, 977));

      // Act: 新 2000 の seq 2001 の RTX が届く。
      router.routeRtp(
        createSimulcastRtxFor(2000, 2001, {
          rtxSsrc: 2001,
          rrid: high.rid,
          timestamp: 2001 * 3000,
        }),
      );

      // Assert: 旧 1000 は受信済みなので候補にならず、新 2000 で復元される。
      expect(retransmissionsOf(received)).toEqual([[2000, 2001]]);
      receiver.stop();
    });

    test("長い連続欠落の番号でも、timestamp が合わない別 SSRC の RTX は復元されない", () => {
      // Arrange: 旧媒体 1000 が seq 1〜602 の間を失い、同じ RID で新媒体 2000 も受信している。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      router.routeRtp(mediaOf(1000, 1, high.rid));
      router.routeRtp(mediaOf(1000, 602, high.rid));
      router.routeRtp(mediaOf(2000, 10, high.rid));
      router.routeRtp(mediaOf(2000, 12, high.rid));

      // Act: 新媒体 2000 の RTX (元 seq 300、2000 の timestamp) が届く。
      router.routeRtp(
        createSimulcastRtxFor(2000, 300, { rtxSsrc: 2001, rrid: high.rid }),
      );

      // Assert: 旧媒体 1000 の欠落としては復元されない。
      expect(retransmissionsOf(received)).toEqual([]);
      receiver.stop();
    });

    test("同じ RID の媒体 SSRC が切り替わると旧 SSRC の欠落の要求と台帳は同時に消え、遅れて届いた旧 RTX は破棄される", () => {
      // Arrange: 媒体 1000 (2, 4 を欠落) と RTX 1001 を学習させ、2 を回復する。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      const nack = getReceiverNack(receiver);
      const rtx = (sequenceNumber: number) =>
        createSimulcastRtxFor(high.ssrc, sequenceNumber, {
          rtxSsrc: high.rtxSsrc,
          rrid: high.rid,
        });
      for (const seq of [1, 3, 5]) {
        router.routeRtp(mediaOf(high.ssrc, seq, high.rid));
      }
      router.routeRtp(rtx(2));
      expect(nack.lostSeqNumbersOf(high.ssrc)).toEqual([4]);

      // Act: 同じ RID が新しい媒体 SSRC 5000 に切り替わったあと、旧 RTX と旧媒体が遅れて届く。
      router.routeRtp(mediaOf(5000, 100, high.rid));
      router.routeRtp(rtx(4));
      router.routeRtp(mediaOf(high.ssrc, 6, high.rid));

      // Assert: 旧 SSRC の NACK 要求も台帳も消え、遅れた旧 RTX / 旧媒体は届かず、RID は 5000 のまま。
      expect(nack.lostSeqNumbersOf(high.ssrc)).toEqual([]);
      expect(nack.holeCountOf(high.ssrc)).toBe(0);
      expect(retransmissionsOf(received)).toEqual([[high.ssrc, 2]]);
      expect(received.map((p) => p.seq)).not.toContain(6);
      expect(receiver.mediaSsrcByRid.high).toBe(5000);
      expect(router.ssrcTable[high.ssrc]).toBeUndefined();
      expect(router.ssrcTable[high.rtxSsrc]).toBeUndefined();
      receiver.stop();
    });
    test("媒体 SSRC 切り替え後に初めて届く旧 RTX SSRC は、現在の媒体の欠落に合わないので破棄される", () => {
      // Arrange: 媒体 1000 が 2 を欠落し、RTX 1001 は未学習のまま RID が媒体 5000 に切り替わる。
      // 5000 も 2 を失っている (seq の基点が同じ)。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      router.routeRtp(mediaOf(high.ssrc, 1, high.rid));
      router.routeRtp(mediaOf(high.ssrc, 3, high.rid));
      router.routeRtp(mediaOf(5000, 1, high.rid));
      router.routeRtp(mediaOf(5000, 3, high.rid));

      // Act: 切り替え後に初めて RTX 1001 (旧 1000 の seq 2) が届く。
      router.routeRtp(
        createSimulcastRtxFor(high.ssrc, 2, {
          rtxSsrc: high.rtxSsrc,
          rrid: high.rid,
        }),
      );

      // Assert: timestamp が 5000 の欠落に合わないので、どちらにも復元されない。
      expect(retransmissionsOf(received)).toEqual([]);
      receiver.stop();
    });
    test("媒体より先に届いた RTX は破棄され、媒体の学習後は同じ RTX SSRC が正しい媒体 SSRC で復元される", () => {
      // Arrange: 新媒体 2000 の RTX 2001 が媒体より先に届く。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      const rtx = (sequenceNumber: number, rtxSequenceNumber: number) =>
        createSimulcastRtxFor(2000, sequenceNumber, {
          rtxSsrc: 2001,
          rtxSequenceNumber,
          rrid: high.rid,
        });

      // Act: 媒体を 1 つも受けていない状態で RTX が届く。
      router.routeRtp(rtx(1, 1));

      // Assert: 復元先がないので破棄される。
      expect(retransmissionsOf(received)).toEqual([]);

      // Act: 旧媒体 1000、新媒体 2000 の順に届き、新媒体の seq 101 が欠けた後に RTX が届く。
      router.routeRtp(mediaOf(1000, 100, high.rid));
      router.routeRtp(mediaOf(1000, 102, high.rid));
      router.routeRtp(mediaOf(2000, 100, high.rid));
      router.routeRtp(mediaOf(2000, 102, high.rid));
      router.routeRtp(rtx(101, 2));

      // Assert: 旧媒体 1000 ではなく新媒体 2000 として復元される。
      expect(retransmissionsOf(received)).toEqual([[2000, 101]]);
      receiver.stop();
    });

    test("新媒体の RTX が新媒体の最初のパケットより先に届いても旧媒体に復元されず、新媒体の学習後は回復する", () => {
      // Arrange: 旧媒体 1000 を seq 1000 まで学習済みにする。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      const rtx = (sequenceNumber: number, rtxSequenceNumber: number) =>
        createSimulcastRtxFor(2000, sequenceNumber, {
          rtxSsrc: 2001,
          rtxSequenceNumber,
          rrid: high.rid,
        });
      router.routeRtp(mediaOf(1000, 998, high.rid));
      router.routeRtp(mediaOf(1000, 1000, high.rid));

      // Act: 新媒体 2000 の RTX (元 seq 950) が媒体より先に届く。
      router.routeRtp(rtx(950, 1));

      // Assert: 旧媒体 1000 としては復元されない。
      expect(retransmissionsOf(received)).toEqual([]);

      // Act: 新媒体 2000 の 949, 951 が届き、950 が再送される。
      router.routeRtp(mediaOf(2000, 949, high.rid));
      router.routeRtp(mediaOf(2000, 951, high.rid));
      router.routeRtp(rtx(950, 2));

      // Assert: 新媒体 2000 として復元される。
      expect(retransmissionsOf(received)).toEqual([[2000, 950]]);
      receiver.stop();
    });

    test("媒体切り替え後も、新しい RTX SSRC による新媒体のロス回復が続く", () => {
      // Arrange: 媒体 1000 の RTX 1001 を学習してから、RID が媒体 5000 に切り替わり 101〜105 を失う。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      router.routeRtp(mediaOf(1000, 0, high.rid));
      router.routeRtp(mediaOf(1000, 2, high.rid));
      router.routeRtp(
        createSimulcastRtxFor(1000, 1, { rtxSsrc: 1001, rrid: high.rid }),
      );
      router.routeRtp(mediaOf(5000, 100, high.rid));
      router.routeRtp(mediaOf(5000, 106, high.rid));

      // Act: 新しい RTX SSRC 5001 で 101〜105 が再送される (rrid は最初だけ)。
      for (const seq of [101, 102, 103, 104, 105]) {
        router.routeRtp(
          createSimulcastRtxFor(5000, seq, {
            rtxSsrc: 5001,
            rrid: seq === 101 ? high.rid : undefined,
          }),
        );
      }

      // Assert: すべて新媒体 5000 で復元される。
      expect(retransmissionsOf(received)).toEqual([
        [1000, 1],
        [5000, 101],
        [5000, 102],
        [5000, 103],
        [5000, 104],
        [5000, 105],
      ]);
      receiver.stop();
    });

    test("旧・新媒体が同じ番号を失っても、RTX は現在の媒体 SSRC の欠落にだけ復元される", () => {
      // Arrange: 旧媒体 1000 が seq 101 を失った後に新媒体 2000 へ切り替わり、2000 も 101 を失う。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      for (const ssrc of [1000, 2000]) {
        router.routeRtp(mediaOf(ssrc, 100, high.rid));
        router.routeRtp(mediaOf(ssrc, 102, high.rid));
      }
      const rtx = (mediaSsrc: number, rtxSequenceNumber: number) =>
        createSimulcastRtxFor(mediaSsrc, 101, {
          rtxSsrc: mediaSsrc + 1,
          rtxSequenceNumber,
          rrid: high.rid,
        });

      // Act: 旧媒体の RTX、新媒体の RTX の順に届く。
      router.routeRtp(rtx(1000, 1));
      router.routeRtp(rtx(2000, 1));

      // Assert: 旧媒体の RTX は破棄され、新媒体の RTX だけが 2000 で復元される。
      expect(retransmissionsOf(received)).toEqual([[2000, 101]]);
      receiver.stop();
    });

    test("欠落の後に 1024 個以上受信してから届いた RTX も、NACK が要求している間は復元される", () => {
      // Arrange: seq 100 を失い、101〜1125 を受信する。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      router.routeRtp(mediaOf(high.ssrc, 99, high.rid));
      for (let seq = 101; seq <= 1125; seq++) {
        router.routeRtp(mediaOf(high.ssrc, seq, high.rid));
      }
      expect(getReceiverNack(receiver).lostSeqNumbersOf(high.ssrc)).toEqual([
        100,
      ]);

      // Act: seq 100 の RTX が届く。
      router.routeRtp(
        createSimulcastRtxFor(high.ssrc, 100, {
          rtxSsrc: high.rtxSsrc,
          rrid: high.rid,
        }),
      );

      // Assert: 元の SSRC で復元され、NACK の要求も解消する。
      expect(retransmissionsOf(received)).toEqual([[high.ssrc, 100]]);
      expect(getReceiverNack(receiver).lostSeqNumbersOf(high.ssrc)).toEqual([]);
      receiver.stop();
    });

    test("NACK の再試行が尽きた欠落も台帳に残り、遅れて届いた RTX は復元される", async () => {
      // Arrange: seq 2 を失い、NACK の再試行 (5 ms ごと) を使い切る。
      vi.useFakeTimers();
      try {
        const { router, receiver } = createSimulcastRtxReceiver();
        const received = collectDeliveredRtp(receiver.trackByRID.high);
        const nack = getReceiverNack(receiver);
        router.routeRtp(mediaOf(high.ssrc, 1, high.rid));
        router.routeRtp(mediaOf(high.ssrc, 3, high.rid));
        await vi.advanceTimersByTimeAsync(200);
        expect(nack.lostSeqNumbersOf(high.ssrc)).toEqual([]);
        expect(nack.holeCountOf(high.ssrc)).toBe(1);

        // Act: 遅れて RTX が届く。
        router.routeRtp(
          createSimulcastRtxFor(high.ssrc, 2, {
            rtxSsrc: high.rtxSsrc,
            rrid: high.rid,
          }),
        );

        // Assert: 復元され、台帳からも消える。
        expect(retransmissionsOf(received)).toEqual([[high.ssrc, 2]]);
        expect(nack.holeCountOf(high.ssrc)).toBe(0);
        receiver.stop();
      } finally {
        vi.useRealTimers();
      }
    });
    test("旧媒体を修復した RTX SSRC は、新媒体に同じ番号・timestamp の欠落があっても復元に使われない", () => {
      // Arrange: 旧 1000 の欠落を RTX 1001 が修復した後、同じ seq / timestamp の基点で新 2000 に切り替わり、
      // 新 2000 が 101 を失う (RFC 3550 に反する、パケット単体では区別できない並び)。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      const media = (ssrc: number, seq: number) =>
        createSimulcastMediaPacket({
          ssrc,
          sequenceNumber: seq,
          rid: high.rid,
          timestamp: seq * 3000,
        });
      const rtx = (mediaSsrc: number, rtxSsrc: number, seq: number) =>
        createSimulcastRtxFor(mediaSsrc, seq, {
          rtxSsrc,
          rrid: high.rid,
          timestamp: seq * 3000,
        });
      router.routeRtp(media(1000, 50));
      router.routeRtp(media(1000, 52));
      router.routeRtp(rtx(1000, 1001, 51));
      router.routeRtp(media(2000, 100));
      router.routeRtp(media(2000, 102));

      // Act: 旧 RTX 1001 が 101 を、新 RTX 2001 が 101 を再送する。
      router.routeRtp(rtx(1000, 1001, 101));
      router.routeRtp(rtx(2000, 2001, 101));

      // Assert: 旧 RTX は退役済みとして破棄され、新 RTX だけが新 2000 で復元される。
      expect(retransmissionsOf(received)).toEqual([
        [1000, 51],
        [2000, 101],
      ]);
      expect(
        received.find((p) => p.type === "retransmission" && p.seq === 101)
          ?.payload,
      ).toBe("media-101");
      receiver.stop();
    });
    test("SSRC が切り替わり続けても、RID ごとの記録は上限内に収まり、各時点の媒体 SSRC の欠落は回復する", () => {
      // Arrange
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);

      // Act: 同じ RID で媒体 / RTX SSRC が 20 回切り替わる。各媒体は seq 1 を失い自分の RTX で回復し、
      // 直後に 1 つ前の媒体の RTX が遅れて届く。
      for (let i = 1; i <= 20; i++) {
        const ssrc = 10000 + i * 2;
        router.routeRtp(mediaOf(ssrc, 0, high.rid));
        router.routeRtp(mediaOf(ssrc, 2, high.rid));
        router.routeRtp(
          createSimulcastRtxFor(ssrc, 1, { rtxSsrc: ssrc + 1, rrid: high.rid }),
        );
        if (i > 1) {
          router.routeRtp(
            createSimulcastRtxFor(ssrc - 2, 1, {
              rtxSsrc: ssrc - 1,
              rtxSequenceNumber: 2,
              rrid: high.rid,
            }),
          );
        }
      }

      // Assert: 各媒体の欠落は自分の SSRC にだけ一度回復し、遅れた旧 RTX は破棄される。
      expect(retransmissionsOf(received)).toEqual(
        [...Array(20)].map((_, i) => [10000 + (i + 1) * 2, 1]),
      );
      // Assert: RID ごとの記録は上限内で、学習済みの経路と track 対応は現在の SSRC だけ。
      expect(receiver.mediaSsrcByRid.high).toBe(10040);
      expect(receiver.rtxSsrcsByRid.high.length).toBeLessThanOrEqual(8);
      expect(Object.keys(receiver.ridByRtxSsrc).length).toBeLessThanOrEqual(8);
      expect(receiver.retiredSsrcsByRid.high.length).toBeLessThanOrEqual(8);
      expect(getReceiverNack(receiver).ssrcs).toEqual([10040]);
      expect([...router.learnedSsrcs].sort()).toEqual([10040, 10041]);
      expect([...receiver.learnedTrackSsrcs]).toEqual([10040]);
      receiver.stop();
    });
    test("媒体 SSRC の切り替え後にロールバックしても、退役した旧 SSRC の経路と track 対応は復活しない", () => {
      // Arrange: 旧 1000 を学習した時点で交渉の基準 (ロールバック先) を取り、その後 RID が 2000 に切り替わる。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      router.routeRtp(mediaOf(1000, 1, high.rid));
      router.routeRtp(mediaOf(1000, 2, high.rid));
      const routes = router.snapshotRoutes();
      const receiverState = receiver.snapshotNegotiationState();
      router.routeRtp(mediaOf(2000, 100, high.rid));

      // Act: ロールバックで基準に戻し、RID 拡張のない旧 1000 の遅着パケットと新 2000 のパケットが届く。
      router.restoreRoutes(routes, {
        endpoints: new Set([receiver]),
        liveSenders: [],
      });
      receiver.restoreNegotiationState(receiverState);
      router.routeRtp(mediaOf(1000, 4));
      router.routeRtp(mediaOf(2000, 101));

      // Assert: 旧 1000 は経路も track 対応もなく届かず、NACK 状態も作られない。新 2000 は届く。
      expect(router.ssrcTable[1000]).toBeUndefined();
      expect(receiver.trackBySSRC[1000]).toBeUndefined();
      expect(received.map((p) => [p.ssrc, p.seq])).toEqual([
        [1000, 1],
        [1000, 2],
        [2000, 100],
        [2000, 101],
      ]);
      expect(getReceiverNack(receiver).ssrcs).toEqual([2000]);
      receiver.stop();
    });

    test("ロールバックしても、交渉の基準より後に学習した経路と、まだ学習中の経路はそのまま残る", () => {
      // Arrange: 基準の時点で 1000 を学習済み。その後 low の 2000 を学習する。
      const { router, receiver } = createSimulcastRtxReceiver();
      router.routeRtp(mediaOf(1000, 1, high.rid));
      const routes = router.snapshotRoutes();
      const receiverState = receiver.snapshotNegotiationState();
      router.routeRtp(mediaOf(2000, 1, low.rid));

      // Act
      router.restoreRoutes(routes, {
        endpoints: new Set([receiver]),
        liveSenders: [],
      });
      receiver.restoreNegotiationState(receiverState);

      // Assert: どちらの経路と track 対応も残る。
      for (const ssrc of [1000, 2000]) {
        expect(router.ssrcTable[ssrc]).toBe(receiver);
        expect(receiver.trackBySSRC[ssrc]).toBeDefined();
      }
      receiver.stop();
    });

    test("未交渉の payload type のパケットは、RID の媒体 SSRC を切り替えず、既存のストリームと NACK 状態を保つ", () => {
      // Arrange: 媒体 1000 が seq 2 を失い、NACK が要求している。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      const nack = getReceiverNack(receiver);
      router.routeRtp(mediaOf(1000, 1, high.rid));
      router.routeRtp(mediaOf(1000, 3, high.rid));
      const unknown = mediaOf(2000, 50, high.rid);
      unknown.header.payloadType = 120;

      // Act: 同じ RID で未交渉の payload type (120) の SSRC 2000 が届き、その後 1000 の後続と RTX が届く。
      router.routeRtp(unknown);
      router.routeRtp(mediaOf(1000, 4));
      router.routeRtp(
        createSimulcastRtxFor(1000, 2, { rtxSsrc: 1001, rrid: high.rid }),
      );

      // Assert: RID の媒体 SSRC は 1000 のまま、2000 は経路も track 対応も学習せず届かない。
      expect(receiver.mediaSsrcByRid.high).toBe(1000);
      expect(receiver.retiredSsrcsByRid.high ?? []).toEqual([]);
      expect(router.ssrcTable[2000]).toBeUndefined();
      expect(receiver.trackBySSRC[2000]).toBeUndefined();
      // Assert: 1000 の後続は届き、要求中の欠落は RTX で回復する。
      expect(received.map((p) => [p.ssrc, p.seq, p.type])).toEqual([
        [1000, 1, "media"],
        [1000, 3, "media"],
        [1000, 4, "media"],
        [1000, 2, "retransmission"],
      ]);
      expect(nack.lostSeqNumbersOf(1000)).toEqual([]);
      receiver.stop();
    });

    test("学習済みの RTX SSRC に無効なパケットが挟まっても経路は残り、拡張なしの後続 RTX は復元される", () => {
      // Arrange: 媒体 1000 の欠落 2 を RTX 1001 (rrid 付き) で修復し、1000 は 4 も失う。
      const { router, receiver } = createSimulcastRtxReceiver();
      const received = collectDeliveredRtp(receiver.trackByRID.high);
      for (const seq of [1, 3, 5]) {
        router.routeRtp(mediaOf(1000, seq, high.rid));
      }
      router.routeRtp(
        createSimulcastRtxFor(1000, 2, { rtxSsrc: 1001, rrid: high.rid }),
      );

      // Act: 同じ RTX SSRC 1001 で、未交渉の payload type と rid / rrid を持つ無効パケットが届く。
      const withRid = mediaOf(1001, 900, high.rid);
      withRid.header.payloadType = 120;
      router.routeRtp(withRid);
      const withRrid = createSimulcastRtxFor(1000, 901, {
        rtxSsrc: 1001,
        rrid: high.rid,
      });
      withRrid.header.payloadType = 120;
      router.routeRtp(withRrid);
      // Act: その後、拡張なしの RTX で 4 が再送される。
      router.routeRtp(
        createSimulcastRtxFor(1000, 4, {
          rtxSsrc: 1001,
          rtxSequenceNumber: 3,
          mid: null,
        }),
      );

      // Assert: 1001 の経路は残り、2 と 4 が 1000 で復元される。
      expect(router.ssrcTable[1001]).toBe(receiver);
      expect(router.learnedSsrcs.has(1001)).toBe(true);
      expect(retransmissionsOf(received)).toEqual([
        [1000, 2],
        [1000, 4],
      ]);
      receiver.stop();
    });

    test("新しい SSRC の無効なパケットは、そのパケットで追加された経路だけが取り消される", () => {
      // Arrange
      const { router, receiver } = createSimulcastRtxReceiver();
      router.routeRtp(mediaOf(1000, 1, high.rid));
      const invalid = mediaOf(3000, 1, high.rid);
      invalid.header.payloadType = 120;

      // Act: 未学習の SSRC 3000 から、未交渉の payload type のパケットが届く。
      router.routeRtp(invalid);

      // Assert: 3000 は経路を学習せず、1000 の経路は残る。
      expect(router.ssrcTable[3000]).toBeUndefined();
      expect(router.learnedSsrcs.has(3000)).toBe(false);
      expect(router.ssrcTable[1000]).toBe(receiver);
      receiver.stop();
    });

    test("transceiver の登録解除で、学習済み SSRC の印も経路と一緒に消える", () => {
      // Arrange: 媒体 SSRC と RTX SSRC を学習させる。
      const { router, transceiver } = createSimulcastRtxReceiver();
      router.routeRtp(mediaOf(high.ssrc, 1, high.rid));
      router.routeRtp(mediaOf(high.ssrc, 3, high.rid));
      router.routeRtp(
        createSimulcastRtxFor(high.ssrc, 2, {
          rtxSsrc: high.rtxSsrc,
          rrid: high.rid,
        }),
      );
      expect(router.learnedSsrcs.size).toBe(2);

      // Act
      router.unregisterTransceiver(transceiver);

      // Assert
      expect(router.ssrcTable[high.ssrc]).toBeUndefined();
      expect(router.ssrcTable[high.rtxSsrc]).toBeUndefined();
      expect(router.learnedSsrcs.size).toBe(0);
    });

    test("同じ RID を使う複数 m-line でも、学習済み RTX SSRC は MID 省略後に元の受信先へ届く", () => {
      // Arrange: mid "1" を先に登録し、同じ RID を使う mid "0" の receiver に RTX を学習させる。
      const { router, receiver: other } = createSimulcastRtxReceiver({
        mid: "1",
      });
      const { receiver } = createSimulcastRtxReceiver({ mid: "0", router });
      const received = collectDeliveredRtp(receiver.trackByRID.low);
      const otherReceived = collectDeliveredRtp(other.trackByRID.low);
      for (const seq of [1, 3, 5]) {
        router.routeRtp(mediaOf(low.ssrc, seq, low.rid));
      }
      router.routeRtp(
        createSimulcastRtxFor(low.ssrc, 2, {
          rtxSsrc: low.rtxSsrc,
          rrid: low.rid,
        }),
      );

      // Act: MID を省略し rrid だけを付けた RTX が届く。
      router.routeRtp(
        createSimulcastRtxFor(low.ssrc, 4, {
          rtxSsrc: low.rtxSsrc,
          rrid: low.rid,
          mid: null,
        }),
      );

      // Assert: RTX は学習済みの mid "0" 側にだけ届く。
      expect(retransmissionsOf(received)).toEqual([
        [low.ssrc, 2],
        [low.ssrc, 4],
      ]);
      expect(otherReceived).toEqual([]);
    });

    test("媒体 SSRC 未学習の RTX は破棄し、RID の学習後は同じ RTX SSRC を復元する", () => {
      // Arrange
      const { router, receiver } = createSimulcastRtxReceiver();
      const highReceived = collectDeliveredRtp(receiver.trackByRID.high);
      const rtxOf = (sequenceNumber: number, rtxSequenceNumber: number) =>
        createSimulcastRtxFor(high.ssrc, sequenceNumber, {
          rtxSsrc: high.rtxSsrc,
          rtxSequenceNumber,
          rrid: high.rid,
        });

      // Act: 媒体より先に RTX が届く。
      expect(() => router.routeRtp(rtxOf(5, 1))).not.toThrow();

      // Assert: 媒体 SSRC が分からないので何も届かない。
      expect(highReceived).toEqual([]);

      // Act: 媒体を受けて RID の SSRC を学習したあと、rrid なしの RTX を受ける。
      router.routeRtp(mediaOf(high.ssrc, 5, high.rid));
      router.routeRtp(mediaOf(high.ssrc, 7, high.rid));
      const late = rtxOf(6, 2);
      late.header.extensions = [];
      router.routeRtp(late);

      // Assert: 先に学習した RTX SSRC → RID の対応で復元される。
      expect(highReceived.map(({ ssrc, seq }) => ({ ssrc, seq }))).toEqual([
        { ssrc: high.ssrc, seq: 5 },
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
      const noAptReceived = collectDeliveredRtp(noAptReceiver.trackByRID.high);

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

describe("media/router: a=ssrc のない m-line の SSRC 学習 (#356)", () => {
  test("MID も RID もない単一ストリームは初回パケットから既定 track に届く", () => {
    // Arrange
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver({ codecs: [opus(), pcmu()] });
    const announced = audio.receiver.track;
    const payloads = collectTrackPayloads(audio);

    // Act: SDP にない SSRC で 2 パケット流す
    router.routeRtp(
      ssrcLessPacket({ ssrc: 4321, payloadType: 0, sequenceNumber: 1 }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 4321, payloadType: 0, sequenceNumber: 2 }),
      dtls,
    );

    // Assert: ontrack で通知済みの track に初回から届き、表が整合する
    expect(payloads).toEqual(["payload-1", "payload-2"]);
    expect(audio.receiver.track).toBe(announced);
    expect(router.ssrcTable[4321]).toBe(audio.receiver);
    expect(router.learnedSsrcs.has(4321)).toBe(true);
    expect(audio.receiver.trackBySSRC[4321]).toBe(announced);
    expect(audio.receiver.learnedTrackSsrcs.has(4321)).toBe(true);
    expect(audio.receiver.fallbackSsrc).toBe(4321);
    expect(announced.ssrc).toBe(4321);
    expect(announced.codec?.payloadType).toBe(0);
  });

  test("PT が重なる SSRC-less receiver が 2 つあれば学習しない", () => {
    // Arrange
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const first = addReceiver();
    const second = addReceiver();
    const payloads = [...[first, second].map((t) => collectTrackPayloads(t))];

    // Act
    router.routeRtp(ssrcLessPacket({ ssrc: 1, payloadType: 111 }), dtls);

    // Assert: どちらにも届かず、経路も増えない
    expect(payloads).toEqual([[], []]);
    expect(router.ssrcTable[1]).toBeUndefined();
    expect(router.learnedSsrcs.size).toBe(0);
  });

  test.each([
    ["a=ssrc のある m-line が同じ PT をメディアとして受信する", "ssrc"],
    ["RID の m-line が同じ PT をメディアとして受信する", "rid"],
    ["a=ssrc のある m-line が同じ PT を RTX として受信する", "rtx"],
  ] as const)("%s なら、MID のない未知 SSRC は学習しない", (_, neighbor) => {
    // Arrange: SSRC-less の m-line "l" と同じ transport の m-line "n" が同じ PT を受信する
    const {
      router,
      dtls,
      ssrcLess,
      neighbor: other,
      payloadType,
    } = createPayloadTypeSharingRouter(neighbor);
    const ssrcLessPayloads = collectTrackPayloads(ssrcLess);
    const recipients = collectRtcpRecipients({ l: ssrcLess, n: other });

    // Act: MID も RID もない未知 SSRC の RTP と、その SSRC を名指す SR が届く
    router.routeRtp(ssrcLessPacket({ ssrc: 77, payloadType }), dtls);
    router.routeRtcp(rtcpNamingSsrc.SR(77), dtls);

    // Assert: PT では m-line を決められないので、どの receiver にも届かず経路も学習しない
    expect(ssrcLessPayloads).toEqual([]);
    expect(recipients).toEqual([]);
    expect(router.ssrcTable[77]).toBeUndefined();
    expect(ssrcLess.receiver.fallbackSsrc).toBeUndefined();

    // Act: 同じ SSRC が MID "l" を明示して届く
    router.routeRtp(
      ssrcLessPacket({ ssrc: 77, payloadType, sequenceNumber: 2, mid: "l" }),
      dtls,
    );

    // Assert: MID で決まる m-line は PT が重なっていても学習する
    expect(ssrcLessPayloads).toEqual(["payload-2"]);
    expect(router.ssrcTable[77]).toBe(ssrcLess.receiver);
  });

  test("a=ssrc のある m-line と PT が分かれていれば、MID のない未知 SSRC は SSRC-less の m-line が学習する", () => {
    // Arrange: m-line "n" は PT 111 だけ、SSRC-less の "l" は PT 111 と PT 0 を受信する
    const { router, dtls, ssrcLess } = createPayloadTypeSharingRouter("ssrc");
    const payloads = collectTrackPayloads(ssrcLess);

    // Act: "l" だけが受信する PT 0 の未知 SSRC が届く
    router.routeRtp(ssrcLessPacket({ ssrc: 78, payloadType: 0 }), dtls);

    // Assert: PT 0 は "l" だけを示すので学習して届く
    expect(payloads).toEqual(["payload-1"]);
    expect(router.ssrcTable[78]).toBe(ssrcLess.receiver);
  });

  test("BUNDLE の audio / video は PT が分かれていれば PT で一意に決まる", () => {
    // Arrange
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver({ codecs: [opus()] });
    const video = addReceiver({ kind: "video", codecs: [vp8()] });
    const audioPayloads = collectTrackPayloads(audio);
    const videoPayloads = collectTrackPayloads(video);

    // Act
    router.routeRtp(ssrcLessPacket({ ssrc: 10, payloadType: 111 }), dtls);
    router.routeRtp(ssrcLessPacket({ ssrc: 20, payloadType: 96 }), dtls);

    // Assert: それぞれ正しい receiver だけに届く
    expect(audioPayloads).toEqual(["payload-1"]);
    expect(videoPayloads).toEqual(["payload-1"]);
    expect(router.ssrcTable[10]).toBe(audio.receiver);
    expect(router.ssrcTable[20]).toBe(video.receiver);
  });

  test("MID 拡張があれば MID の receiver に限って学習する", () => {
    // Arrange: PT が重なっても MID で決まる
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const first = addReceiver({ mid: "a" });
    const second = addReceiver({ mid: "b" });
    const firstPayloads = collectTrackPayloads(first);
    const secondPayloads = collectTrackPayloads(second);

    // Act
    router.routeRtp(
      ssrcLessPacket({ ssrc: 5, payloadType: 111, mid: "b" }),
      dtls,
    );

    // Assert
    expect(firstPayloads).toEqual([]);
    expect(secondPayloads).toEqual(["payload-1"]);
    expect(router.ssrcTable[5]).toBe(second.receiver);
  });

  test.each([
    ["別 transport", "transport"],
    ["停止済み", "stopped"],
    ["PT 非対応", "payloadType"],
    ["存在しない MID", "unknownMid"],
  ] as const)("MID の receiver が %s なら学習しない", (_, kind) => {
    // Arrange
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const other = addReceiver({ mid: "other" });
    const target = addReceiver({
      mid: "a",
      transport: kind === "transport" ? createDtlsTransport() : undefined,
    });
    if (kind === "stopped") target.stopped = true;
    const payloads = [other, target].map((t) => collectTrackPayloads(t));

    // Act: 条件を満たさない MID は別 m-line へ推測しない
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 7,
        payloadType: kind === "payloadType" ? 0 : 111,
        mid: kind === "unknownMid" ? "zzz" : "a",
      }),
      dtls,
    );

    // Assert
    expect(payloads).toEqual([[], []]);
    expect(router.ssrcTable[7]).toBeUndefined();
  });

  test("別 transport から届いたパケットと transport なしの呼び出しは学習しない", () => {
    // Arrange
    const { router, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver();
    const payloads = collectTrackPayloads(audio);

    // Act
    router.routeRtp(
      ssrcLessPacket({ ssrc: 8, payloadType: 111 }),
      createDtlsTransport(),
    );
    router.routeRtp(ssrcLessPacket({ ssrc: 8, payloadType: 111 }));

    // Assert
    expect(payloads).toEqual([]);
    expect(router.ssrcTable[8]).toBeUndefined();
  });

  test("RTX PT と受信 codec 表にない PT からは学習しない", () => {
    // Arrange
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const video = addReceiver({
      kind: "video",
      codecs: [vp8(), rtxOf(97, 96)],
    });
    const payloads = collectTrackPayloads(video);

    // Act
    router.routeRtp(ssrcLessPacket({ ssrc: 30, payloadType: 97 }), dtls);
    router.routeRtp(ssrcLessPacket({ ssrc: 31, payloadType: 100 }), dtls);

    // Assert
    expect(payloads).toEqual([]);
    expect(router.ssrcTable[30]).toBeUndefined();
    expect(router.ssrcTable[31]).toBeUndefined();
  });

  test("学習済み receiver に別 SSRC が来たら置き換え、表は 1 件のまま", () => {
    // Arrange
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver();
    const announced = audio.receiver.track;
    const payloads = collectTrackPayloads(audio);
    router.routeRtp(
      ssrcLessPacket({ ssrc: 100, payloadType: 111, sequenceNumber: 1 }),
      dtls,
    );

    // Act: SSRC が変わる (再 INVITE やメディアサーバ切替)
    router.routeRtp(
      ssrcLessPacket({ ssrc: 200, payloadType: 111, sequenceNumber: 2 }),
      dtls,
    );

    // Assert: 同じ track に届き、古い SSRC の経路と track は外れる
    expect(payloads).toEqual(["payload-1", "payload-2"]);
    expect(router.ssrcTable[100]).toBeUndefined();
    expect(router.ssrcTable[200]).toBe(audio.receiver);
    expect([...router.learnedSsrcs]).toEqual([200]);
    expect(Object.keys(audio.receiver.trackBySSRC)).toEqual(["200"]);
    expect([...audio.receiver.learnedTrackSsrcs]).toEqual([200]);
    expect(announced.ssrc).toBe(200);
  });

  test("SSRC 切替後に届いた旧 SSRC の遅延パケットでは受信先も状態も巻き戻らない", () => {
    // Arrange
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver();
    const payloads = collectTrackPayloads(audio);
    router.routeRtp(
      ssrcLessPacket({ ssrc: 100, payloadType: 111, sequenceNumber: 1 }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 200, payloadType: 111, sequenceNumber: 2 }),
      dtls,
    );

    // Act: 旧 SSRC の遅延パケットと新 SSRC のパケットが交互に届く
    router.routeRtp(
      ssrcLessPacket({ ssrc: 100, payloadType: 111, sequenceNumber: 3 }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 200, payloadType: 111, sequenceNumber: 4 }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 100, payloadType: 111, sequenceNumber: 5 }),
      dtls,
    );

    // Assert: 旧 SSRC は破棄され、新 SSRC の経路と track が保たれる
    expect(payloads).toEqual(["payload-1", "payload-2", "payload-4"]);
    expect(router.ssrcTable[100]).toBeUndefined();
    expect(router.ssrcTable[200]).toBe(audio.receiver);
    expect(audio.receiver.fallbackSsrc).toBe(200);
    expect(audio.receiver.track.ssrc).toBe(200);
  });

  test.each([
    ["direction が inactive に変更予定", "direction"],
    ["remote offer が m-line の拒否予定", "pendingRejection"],
    ["remote が sendonly から inactive に変更予定", "firedReceiving"],
  ] as const)(
    "確定済みの受信中 session は保留中の交渉で %s でも未知 SSRC を学習する",
    (_, pending) => {
      // Arrange: 現在の交渉結果は recvonly
      const { router, dtls, addReceiver } = createSsrcLessRouter();
      const audio = addReceiver();
      audio.setCurrentDirection("recvonly");
      const payloads = collectTrackPayloads(audio);

      // Act: 保留中の description が状態を変えた状態で未知 SSRC が届く
      if (pending === "direction") audio.direction = "inactive";
      if (pending === "pendingRejection") audio.pendingRejection = true;
      if (pending === "firedReceiving") audio.firedReceiving = false;
      router.routeRtp(
        ssrcLessPacket({ ssrc: 9, payloadType: 111, sequenceNumber: 1 }),
        dtls,
      );

      // Assert: commit まで現在の session が受信するので届く
      expect(payloads).toEqual(["payload-1"]);
      expect(router.ssrcTable[9]).toBe(audio.receiver);
    },
  );

  test("保留中の offer が同じ PT の m-line を追加すると、MID のない未知 SSRC は commit 後も学習せず、rollback 後は学習する", () => {
    // Arrange: 確定済みで受信中の SSRC-less m-line a に、保留中の remote offer が
    // 同じ PT (opus 111) を受ける SSRC-less m-line b を追加した (currentDirection 未確定)
    const { router, dtls, transceivers, addReceiver } = createSsrcLessRouter();
    const a = addReceiver({ mid: "a" });
    a.setCurrentDirection("recvonly");
    const b = addReceiver({ mid: "b" });
    const aPayloads = collectTrackPayloads(a);
    const bPayloads = collectTrackPayloads(b);

    // Act: 保留中に MID なしの SSRC 7 と、MID a を明示した SSRC 8 が届く
    router.routeRtp(
      ssrcLessPacket({ ssrc: 7, payloadType: 111, sequenceNumber: 1 }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 8,
        payloadType: 111,
        sequenceNumber: 2,
        mid: "a",
      }),
      dtls,
    );

    // Assert: PT は 2 つの m-line が受けるので MID なしは破棄し、MID a は a が学習する
    expect(aPayloads).toEqual(["payload-2"]);
    expect(bPayloads).toEqual([]);
    expect(router.ssrcTable[7]).toBeUndefined();

    // Act: commit (b も受信中で確定) してから MID なしの SSRC 7 が届く
    b.setCurrentDirection("recvonly");
    router.routeRtp(
      ssrcLessPacket({ ssrc: 7, payloadType: 111, sequenceNumber: 3 }),
      dtls,
    );

    // Assert: 確定後も PT は曖昧なので破棄する
    expect(aPayloads).toEqual(["payload-2"]);
    expect(bPayloads).toEqual([]);

    // Act: 代わりに rollback で b が消えてから、MID なしの SSRC 7 が届く
    router.unregisterTransceiver(b);
    transceivers.splice(transceivers.indexOf(b), 1);
    router.routeRtp(
      ssrcLessPacket({ ssrc: 7, payloadType: 111, sequenceNumber: 4 }),
      dtls,
    );

    // Assert: PT を受ける m-line が a だけに戻ったので、a が SSRC 7 に切り替えて受信する
    expect(aPayloads).toEqual(["payload-2", "payload-4"]);
    expect(a.receiver.fallbackSsrc).toBe(7);
  });

  test("保留中の offer が同じ PT の m-line を停止しても、commit までは MID のない未知 SSRC を学習しない", () => {
    // Arrange: 同じ PT (opus 111) を受ける SSRC-less m-line a と b が確定済みで受信中
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const a = addReceiver({ mid: "a" });
    const b = addReceiver({ mid: "b" });
    a.setCurrentDirection("recvonly");
    b.setCurrentDirection("recvonly");
    const aPayloads = collectTrackPayloads(a);
    const bPayloads = collectTrackPayloads(b);

    // Act: 保留中の remote offer が b を拒否予定にし、b の方向を inactive にした状態で SSRC 7 が届く
    b.pendingRejection = true;
    b.direction = "inactive";
    router.routeRtp(
      ssrcLessPacket({ ssrc: 7, payloadType: 111, sequenceNumber: 1 }),
      dtls,
    );

    // Assert: 現在の session では b も受信中なので、PT は曖昧なまま破棄する
    expect(aPayloads).toEqual([]);
    expect(bPayloads).toEqual([]);
    expect(router.ssrcTable[7]).toBeUndefined();

    // Act: commit (b は inactive で確定) してから SSRC 7 が届く
    b.setCurrentDirection("inactive");
    router.routeRtp(
      ssrcLessPacket({ ssrc: 7, payloadType: 111, sequenceNumber: 2 }),
      dtls,
    );

    // Assert: PT を受ける m-line が a だけになったので a が学習する
    expect(aPayloads).toEqual(["payload-2"]);
    expect(bPayloads).toEqual([]);
    expect(router.ssrcTable[7]).toBe(a.receiver);
  });

  test("確定済みで受信していない (sendonly) transceiver は学習しない", () => {
    // Arrange
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver();
    audio.setCurrentDirection("sendonly");
    const payloads = collectTrackPayloads(audio);

    // Act
    router.routeRtp(
      ssrcLessPacket({ ssrc: 9, payloadType: 111, sequenceNumber: 1 }),
      dtls,
    );

    // Assert: 現在の session が受信しないので破棄する
    expect(payloads).toEqual([]);
    expect(router.ssrcTable[9]).toBeUndefined();
  });

  test("別 transport で同じ数値の SSRC を学習しても、それぞれの receiver に配送する", () => {
    // Arrange: transport A の receiver が SSRC 55 を学習済み
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const otherTransport = createDtlsTransport();
    const a = addReceiver({ mid: "a" });
    const b = addReceiver({ mid: "b", transport: otherTransport });
    const aPayloads = collectTrackPayloads(a);
    const bPayloads = collectTrackPayloads(b);
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 1,
        mid: "a",
      }),
      dtls,
    );

    // Act: transport B から同じ SSRC のパケットが届き、その後は MID なしで両方に流れる
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 2,
        mid: "b",
      }),
      otherTransport,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 3 }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 4 }),
      otherTransport,
    );

    // Assert: A の経路は維持され、B にも自分の transport のパケットだけが届く
    expect(aPayloads).toEqual(["payload-1", "payload-3"]);
    expect(bPayloads).toEqual(["payload-2", "payload-4"]);
    expect(router.ssrcTable[55]).toBe(a.receiver);
    expect(a.receiver.fallbackSsrc).toBe(55);
    expect(b.receiver.fallbackSsrc).toBe(55);
  });

  test("別 transport の同一 SSRC の経路は transceiver の登録解除で残らない", () => {
    // Arrange
    const { router, dtls, transceivers, addReceiver } = createSsrcLessRouter();
    const otherTransport = createDtlsTransport();
    const a = addReceiver({ mid: "a" });
    const b = addReceiver({ mid: "b", transport: otherTransport });
    const bPayloads = collectTrackPayloads(b);
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, mid: "a" }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, mid: "b" }),
      otherTransport,
    );

    // Act: B の transceiver を解除してから同じ SSRC を B の transport へ流す
    router.unregisterTransceiver(b);
    transceivers.splice(transceivers.indexOf(b), 1);
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 9 }),
      otherTransport,
    );

    // Assert: 解除済みの receiver には届かず、A の経路は残る
    expect(bPayloads).toEqual(["payload-1"]);
    expect(router.ssrcTable[55]).toBe(a.receiver);
  });

  test.each(Object.keys(rtcpNamingSsrc))(
    "別 transport の同一 SSRC を名指す %s は受信した transport の receiver に届く",
    (type) => {
      // Arrange: A と B がそれぞれ SSRC 55 を学習済み
      const { router, dtls, other, a, b } = createCollidingSsrcLessRouter(55);
      const recipients = collectRtcpRecipients({ a, b });

      // Act: SSRC 55 を名指す RTCP を B、A の順に受信する
      router.routeRtcp(rtcpNamingSsrc[type](55), other);
      router.routeRtcp(rtcpNamingSsrc[type](55), dtls);

      // Assert: 各 RTCP は受信した transport の receiver だけに届く
      expect(recipients).toEqual(["b", "a"]);
    },
  );

  test("先に学習した transport の経路が消えても、別 transport の同一 SSRC の RTP と RTCP は届く", () => {
    // Arrange: A と B が SSRC 55 を学習済み
    const { router, transceivers, other, a, b } =
      createCollidingSsrcLessRouter(55);
    const bPayloads = collectTrackPayloads(b);
    const recipients = collectRtcpRecipients({ a, b });

    // Act: ssrcTable に経路を持つ A を解除してから、B の transport へ RTP と SR を流す
    router.unregisterTransceiver(a);
    transceivers.splice(transceivers.indexOf(a), 1);
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 7 }),
      other,
    );
    router.routeRtcp(rtcpNamingSsrc.SR(55), other);

    // Assert: B の経路は残り、RTP も SR も B に届く
    expect(bPayloads).toEqual(["payload-7"]);
    expect(recipients).toEqual(["b"]);
  });

  test("rollback 後も別 transport の同一 SSRC はそれぞれの receiver に RTP と RTCP が届く", () => {
    // Arrange: 学習前の baseline を取ってから、A と B が SSRC 55 を学習する
    const arranged = createSsrcLessRouter();
    const baseline = arranged.router.snapshotRoutes();
    const other = createDtlsTransport();
    const a = arranged.addReceiver({ mid: "a" });
    const b = arranged.addReceiver({ mid: "b", transport: other });
    const { router, dtls } = arranged;
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, mid: "a" }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, mid: "b" }),
      other,
    );
    const aPayloads = collectTrackPayloads(a);
    const bPayloads = collectTrackPayloads(b);
    const recipients = collectRtcpRecipients({ a, b });

    // Act: baseline へ rollback してから、両 transport に RTP と SR を流す
    router.restoreRoutes(baseline, {
      endpoints: new Set([a.receiver, b.receiver]),
      liveSenders: [],
    });
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 2 }),
      other,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 3 }),
      dtls,
    );
    router.routeRtcp(rtcpNamingSsrc.SR(55), other);
    router.routeRtcp(rtcpNamingSsrc.SR(55), dtls);

    // Assert: パケット由来の経路は rollback 後も残り、受信した transport の receiver だけに届く
    expect(bPayloads).toEqual(["payload-2"]);
    expect(aPayloads).toEqual(["payload-3"]);
    expect(recipients).toEqual(["b", "a"]);
    expect(router.ssrcTable[55]).toBe(a.receiver);
  });

  test("別 transport で置き換え済みの SSRC でも、この transport の新しいストリームとして学習する", () => {
    // Arrange: A が SSRC 55 を学習してから 66 に置き換えた (55 は A の置き換え済み SSRC)
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const other = createDtlsTransport();
    const a = addReceiver({ mid: "a" });
    const b = addReceiver({ mid: "b", transport: other });
    const bPayloads = collectTrackPayloads(b);
    const recipients = collectRtcpRecipients({ a, b });
    router.routeRtp(ssrcLessPacket({ ssrc: 55, payloadType: 111 }), dtls);
    router.routeRtp(ssrcLessPacket({ ssrc: 66, payloadType: 111 }), dtls);

    // Act: B の transport に SSRC 55 の RTP と SR が届く
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 3 }),
      other,
    );
    router.routeRtcp(rtcpNamingSsrc.SR(55), other);

    // Assert: B は SSRC 55 を学習して RTP と SR を受け、A の経路は 66 のまま
    expect(bPayloads).toEqual(["payload-3"]);
    expect(recipients).toEqual(["b"]);
    expect(b.receiver.fallbackSsrc).toBe(55);
    expect(a.receiver.fallbackSsrc).toBe(66);
  });

  test("別 transport が fallback で学習済みの SSRC を RID で学習しても、RTP と RTCP は RID の receiver に届く", () => {
    // Arrange: transport A の SSRC-less receiver が SSRC 55 を学習済みで、
    // 別 transport に RID "high" の simulcast receiver がある
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const a = addReceiver({ mid: "a" });
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, mid: "a" }),
      dtls,
    );
    const simulcast = createSimulcastRtxReceiver({ router, mid: "v" });
    const delivered = collectDeliveredRtp(simulcast.receiver.trackByRID.high);
    const recipients = collectRtcpRecipients({
      a,
      v: simulcast.transceiver,
    });

    // Act: RID 付きの SSRC 55、RID 拡張をやめた SSRC 55、SR を simulcast の transport で受信する
    router.routeRtp(
      createSimulcastMediaPacket({
        ssrc: 55,
        sequenceNumber: 1,
        rid: "high",
        mid: "v",
      }),
      simulcast.dtls,
    );
    router.routeRtp(
      createSimulcastMediaPacket({ ssrc: 55, sequenceNumber: 2, mid: null }),
      simulcast.dtls,
    );
    router.routeRtcp(rtcpNamingSsrc.SR(55), simulcast.dtls);

    // Assert: 両方の RTP と SR が simulcast の receiver に届き、A の経路は残る
    expect(delivered.map((d) => d.seq)).toEqual([1, 2]);
    expect(recipients).toEqual(["v"]);
    expect(router.ssrcTable[55]).toBe(a.receiver);
  });

  test.each([
    ["MID なし", undefined],
    ["MID が B", "b"],
  ] as const)(
    "別 transport が RID で先に学習した SSRC でも、SSRC-less の receiver が学習して RTP と RTCP を受ける (%s)",
    (_, mid) => {
      // Arrange: 別 transport の simulcast receiver が RID "high" で SSRC 55 を学習し、
      // RID 拡張なしの後続パケットも届いた後で、transport B に SSRC-less の receiver がある
      const { router, addReceiver } = createSsrcLessRouter();
      const simulcast = createSimulcastRtxReceiver({ router, mid: "v" });
      const other = createDtlsTransport();
      const b = addReceiver({ mid: "b", transport: other });
      const delivered = collectDeliveredRtp(simulcast.receiver.trackByRID.high);
      const bPayloads = collectTrackPayloads(b);
      const recipients = collectRtcpRecipients({ v: simulcast.transceiver, b });
      router.routeRtp(
        createSimulcastMediaPacket({
          ssrc: 55,
          sequenceNumber: 1,
          rid: "high",
          mid: "v",
        }),
        simulcast.dtls,
      );
      router.routeRtp(
        createSimulcastMediaPacket({ ssrc: 55, sequenceNumber: 2, mid: null }),
        simulcast.dtls,
      );

      // Act: B の transport に SSRC 55 の RTP と SR、続いて simulcast の transport に RTP と SR が届く
      router.routeRtp(
        ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 3, mid }),
        other,
      );
      router.routeRtcp(rtcpNamingSsrc.SR(55), other);
      router.routeRtp(
        createSimulcastMediaPacket({ ssrc: 55, sequenceNumber: 4, mid: null }),
        simulcast.dtls,
      );
      router.routeRtcp(rtcpNamingSsrc.SR(55), simulcast.dtls);

      // Assert: B は SSRC 55 を学習して受信し、simulcast の経路も保たれる
      expect(bPayloads).toEqual(["payload-3"]);
      expect(b.receiver.fallbackSsrc).toBe(55);
      expect(delivered.map((d) => d.seq)).toEqual([1, 2, 4]);
      expect(recipients).toEqual(["b", "v"]);
      expect(router.ssrcTable[55]).toBe(simulcast.receiver);
    },
  );

  test("transport を付け替えた receiver の同一 SSRC の経路は、旧 transport では使われず新 transport で使われる", () => {
    // Arrange: A と B が SSRC 55 を学習済みで、B の transceiver を新しい transport に付け替える
    const { router, dtls, other, a, b } = createCollidingSsrcLessRouter(55);
    const moved = createDtlsTransport();
    b.setDtlsTransport(moved);
    const aPayloads = collectTrackPayloads(a);
    const bPayloads = collectTrackPayloads(b);
    const recipients = collectRtcpRecipients({ a, b });

    // Act: 旧 transport に RTP と SR、新 transport に RTP と SR、A の transport に RTP が届く
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 2 }),
      other,
    );
    router.routeRtcp(rtcpNamingSsrc.SR(55), other);
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 3 }),
      moved,
    );
    router.routeRtcp(rtcpNamingSsrc.SR(55), moved);
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 4 }),
      dtls,
    );

    // Assert: 旧 transport の RTP と SR はどこにも届かず、新 transport は B、A の transport は A に届く
    expect(bPayloads).toEqual(["payload-3"]);
    expect(aPayloads).toEqual(["payload-4"]);
    expect(recipients).toEqual(["b"]);
    expect(b.receiver.fallbackSsrc).toBe(55);
    expect(router.ssrcTable[55]).toBe(a.receiver);
  });

  test("transport を付け替えた receiver の同一 SSRC の経路は、登録解除で残らない", () => {
    // Arrange: B が SSRC 55 を学習してから新しい transport に付け替える
    const { router, transceivers, b } = createCollidingSsrcLessRouter(55);
    b.setDtlsTransport(createDtlsTransport());

    // Act: B を登録解除する
    router.unregisterTransceiver(b);
    transceivers.splice(transceivers.indexOf(b), 1);

    // Assert: 同一 SSRC の補助経路は残らない
    expect(collidingRouteCount(router)).toBe(0);
  });

  test("transport を付け替えた receiver が SSRC を置き換えると、旧 SSRC の補助経路は残らない", () => {
    // Arrange: B が SSRC 55 を学習してから新しい transport に付け替える
    const { router, b } = createCollidingSsrcLessRouter(55);
    const moved = createDtlsTransport();
    b.setDtlsTransport(moved);
    const bPayloads = collectTrackPayloads(b);

    // Act: 新 transport で B に SSRC 66 が届く
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 66,
        payloadType: 111,
        sequenceNumber: 2,
        mid: "b",
      }),
      moved,
    );

    // Assert: B は 66 で受信し、55 の補助経路は消える
    expect(bPayloads).toEqual(["payload-2"]);
    expect(b.receiver.fallbackSsrc).toBe(66);
    expect(collidingRouteCount(router)).toBe(0);
  });

  test("同じ transport で別 MID が置き換え済みの SSRC を使い始めると、MID の receiver が学習する", () => {
    // Arrange: BUNDLE の MID a が SSRC 55 から 66 に切り替えた (55 は a の置き換え済み SSRC)
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const a = addReceiver({ mid: "a" });
    const b = addReceiver({ mid: "b" });
    const aPayloads = collectTrackPayloads(a);
    const bPayloads = collectTrackPayloads(b);
    const recipients = collectRtcpRecipients({ a, b });
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 1,
        mid: "a",
      }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 66,
        payloadType: 111,
        sequenceNumber: 2,
        mid: "a",
      }),
      dtls,
    );

    // Act: MID b を明示した SSRC 55 の RTP と、続く MID なしの RTP と SR が届く
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 3,
        mid: "b",
      }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 4 }),
      dtls,
    );
    router.routeRtcp(rtcpNamingSsrc.SR(55), dtls);

    // Assert: B が SSRC 55 を学習して受信し、A は 66 のまま
    expect(bPayloads).toEqual(["payload-3", "payload-4"]);
    expect(aPayloads).toEqual(["payload-1", "payload-2"]);
    expect(recipients).toEqual(["b"]);
    expect(b.receiver.fallbackSsrc).toBe(55);
    expect(a.receiver.fallbackSsrc).toBe(66);
  });

  test("置き換え済みの SSRC は、自分の MID を示す遅延パケットでも MID なしの遅延パケットでも学習しない", () => {
    // Arrange: BUNDLE の MID a が SSRC 55 から 66 に切り替えた
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const a = addReceiver({ mid: "a" });
    addReceiver({ mid: "b", codecs: [vp8()], kind: "video" });
    const aPayloads = collectTrackPayloads(a);
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 1,
        mid: "a",
      }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 66,
        payloadType: 111,
        sequenceNumber: 2,
        mid: "a",
      }),
      dtls,
    );

    // Act: SSRC 55 の遅延パケットが MID a 付きと MID なしで届く
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 3,
        mid: "a",
      }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 4 }),
      dtls,
    );

    // Assert: どちらも破棄され、A は 66 のまま
    expect(aPayloads).toEqual(["payload-1", "payload-2"]);
    expect(a.receiver.fallbackSsrc).toBe(66);
    expect(router.ssrcTable[55]).toBeUndefined();
  });

  test("ローカル sender と同じ SSRC の未知 RTP は例外を投げず、sender の経路を保つ", () => {
    // Arrange: SSRC-less の receiver とローカル sender がある
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver();
    const payloads = collectTrackPayloads(audio);
    const sender = new RTCRtpSender("audio");
    router.registerRtpSender(sender);

    // Act: sender と同じ SSRC の RTP を受信する
    const route = () =>
      router.routeRtp(
        ssrcLessPacket({ ssrc: sender.ssrc, payloadType: 111 }),
        dtls,
      );

    // Assert: 例外にならず、学習もせず、sender の経路は残る
    expect(route).not.toThrow();
    expect(payloads).toEqual([]);
    expect(audio.receiver.fallbackSsrc).toBeUndefined();
    expect(router.ssrcTable[sender.ssrc]).toBe(sender);
  });

  test("a=ssrc のある m-line は未知 SSRC の候補にならない", () => {
    // Arrange
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver({ ssrc: 1111 });

    // Act
    router.routeRtp(ssrcLessPacket({ ssrc: 2222, payloadType: 111 }), dtls);

    // Assert
    expect(router.ssrcTable[2222]).toBeUndefined();
    expect(router.ssrcTable[1111]).toBe(audio.receiver);
  });

  test("後から SDP が SSRC を与えると fallback で学習した経路は外れる", () => {
    // Arrange
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver();
    const announced = audio.receiver.track;
    router.routeRtp(ssrcLessPacket({ ssrc: 300, payloadType: 111 }), dtls);

    // Act: 再 offer で a=ssrc:400 が付く
    router.registerRtpReceiverBySsrc(audio, {
      codecs: [opus()],
      headerExtensions: [],
      encodings: [new RTCRtpCodingParameters({ ssrc: 400, payloadType: 111 })],
    });

    // Assert
    expect(router.ssrcTable[300]).toBeUndefined();
    expect(router.learnedSsrcs.has(300)).toBe(false);
    expect(audio.receiver.trackBySSRC[300]).toBeUndefined();
    expect(audio.receiver.fallbackSsrc).toBeUndefined();
    expect(router.ssrcTable[400]).toBe(audio.receiver);
    // 通知済みの track が SDP の SSRC に結び付き、ontrack をやり直さない
    expect(audio.receiver.track).toBe(announced);
    expect(audio.receiver.trackBySSRC[400]).toBe(announced);
    expect(announced.ssrc).toBe(400);
  });

  test.each([
    ["commit", 300],
    ["commit", 400],
    ["rollback", 300],
    ["rollback", 400],
  ] as const)(
    "pending の SDP が SSRC を与えても %s まで fallback の経路で受信が続く (SDP の SSRC %d)",
    (finish, sdpSsrc) => {
      // Arrange: SSRC 300 を学習済みの baseline
      const { router, dtls, addReceiver } = createSsrcLessRouter();
      const audio = addReceiver();
      const announced = audio.receiver.track;
      const payloads = collectTrackPayloads(audio);
      router.routeRtp(
        ssrcLessPacket({ ssrc: 300, payloadType: 111, sequenceNumber: 1 }),
        dtls,
      );
      const routes = router.snapshotRoutes();
      const receiverState = audio.receiver.snapshotNegotiationState();

      // Act: pending の re-offer が a=ssrc を付け、その間も 300 が届く
      router.registerRtpReceiverBySsrc(
        audio,
        {
          codecs: [opus()],
          headerExtensions: [],
          encodings: [
            new RTCRtpCodingParameters({ ssrc: sdpSsrc, payloadType: 111 }),
          ],
        },
        { deferConflicts: true },
      );
      router.routeRtp(
        ssrcLessPacket({ ssrc: 300, payloadType: 111, sequenceNumber: 2 }),
        dtls,
      );

      // Assert: 現在の session は同じ track で受信を続け、ontrack はやり直さない
      expect(payloads).toEqual(["payload-1", "payload-2"]);
      expect(audio.receiver.track).toBe(announced);

      // Act
      if (finish === "commit") {
        router.commitStaged();
      } else {
        router.restoreRoutes(routes, {
          endpoints: new Set([audio.receiver, audio.sender]),
          liveSenders: [],
        });
        audio.receiver.restoreNegotiationState(receiverState);
      }
      // commit 後は SDP の SSRC、rollback 後は学習済みの 300 で流す
      router.routeRtp(
        ssrcLessPacket({
          ssrc: finish === "commit" ? sdpSsrc : 300,
          payloadType: 111,
          sequenceNumber: 3,
        }),
        dtls,
      );

      // Assert: commit は SDP の SSRC へ、rollback は学習済みの 300 へ戻る
      expect(audio.receiver.track).toBe(announced);
      if (finish === "commit") {
        expect(payloads).toEqual(["payload-1", "payload-2", "payload-3"]);
        expect(announced.ssrc).toBe(sdpSsrc);
        expect(audio.receiver.fallbackSsrc).toBeUndefined();
        expect(router.learnedSsrcs.size).toBe(0);
        expect(Object.keys(router.ssrcTable)).toEqual([String(sdpSsrc)]);
      } else {
        expect(payloads).toEqual(["payload-1", "payload-2", "payload-3"]);
        expect(announced.ssrc).toBe(300);
        expect(audio.receiver.fallbackSsrc).toBe(300);
        expect(router.ssrcTable[sdpSsrc === 300 ? 300 : 400]).toBe(
          sdpSsrc === 300 ? audio.receiver : undefined,
        );
        expect(router.ssrcTable[300]).toBe(audio.receiver);
        expect(router.learnedSsrcs.has(300)).toBe(true);
        expect(audio.receiver.learnedTrackSsrcs.has(300)).toBe(true);
      }
    },
  );

  test.each([
    ["学習前", undefined, undefined],
    ["opus の SSRC 300 を学習済み", 300, "audio/opus"],
  ] as const)(
    "pending の SDP が別 codec の SSRC を与えても rollback で通知済み track の codec が戻る (%s)",
    (_, learnedSsrc, baselineMimeType) => {
      // Arrange: opus と PCMU を受ける SSRC-less の m-line と、rollback の baseline
      const { router, dtls, addReceiver } = createSsrcLessRouter();
      const audio = addReceiver({ codecs: [opus(), pcmu()] });
      const announced = audio.receiver.track;
      if (learnedSsrc !== undefined) {
        router.routeRtp(
          ssrcLessPacket({ ssrc: learnedSsrc, payloadType: 111 }),
          dtls,
        );
      }
      const routes = router.snapshotRoutes();
      const receiverState = audio.receiver.snapshotNegotiationState();

      // Act: pending の re-offer が PCMU の SSRC 400 を与える
      router.registerRtpReceiverBySsrc(
        audio,
        {
          codecs: [pcmu()],
          headerExtensions: [],
          encodings: [
            new RTCRtpCodingParameters({ ssrc: 400, payloadType: 0 }),
          ],
        },
        { deferConflicts: true },
      );

      // Assert: pending 中の通知済み track は baseline の SSRC と codec のまま (commit で採用する)
      expect(announced.ssrc).toBe(learnedSsrc);
      expect(announced.codec?.mimeType).toBe(baselineMimeType);

      // Act: rollback する
      router.restoreRoutes(routes, {
        endpoints: new Set([audio.receiver, audio.sender]),
        liveSenders: [],
      });
      audio.receiver.restoreNegotiationState(receiverState);

      // Assert: track の SSRC と codec は baseline の値に戻る
      expect(audio.receiver.track).toBe(announced);
      expect(announced.ssrc).toBe(learnedSsrc);
      expect(announced.codec?.mimeType).toBe(baselineMimeType);
    },
  );

  test("baseline 後に学習した fallback の codec は、pending の SDP の codec を rollback しても残る", () => {
    // Arrange: 学習前の baseline を取ってから opus の SSRC 300 を学習する
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver({ codecs: [opus(), pcmu()] });
    const announced = audio.receiver.track;
    const routes = router.snapshotRoutes();
    const receiverState = audio.receiver.snapshotNegotiationState();
    router.routeRtp(ssrcLessPacket({ ssrc: 300, payloadType: 111 }), dtls);

    // Act: pending の re-offer が PCMU の SSRC 400 を与えてから rollback する
    router.registerRtpReceiverBySsrc(
      audio,
      {
        codecs: [pcmu()],
        headerExtensions: [],
        encodings: [new RTCRtpCodingParameters({ ssrc: 400, payloadType: 0 })],
      },
      { deferConflicts: true },
    );
    router.restoreRoutes(routes, {
      endpoints: new Set([audio.receiver, audio.sender]),
      liveSenders: [],
    });
    audio.receiver.restoreNegotiationState(receiverState);

    // Assert: パケットから学習した SSRC 300 と、その opus が track に残る
    expect(announced.ssrc).toBe(300);
    expect(announced.codec?.mimeType).toBe("audio/opus");
  });

  test.each(["commit", "rollback"] as const)(
    "pending の SDP が SSRC と codec を与えても、%s まで track・統計・SSRC 切替は現在の session のまま",
    async (finish) => {
      // Arrange: opus の SSRC 300 を学習済みで、確定済みの受信中 session
      const { router, dtls, addReceiver } = createSsrcLessRouter();
      const audio = addReceiver({ codecs: [opus(), pcmu()] });
      audio.setCurrentDirection("recvonly");
      const announced = audio.receiver.track;
      const payloads = collectTrackPayloads(audio);
      router.routeRtp(
        ssrcLessPacket({ ssrc: 300, payloadType: 111, sequenceNumber: 1 }),
        dtls,
      );
      const routes = router.snapshotRoutes();
      const receiverState = audio.receiver.snapshotNegotiationState();

      // Act: pending の re-offer が PCMU の SSRC 400 を与える
      router.registerRtpReceiverBySsrc(
        audio,
        {
          codecs: [pcmu()],
          headerExtensions: [],
          encodings: [
            new RTCRtpCodingParameters({ ssrc: 400, payloadType: 0 }),
          ],
        },
        { deferConflicts: true },
      );

      // Assert: 公開 track の SSRC と codec、統計は現在受信中の 300 / opus のまま
      expect(announced.ssrc).toBe(300);
      expect(announced.codec?.mimeType).toBe("audio/opus");
      expect(await inboundRtpSsrcs(audio)).toEqual([300]);

      // Act: pending 中に現在の送信元が SSRC 301 へ切り替え、offer の SSRC 400 も届く
      router.routeRtp(
        ssrcLessPacket({ ssrc: 301, payloadType: 111, sequenceNumber: 2 }),
        dtls,
      );
      router.routeRtp(
        ssrcLessPacket({ ssrc: 400, payloadType: 0, sequenceNumber: 3 }),
        dtls,
      );

      // Assert: 301 は現在の session の新しい SSRC として学習され、400 も同じ track に届く
      expect(payloads).toEqual(["payload-1", "payload-2", "payload-3"]);
      expect(audio.receiver.fallbackSsrc).toBe(301);
      expect(announced.ssrc).toBe(301);
      expect(audio.receiver.track).toBe(announced);

      // Act: commit または rollback する
      if (finish === "commit") {
        router.commitStaged();
      } else {
        router.restoreRoutes(routes, {
          endpoints: new Set([audio.receiver, audio.sender]),
          liveSenders: [],
        });
        audio.receiver.restoreNegotiationState(receiverState);
      }
      if (finish === "rollback") {
        expect(router.ssrcTable[400]).toBeUndefined();
      }
      // commit 後は SDP の 400、rollback 後は学習済みの 301 で流す
      router.routeRtp(
        finish === "commit"
          ? ssrcLessPacket({ ssrc: 400, payloadType: 0, sequenceNumber: 4 })
          : ssrcLessPacket({ ssrc: 301, payloadType: 111, sequenceNumber: 4 }),
        dtls,
      );

      // Assert: commit は SDP の 400 / PCMU に切り替わり、rollback は学習済みの 301 / opus を保つ
      expect(audio.receiver.track).toBe(announced);
      if (finish === "commit") {
        expect(announced.ssrc).toBe(400);
        expect(announced.codec?.mimeType).toBe("audio/PCMU");
        expect(audio.receiver.fallbackSsrc).toBeUndefined();
        expect(payloads).toEqual([
          "payload-1",
          "payload-2",
          "payload-3",
          "payload-4",
        ]);
        expect(await inboundRtpSsrcs(audio)).toEqual([400]);
      } else {
        expect(announced.ssrc).toBe(301);
        expect(announced.codec?.mimeType).toBe("audio/opus");
        expect(audio.receiver.fallbackSsrc).toBe(301);
        expect(payloads).toEqual([
          "payload-1",
          "payload-2",
          "payload-3",
          "payload-4",
        ]);
        expect(await inboundRtpSsrcs(audio)).toEqual([301]);
      }
    },
  );

  test("transceiver の登録解除で学習済み SSRC が残らない", () => {
    // Arrange
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver();
    router.routeRtp(ssrcLessPacket({ ssrc: 500, payloadType: 111 }), dtls);

    // Act
    router.unregisterTransceiver(audio);

    // Assert
    expect(router.ssrcTable[500]).toBeUndefined();
    expect(router.learnedSsrcs.size).toBe(0);
    expect(audio.receiver.learnedTrackSsrcs.size).toBe(0);
    expect(audio.receiver.fallbackSsrc).toBeUndefined();
  });

  test("rollback の baseline で SSRC-less のままなら学習済み経路と track が保たれる", () => {
    // Arrange: 学習前の baseline
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver();
    const routes = router.snapshotRoutes();
    const receiverState = audio.receiver.snapshotNegotiationState();
    router.routeRtp(ssrcLessPacket({ ssrc: 600, payloadType: 111 }), dtls);

    // Act
    router.restoreRoutes(routes, {
      endpoints: new Set([audio.receiver, audio.sender]),
      liveSenders: [],
    });
    audio.receiver.restoreNegotiationState(receiverState);

    // Assert
    expect(router.ssrcTable[600]).toBe(audio.receiver);
    expect(audio.receiver.fallbackSsrc).toBe(600);
    expect(audio.receiver.track.ssrc).toBe(600);
  });

  test("fallback で学習済みの SSRC に別 MID が明示されたら、その MID の receiver へ引き渡す", () => {
    // Arrange: BUNDLE の MID a が SSRC 55 を学習済み
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const a = addReceiver({ mid: "a" });
    const b = addReceiver({ mid: "b" });
    const aPayloads = collectTrackPayloads(a);
    const bPayloads = collectTrackPayloads(b);
    const recipients = collectRtcpRecipients({ a, b });
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, mid: "a" }),
      dtls,
    );

    // Act: MID b を明示した SSRC 55、続く MID なしの RTP、SR が届く
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 2,
        mid: "b",
      }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 3 }),
      dtls,
    );
    router.routeRtcp(rtcpNamingSsrc.SR(55), dtls);

    // Assert: MID が対応付けを更新し (RFC 9143 9.2)、B が受信して A は手放す
    expect(aPayloads).toEqual(["payload-1"]);
    expect(bPayloads).toEqual(["payload-2", "payload-3"]);
    expect(recipients).toEqual(["b"]);
    expect(router.ssrcTable[55]).toBe(b.receiver);
    expect(a.receiver.fallbackSsrc).toBeUndefined();
    expect(a.receiver.track.ssrc).toBeUndefined();
    expect(b.receiver.fallbackSsrc).toBe(55);

    // Act: MID a を示す 55 の遅延パケットが届く
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 1,
        mid: "a",
      }),
      dtls,
    );

    // Assert: 遅延パケットは A に戻さず破棄し、B の経路は保たれる
    expect(aPayloads).toEqual(["payload-1"]);
    expect(bPayloads).toEqual(["payload-2", "payload-3"]);
    expect(router.ssrcTable[55]).toBe(b.receiver);
  });

  test("fallback で学習済みの SSRC に学習できない m-line の MID が明示されたら、どちらにも届けない", () => {
    // Arrange: MID a が SSRC 55 を学習済みで、MID n は a=ssrc のある m-line
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const a = addReceiver({ mid: "a" });
    const n = addReceiver({ mid: "n", ssrc: 9000 });
    const aPayloads = collectTrackPayloads(a);
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, mid: "a" }),
      dtls,
    );

    // Act: MID n を明示した SSRC 55 と、続く MID なしの RTP が届く
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 2,
        mid: "n",
      }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 3 }),
      dtls,
    );

    // Assert: MID n のパケットは A に誤配送せず破棄し、A の経路と MID なしの受信は続く
    expect(aPayloads).toEqual(["payload-1", "payload-3"]);
    expect(router.ssrcTable[55]).toBe(a.receiver);
    expect(n.receiver.trackBySSRC[55]).toBeUndefined();
  });

  test("学習済み SSRC の持ち主が baseline 後に変わっても、rollback 後は今の持ち主に RTP と RTCP が届く", () => {
    // Arrange: MID a が SSRC 55 を学習した状態を baseline にし、その後 a は 66 に切り替え、
    // MID b が 55 を学習する
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const a = addReceiver({ mid: "a" });
    const b = addReceiver({ mid: "b" });
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, mid: "a" }),
      dtls,
    );
    const baseline = router.snapshotRoutes();
    const aBaseline = a.receiver.snapshotNegotiationState();
    const bBaseline = b.receiver.snapshotNegotiationState();
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 66,
        payloadType: 111,
        sequenceNumber: 2,
        mid: "a",
      }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 3,
        mid: "b",
      }),
      dtls,
    );
    const aPayloads = collectTrackPayloads(a);
    const bPayloads = collectTrackPayloads(b);
    const recipients = collectRtcpRecipients({ a, b });

    // Act: baseline へ rollback してから、MID なしの 55 と 66 の RTP と 55 の SR が届く
    router.restoreRoutes(baseline, {
      endpoints: new Set([a.receiver, b.receiver]),
      liveSenders: [],
    });
    a.receiver.restoreNegotiationState(aBaseline);
    b.receiver.restoreNegotiationState(bBaseline);
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 4 }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 66, payloadType: 111, sequenceNumber: 5 }),
      dtls,
    );
    router.routeRtcp(rtcpNamingSsrc.SR(55), dtls);

    // Assert: パケット由来の経路は baseline の持ち主に戻らず、receiver の track と一致する
    expect(bPayloads).toEqual(["payload-4"]);
    expect(aPayloads).toEqual(["payload-5"]);
    expect(recipients).toEqual(["b"]);
    expect(router.ssrcTable[55]).toBe(b.receiver);
    expect(router.ssrcTable[66]).toBe(a.receiver);
    expect(b.receiver.fallbackSsrc).toBe(55);
    expect(a.receiver.fallbackSsrc).toBe(66);
  });
});
