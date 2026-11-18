import { RTCRtpCodingParameters } from "../../../src/media/parameters";
import { createDtlsTransport } from "../../fixture";
import {
  collectRtcpRecipients,
  collectTrackPayloads,
  createPayloadTypeSharingRouter,
  createSsrcLessRouter,
  inboundRtpSsrcs,
  opus,
  pcmu,
  rtcpNamingSsrc,
  rtxOf,
  ssrcLessPacket,
  vp8,
} from "./arrange";

/**
 * #356: which receiver learns an SSRC no route knows (MID, then a payload type
 * one receiving m-line of the RTP session receives), how a learned receiver
 * follows SSRC changes and late packets, and how a MID updates the mapping.
 */
describe("media/router: a=ssrc のない m-line の未知 SSRC の学習 (#356, RFC 9143 9.2)", () => {
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

  test("学習済み receiver に別 SSRC が来たら同じ track に追加して track.ssrc を新しい方にし、上限を超えた古い SSRC から忘れる", () => {
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

    // Assert: 同じ track に届き、旧 SSRC も同じ track への対応付けとして残る
    expect(payloads).toEqual(["payload-1", "payload-2"]);
    expect(router.ssrcTable[100]).toBe(audio.receiver);
    expect(router.ssrcTable[200]).toBe(audio.receiver);
    expect(audio.receiver.fallbackSsrcs).toEqual([100, 200]);
    expect(announced.ssrc).toBe(200);

    // Act: さらに 7 回 SSRC が変わり、学習 SSRC が上限 (8) を超える
    for (let i = 3; i <= 9; i++) {
      router.routeRtp(
        ssrcLessPacket({ ssrc: i * 100, payloadType: 111, sequenceNumber: i }),
        dtls,
      );
    }

    // Assert: 最も古い 100 だけが receiver と経路の両方から消え、表は上限のまま
    expect(audio.receiver.fallbackSsrcs).toEqual([
      200, 300, 400, 500, 600, 700, 800, 900,
    ]);
    expect(router.ssrcTable[100]).toBeUndefined();
    expect(router.learnedSsrcs.has(100)).toBe(false);
    expect(audio.receiver.trackBySSRC[100]).toBeUndefined();
    expect(router.learnedSsrcs.size).toBe(8);
    expect(announced.ssrc).toBe(900);
  });

  test("SSRC 切替後に届いた旧 SSRC の遅延パケットは同じ track に届き、受信先も track.ssrc も巻き戻らない", () => {
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

    // Assert: すべて同じ track に届き、新 SSRC の track.ssrc と学習順は変わらない
    expect(payloads).toEqual([
      "payload-1",
      "payload-2",
      "payload-3",
      "payload-4",
      "payload-5",
    ]);
    expect(router.ssrcTable[100]).toBe(audio.receiver);
    expect(router.ssrcTable[200]).toBe(audio.receiver);
    expect(audio.receiver.fallbackSsrc).toBe(200);
    expect(audio.receiver.track.ssrc).toBe(200);
  });

  test("切替前の SSRC の遅延パケットは、自分の MID 付きでも MID なしでも同じ track に届き、track.ssrc は新しい SSRC のまま", () => {
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

    // Assert: どちらも A の track に届き、A の track.ssrc は 66 のまま
    expect(aPayloads).toEqual([
      "payload-1",
      "payload-2",
      "payload-3",
      "payload-4",
    ]);
    expect(a.receiver.fallbackSsrc).toBe(66);
    expect(a.receiver.track.ssrc).toBe(66);
    expect(router.ssrcTable[55]).toBe(a.receiver);
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

  test.each([0, 1, 0xffffffff])(
    "SSRC %d (32 bit 全域が有効) も、学習・統計・rollback・解放で他の SSRC と同じに扱う",
    async (ssrc) => {
      // Arrange: 学習前の baseline を取る
      const { router, dtls, addReceiver } = createSsrcLessRouter();
      const audio = addReceiver();
      audio.setCurrentDirection("recvonly");
      const payloads = collectTrackPayloads(audio);
      const routes = router.snapshotRoutes();
      const receiverState = audio.receiver.snapshotNegotiationState();

      // Act: SSRC を学習する
      router.routeRtp(ssrcLessPacket({ ssrc, payloadType: 111 }), dtls);

      // Assert: RTP が届き、track と inbound-rtp 統計にその SSRC が出る
      expect(payloads).toEqual(["payload-1"]);
      expect(audio.receiver.track.ssrc).toBe(ssrc);
      expect(await inboundRtpSsrcs(audio)).toEqual([ssrc]);

      // Act: rollback する (receiver が先、経路が後)
      audio.receiver.restoreNegotiationState(receiverState);
      router.restoreRoutes(routes, {
        endpoints: new Set([audio.receiver, audio.sender]),
        liveSenders: [],
      });

      // Assert: パケット由来の SSRC は rollback 後も残り、統計にも出る
      expect(audio.receiver.fallbackSsrcs).toEqual([ssrc]);
      expect(audio.receiver.track.ssrc).toBe(ssrc);
      expect(await inboundRtpSsrcs(audio)).toEqual([ssrc]);

      // Act: description が SSRC を与えて学習 SSRC を外す
      router.registerRtpReceiverBySsrc(audio, {
        codecs: [opus()],
        headerExtensions: [],
        encodings: [
          new RTCRtpCodingParameters({
            ssrc: ssrc === 1 ? 2 : 1,
            payloadType: 111,
          }),
        ],
      });

      // Assert: 学習 SSRC は receiver と経路の両方から消える
      expect(audio.receiver.fallbackSsrcs).toEqual([]);
      expect(audio.receiver.trackBySSRC[ssrc]).toBeUndefined();
      expect(router.routeEntries.filter((r) => r.ssrc === ssrc)).toEqual([]);
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

    // Assert: 最後の MID 更新より古いパケットの MID は対応付けを変えず (RFC 9143 9.2)、
    // 今の対応付けの B に届く
    expect(aPayloads).toEqual(["payload-1"]);
    expect(bPayloads).toEqual(["payload-2", "payload-3", "payload-1"]);
    expect(router.ssrcTable[55]).toBe(b.receiver);

    // Act: MID a を示す、最後の更新より新しい 55 のパケットが届く
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 4,
        mid: "a",
      }),
      dtls,
    );

    // Assert: 新しい MID が対応付けを A に戻す
    expect(aPayloads).toEqual(["payload-1", "payload-4"]);
    expect(router.ssrcTable[55]).toBe(a.receiver);
    expect(b.receiver.hasFallbackSsrc(55)).toBe(false);
  });

  test("MID による対応付けの更新は、シーケンス番号の折り返しをまたいでも新旧を正しく判定する", () => {
    // Arrange: MID a が折り返し直前の 65534 で SSRC 55 を学習し、折り返し後の 1 で MID b に移った
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const a = addReceiver({ mid: "a" });
    const b = addReceiver({ mid: "b" });
    const aPayloads = collectTrackPayloads(a);
    const bPayloads = collectTrackPayloads(b);
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 65534,
        mid: "a",
      }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 1,
        mid: "b",
      }),
      dtls,
    );

    // Act: 折り返し前の 65535 が MID a 付きで遅れて届く
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 65535,
        mid: "a",
      }),
      dtls,
    );

    // Assert: 65535 は 1 より古いので対応付けは B のまま、B に届く
    expect(aPayloads).toEqual(["payload-65534"]);
    expect(bPayloads).toEqual(["payload-1", "payload-65535"]);
    expect(router.ssrcTable[55]).toBe(b.receiver);
  });

  test("未交渉 PT のパケットは fallback SSRC の MID 対応付けの状態を進めず、後の有効な MID パケットで移る", () => {
    // Arrange: MID a が SSRC 55 を seq 10 で学習し、MID b も学習できる
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const a = addReceiver({ mid: "a" });
    const b = addReceiver({ mid: "b" });
    const aPayloads = collectTrackPayloads(a);
    const bPayloads = collectTrackPayloads(b);
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 10,
        mid: "a",
      }),
      dtls,
    );

    // Act: 未交渉の PT 50 で、自分の MID a と大きな seq 1000 のパケットが届く
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 50,
        sequenceNumber: 1000,
        mid: "a",
      }),
      dtls,
    );

    // Assert: どちらにも届かず、対応付けは a のまま
    expect(aPayloads).toEqual(["payload-10"]);
    expect(bPayloads).toEqual([]);
    expect(router.ssrcTable[55]).toBe(a.receiver);

    // Act: 最後の有効な MID 更新 (seq 10) より新しい seq 500 が MID b 付きで届き、
    // 続いて MID なしの seq 501 が届く
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 55,
        payloadType: 111,
        sequenceNumber: 500,
        mid: "b",
      }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 501 }),
      dtls,
    );

    // Assert: 未交渉 PT のパケットに妨げられず b へ移り、MID なしの後続も b に届く
    expect(aPayloads).toEqual(["payload-10"]);
    expect(bPayloads).toEqual(["payload-500", "payload-501"]);
    expect(router.ssrcTable[55]).toBe(b.receiver);
    expect(a.receiver.fallbackSsrcs).toEqual([]);
    expect(b.receiver.fallbackSsrcs).toEqual([55]);
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
});
