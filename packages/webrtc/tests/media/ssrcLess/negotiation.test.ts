import {
  RTCRtpCodingParameters,
  RTCRtpSimulcastParameters,
} from "../../../src/media/parameters";
import {
  createSimulcastMediaPacket,
  createSimulcastRtxPacket,
  createSimulcastRtxReceiver,
} from "../rtpReceiverTestUtils";
import {
  collectRtcpRecipients,
  collectTrackPayloads,
  createPendingRidOverFallback,
  createSsrcLessRouter,
  inboundRtpSsrcs,
  opus,
  pcmu,
  redOf,
  rtcpNamingSsrc,
  rtxOf,
  ssrcLessPacket,
  vp8,
} from "./arrange";

/**
 * #356: learning while a description is pending. The committed session decides
 * what is received until commit; commit adopts SDP SSRCs and RIDs, rollback
 * keeps packet-learned routes of the current session.
 */
describe("media/router: a=ssrc のない m-line の学習と交渉 (pending / commit / rollback) (#356)", () => {
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

      // Assert: 現在の session は SSRC-less のままなので、301 も offer の 400 も未知 SSRC として
      // 学習されて同じ track に届き、track.ssrc は最後に学習した 400 になる
      expect(payloads).toEqual(["payload-1", "payload-2", "payload-3"]);
      expect(audio.receiver.fallbackSsrcs).toEqual([300, 301, 400]);
      expect(announced.ssrc).toBe(400);
      expect(audio.receiver.track).toBe(announced);
      expect(audio.receiver.tracks).toEqual([]);

      // Act: commit または rollback する (rollback は NegotiationTransaction と同じく receiver が先)
      if (finish === "commit") {
        router.commitStaged();
      } else {
        audio.receiver.restoreNegotiationState(receiverState);
        router.restoreRoutes(routes, {
          endpoints: new Set([audio.receiver, audio.sender]),
          liveSenders: [],
        });
      }
      if (finish === "rollback") {
        // パケットから学習した 400 は baseline でも受信する PT (PCMU) なので残る
        expect(router.ssrcTable[400]).toBe(audio.receiver);
        expect(audio.receiver.fallbackSsrcs).toEqual([300, 301, 400]);
      }
      // commit 後は SDP の 400、rollback 後は学習済みの 301 で流す
      router.routeRtp(
        finish === "commit"
          ? ssrcLessPacket({ ssrc: 400, payloadType: 0, sequenceNumber: 4 })
          : ssrcLessPacket({ ssrc: 301, payloadType: 111, sequenceNumber: 4 }),
        dtls,
      );

      // Assert: commit は SDP の 400 / PCMU に切り替わり、rollback は学習済みの SSRC を保つ
      expect(audio.receiver.track).toBe(announced);
      expect(payloads).toEqual([
        "payload-1",
        "payload-2",
        "payload-3",
        "payload-4",
      ]);
      expect(announced.ssrc).toBe(400);
      expect(announced.codec?.mimeType).toBe("audio/PCMU");
      expect(await inboundRtpSsrcs(audio)).toEqual([400]);
      if (finish === "commit") {
        expect(audio.receiver.fallbackSsrc).toBeUndefined();
        expect(audio.receiver.tracks).toEqual([announced]);
        expect(router.learnedSsrcs.has(400)).toBe(false);
      } else {
        expect(audio.receiver.fallbackSsrc).toBe(400);
        expect(audio.receiver.tracks).toEqual([]);
      }
    },
  );

  test.each(["commit", "rollback"] as const)(
    "pending の SDP が RID を与えても、%s まで公開 track と fallback の SSRC 切替は現在の session のまま",
    (finish) => {
      // Arrange: opus の SSRC 300 を学習済みで、確定済みの受信中 session
      const { router, dtls, addReceiver } = createSsrcLessRouter();
      const audio = addReceiver();
      audio.setCurrentDirection("recvonly");
      const announced = audio.receiver.track;
      const payloads = collectTrackPayloads(audio);
      router.routeRtp(
        ssrcLessPacket({ ssrc: 300, payloadType: 111, sequenceNumber: 1 }),
        dtls,
      );
      const routes = router.snapshotRoutes();
      const receiverState = audio.receiver.snapshotNegotiationState();

      // Act: pending の re-offer が RID "high" を与え、その間に現在の送信元が SSRC 301 へ切り替える
      router.registerRtpReceiverByRid(
        audio,
        new RTCRtpSimulcastParameters({ rid: "high", direction: "send" }),
        { codecs: [opus()], headerExtensions: [], encodings: [] },
        { deferConflicts: true },
      );
      router.routeRtp(
        ssrcLessPacket({ ssrc: 301, payloadType: 111, sequenceNumber: 2 }),
        dtls,
      );

      // Assert: 公開 track も tracks も変わらず、301 を学習して同じ track に届く
      expect(audio.receiver.track).toBe(announced);
      expect(audio.receiver.tracks).toEqual([]);
      expect(audio.receiver.fallbackSsrc).toBe(301);
      expect(announced.ssrc).toBe(301);
      expect(payloads).toEqual(["payload-1", "payload-2"]);

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

      // Assert: commit は RID の track に切り替えて fallback を外し、rollback は 301 の fallback を保つ
      if (finish === "commit") {
        expect(audio.receiver.track.rid).toBe("high");
        expect(audio.receiver.trackByRID.high).toBe(audio.receiver.track);
        expect(audio.receiver.fallbackSsrc).toBeUndefined();
        expect(router.ssrcTable[301]).toBeUndefined();
      } else {
        expect(audio.receiver.track).toBe(announced);
        expect(audio.receiver.trackByRID.high).toBeUndefined();
        expect(audio.receiver.fallbackSsrc).toBe(301);
        expect(Object.keys(router.ridTable)).toEqual([]);
        router.routeRtp(
          ssrcLessPacket({ ssrc: 301, payloadType: 111, sequenceNumber: 3 }),
          dtls,
        );
        expect(payloads).toEqual(["payload-1", "payload-2", "payload-3"]);
      }
    },
  );

  test("pending の RID 付きで届いた未知 SSRC は現在の session のストリームとして通知済み track に届き、rollback 後も同じ track に届く", () => {
    // Arrange: SSRC 300 を学習済みの session に、保留中の re-offer が RID "high" を与えた
    const { router, dtls, audio, announced, rollback } =
      createPendingRidOverFallback(300);
    const payloads = collectTrackPayloads(audio);

    // Act: 保留中に RID "high" 付きの SSRC 400 を受信してから rollback する
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 400,
        payloadType: 111,
        sequenceNumber: 2,
        rid: "high",
      }),
      dtls,
    );
    rollback();

    // Assert: RID の track は作られず、400 は現在の session の fallback SSRC として残る
    expect(payloads).toEqual(["payload-2"]);
    expect(audio.receiver.trackByRID.high).toBeUndefined();
    expect(Object.keys(router.ridTable)).toEqual([]);
    expect(audio.receiver.trackBySSRC[400]).toBe(announced);
    expect(router.ssrcTable[400]).toBe(audio.receiver);

    // Act: 現在の送信元が RID なしで SSRC 400 を送り続ける
    router.routeRtp(
      ssrcLessPacket({ ssrc: 400, payloadType: 111, sequenceNumber: 3 }),
      dtls,
    );

    // Assert: 同じ通知済み track に届く
    expect(payloads).toEqual(["payload-2", "payload-3"]);
    expect(audio.receiver.track).toBe(announced);
    expect(audio.receiver.fallbackSsrc).toBe(400);
  });

  test("fallback の SSRC が pending 中に RID 付きでも届けば、commit で RID track に引き継ぎ、RID 拡張を省いた後続も届く", () => {
    // Arrange: SSRC 300 を学習済みの session に、保留中の re-offer が RID "high" を与えた
    const { router, dtls, audio } = createPendingRidOverFallback(300);

    // Act: 保留中に同じ SSRC 300 が RID "high" 付きで届いてから commit する
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 300,
        payloadType: 111,
        sequenceNumber: 2,
        rid: "high",
      }),
      dtls,
    );
    router.commitStaged();
    const high = audio.receiver.trackByRID.high;
    const delivered: number[] = [];
    high.onReceiveRtp.subscribe((rtp) =>
      delivered.push(rtp.header.sequenceNumber),
    );

    // Act: 送信側が RID 拡張を省いて SSRC 300 を送り続ける
    router.routeRtp(
      ssrcLessPacket({ ssrc: 300, payloadType: 111, sequenceNumber: 3 }),
      dtls,
    );

    // Assert: 300 は RID track の SSRC として残り、後続も RID track に届く
    expect(audio.receiver.track).toBe(high);
    expect(audio.receiver.trackBySSRC[300]).toBe(high);
    expect(audio.receiver.fallbackSsrc).toBeUndefined();
    expect(router.ssrcTable[300]).toBe(audio.receiver);
    expect(delivered).toEqual([3]);
  });

  test("rollback で消える PT で学習した SSRC は、receiver と経路の両方から消え、track.ssrc は残る SSRC に戻る", () => {
    // Arrange: opus だけを受ける session が SSRC 300 を学習済み。保留中の re-offer が PCMU (PT 0) を加えた
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver({ codecs: [opus()] });
    audio.setCurrentDirection("recvonly");
    const announced = audio.receiver.track;
    router.routeRtp(
      ssrcLessPacket({ ssrc: 300, payloadType: 111, sequenceNumber: 1 }),
      dtls,
    );
    const routes = router.snapshotRoutes();
    const receiverState = audio.receiver.snapshotNegotiationState();
    audio.receiver.prepareReceive(
      { codecs: [opus(), pcmu()], headerExtensions: [], encodings: [] },
      { deferConflicts: true },
    );

    // Act: 保留中に PCMU の SSRC 400 を学習してから rollback する (receiver が先、経路が後)
    router.routeRtp(
      ssrcLessPacket({ ssrc: 400, payloadType: 0, sequenceNumber: 2 }),
      dtls,
    );
    expect(announced.ssrc).toBe(400);
    audio.receiver.restoreNegotiationState(receiverState);
    router.restoreRoutes(routes, {
      endpoints: new Set([audio.receiver, audio.sender]),
      liveSenders: [],
    });

    // Assert: 400 は現在の session のストリームではないので消え、track は 300 / opus に戻る
    expect(audio.receiver.fallbackSsrcs).toEqual([300]);
    expect(router.ssrcTable[400]).toBeUndefined();
    expect(router.learnedSsrcs.has(400)).toBe(false);
    expect(audio.receiver.trackBySSRC[400]).toBeUndefined();
    expect(announced.ssrc).toBe(300);
    expect(announced.codec?.mimeType).toBe("audio/opus");
  });

  test("保留中の RID を運ぶ SSRC-less m-line のパケットは、同じ RID を確定済みの別 m-line に渡らず、自分の通知済み track に届く", () => {
    // Arrange: 同じ transport で、v は RID "high" (media SSRC 700) が確定済み、l は SSRC-less で
    // MID l により 300 を学習済み。保留中の re-offer が l に RID "high" を与えた (commit まで待つ)
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const l = addReceiver({ mid: "l" });
    l.setCurrentDirection("recvonly");
    const v = addReceiver({ mid: "v" });
    v.setCurrentDirection("recvonly");
    router.registerRtpReceiverByRid(
      v,
      new RTCRtpSimulcastParameters({ rid: "high", direction: "send" }),
      { codecs: [opus()], headerExtensions: [], encodings: [] },
    );
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 300,
        payloadType: 111,
        mid: "l",
        sequenceNumber: 1,
      }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 700,
        payloadType: 111,
        mid: "v",
        rid: "high",
        sequenceNumber: 1,
      }),
      dtls,
    );
    const vHigh: string[] = [];
    v.receiver.trackByRID.high.onReceiveRtp.subscribe((rtp) =>
      vHigh.push(rtp.payload.toString()),
    );
    const lPayloads = collectTrackPayloads(l);
    router.registerRtpReceiverByRid(
      l,
      new RTCRtpSimulcastParameters({ rid: "high", direction: "send" }),
      { codecs: [opus()], headerExtensions: [], encodings: [] },
      { deferConflicts: true },
    );

    // Act: l の現在のストリームが MID l と RID "high" を付けて届き、続けて SSRC 301 に切り替える
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 300,
        payloadType: 111,
        mid: "l",
        rid: "high",
        sequenceNumber: 2,
      }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 301,
        payloadType: 111,
        mid: "l",
        rid: "high",
        sequenceNumber: 1,
      }),
      dtls,
    );

    // Assert: どちらも l の通知済み track に届き、v の RID の media SSRC は 700 のまま
    expect(lPayloads).toEqual(["payload-2", "payload-1"]);
    expect(vHigh).toEqual([]);
    expect(v.receiver.mediaSsrcByRid.high).toBe(700);
    expect(router.ssrcTable[301]).toBe(l.receiver);
  });

  test("rollback で消える RED の PT で学習した SSRC は、主 codec の PT が残っていても忘れる", () => {
    // Arrange: opus だけを受ける session が 300 を学習済み。保留中の re-offer が RED (PT 63) を加えた
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver({ codecs: [opus()] });
    audio.setCurrentDirection("recvonly");
    router.routeRtp(ssrcLessPacket({ ssrc: 300, payloadType: 111 }), dtls);
    const routes = router.snapshotRoutes();
    const state = audio.receiver.snapshotNegotiationState();
    audio.receiver.prepareReceive(
      { codecs: [opus(), redOf(63, 111)], headerExtensions: [], encodings: [] },
      { deferConflicts: true },
    );

    // Act: 保留中に RED の SSRC 400 を学習してから rollback する (receiver が先、経路が後)
    router.routeRtp(
      ssrcLessPacket({ ssrc: 400, payloadType: 63, sequenceNumber: 1 }),
      dtls,
    );
    audio.receiver.restoreNegotiationState(state);
    router.restoreRoutes(routes, {
      endpoints: new Set([audio.receiver, audio.sender]),
      liveSenders: [],
    });

    // Assert: 400 は receiver と経路の両方から消え、track は 300 に戻る
    expect(audio.receiver.fallbackSsrcs).toEqual([300]);
    expect(router.ssrcTable[400]).toBeUndefined();
    expect(audio.receiver.track.ssrc).toBe(300);
  });

  test("MID のない保留中の RID 付きパケットも、SSRC で届く SSRC-less m-line のストリームとして扱い、同じ RID を確定済みの別 m-line に渡さない", () => {
    // Arrange: l は SSRC-less で 300 を学習済み、v は RID "high" (media SSRC 700) が確定済み。
    // 保留中の re-offer が l に RID "high" を与えた
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const l = addReceiver({ mid: "l" });
    l.setCurrentDirection("recvonly");
    const v = addReceiver({ mid: "v" });
    v.setCurrentDirection("recvonly");
    router.registerRtpReceiverByRid(
      v,
      new RTCRtpSimulcastParameters({ rid: "high", direction: "send" }),
      { codecs: [opus()], headerExtensions: [], encodings: [] },
    );
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 300,
        payloadType: 111,
        mid: "l",
        sequenceNumber: 1,
      }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 700,
        payloadType: 111,
        mid: "v",
        rid: "high",
        sequenceNumber: 1,
      }),
      dtls,
    );
    const lPayloads = collectTrackPayloads(l);
    router.registerRtpReceiverByRid(
      l,
      new RTCRtpSimulcastParameters({ rid: "high", direction: "send" }),
      { codecs: [opus()], headerExtensions: [], encodings: [] },
      { deferConflicts: true },
    );

    // Act: l の 300 が MID なし・RID "high" 付きで届く
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 300,
        payloadType: 111,
        rid: "high",
        sequenceNumber: 2,
      }),
      dtls,
    );

    // Assert: l の通知済み track に届き、v の RID の media SSRC は 700 のまま
    expect(lPayloads).toEqual(["payload-2"]);
    expect(v.receiver.mediaSsrcByRid.high).toBe(700);
    expect(router.ssrcTable[300]).toBe(l.receiver);
  });

  test("置き換えで firedReceiving が戻されても、確定済みで受信中の SSRC-less m-line は保留中の SSRC を commit まで待たせる", () => {
    // Arrange: 確定済みの recvonly session が 300 を学習済み。置き換えられた保留中の offer が
    // firedReceiving を戻した状態
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const audio = addReceiver();
    audio.setCurrentDirection("recvonly");
    const announced = audio.receiver.track;
    const payloads = collectTrackPayloads(audio);
    router.routeRtp(
      ssrcLessPacket({ ssrc: 300, payloadType: 111, sequenceNumber: 1 }),
      dtls,
    );
    audio.firedReceiving = false;

    // Act: 置き換えの offer が a=ssrc:777 を与え、その間も 300 が届く
    router.registerRtpReceiverBySsrc(
      audio,
      {
        codecs: [opus()],
        headerExtensions: [],
        encodings: [
          new RTCRtpCodingParameters({ ssrc: 777, payloadType: 111 }),
        ],
      },
      { deferConflicts: true },
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 300, payloadType: 111, sequenceNumber: 2 }),
      dtls,
    );

    // Assert: 保留中は現在の session のまま 300 が届く
    expect(audio.receiver.tracks).toEqual([]);
    expect(payloads).toEqual(["payload-1", "payload-2"]);

    // Act: 置き換えの offer が送信方向を示し (firedReceiving)、commit する
    audio.firedReceiving = true;
    router.commitStaged();

    // Assert: 通知済み track が SDP の 777 を引き継ぐ
    expect(audio.receiver.track).toBe(announced);
    expect(announced.ssrc).toBe(777);
  });

  test("offerer 側でも、pranswer の間に RID 付きで届いた fallback の SSRC は、answer で RID track に引き継ぐ", () => {
    // Arrange: SSRC 300 を学習済みの session に、remote pranswer が RID "high" を与えた
    const { router, dtls, audio } = createPendingRidOverFallback(300);
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 300,
        payloadType: 111,
        sequenceNumber: 2,
        rid: "high",
      }),
      dtls,
    );

    // Act: remote answer を setRemoteRTP と同じ順で適用し (deferredRemote を捨てて直接登録)、commit する
    audio.receiver.deferredRemote = undefined;
    const params = { codecs: [opus()], headerExtensions: [], encodings: [] };
    router.registerRtpReceiverByRid(
      audio,
      new RTCRtpSimulcastParameters({ rid: "high", direction: "send" }),
      params,
    );
    router.registerRtpReceiverBySsrc(audio, params);
    router.commitStaged();
    const high = audio.receiver.trackByRID.high;
    const delivered: number[] = [];
    high.onReceiveRtp.subscribe((rtp) =>
      delivered.push(rtp.header.sequenceNumber),
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 300, payloadType: 111, sequenceNumber: 3 }),
      dtls,
    );

    // Assert: 300 は RID track の SSRC になり、RID 拡張を省いた後続も届く
    expect(audio.receiver.trackBySSRC[300]).toBe(high);
    expect(router.ssrcTable[300]).toBe(audio.receiver);
    expect(delivered).toEqual([3]);
  });

  test("description を commit まで待たせている間に停止した transceiver には、commit で経路も track も戻らない", () => {
    // Arrange: l は SSRC-less で 300 を学習済み。保留中の re-offer が l に a=ssrc:777 を与えた
    const { router, dtls, transceivers, addReceiver } = createSsrcLessRouter();
    const l = addReceiver({ mid: "l" });
    l.setCurrentDirection("recvonly");
    const m = addReceiver({ mid: "m" });
    router.routeRtp(
      ssrcLessPacket({ ssrc: 300, payloadType: 111, mid: "l" }),
      dtls,
    );
    router.registerRtpReceiverBySsrc(
      l,
      {
        codecs: [opus()],
        headerExtensions: [],
        encodings: [
          new RTCRtpCodingParameters({ ssrc: 777, payloadType: 111 }),
        ],
      },
      { deferConflicts: true },
    );
    const mPayloads = collectTrackPayloads(m);

    // Act: 保留中にアプリが l を止め (登録解除)、その後 commit して、m の MID で 777 が届く
    l.stop();
    router.unregisterTransceiver(l);
    router.commitStaged();
    router.routeRtp(
      ssrcLessPacket({
        ssrc: 777,
        payloadType: 111,
        mid: "m",
        sequenceNumber: 2,
      }),
      dtls,
    );

    // Assert: 止めた l には 777 の経路も track もなく、m が 777 を学習する
    expect(l.receiver.tracks).toEqual([]);
    expect(router.ssrcTable[777]).toBe(m.receiver);
    expect(mPayloads).toEqual(["payload-2"]);
    expect(transceivers.includes(l)).toBe(true);
  });

  test("SSRC-less m-line の RTX が repaired-rtp-stream-id を運んでも、同じ RID を持つ別 m-line の RTX にならない", () => {
    // Arrange: n は RID "high" / "low" の simulcast (RTX あり)、l は同じ transport の SSRC-less video
    // (VP8 96 / RTX 97) で、保留中の re-offer が l に RID "high" を与えた
    const { router, transceivers, addReceiver } = createSsrcLessRouter();
    const n = createSimulcastRtxReceiver({ router, mid: "n" });
    n.transceiver.firedReceiving = true;
    n.transceiver.setCurrentDirection("recvonly");
    transceivers.push(n.transceiver);
    const l = addReceiver({
      kind: "video",
      mid: "l",
      codecs: [vp8(96), rtxOf(97, 96)],
      transport: n.dtls,
    });
    l.setCurrentDirection("recvonly");
    router.routeRtp(
      ssrcLessPacket({ ssrc: 300, payloadType: 96, mid: "l" }),
      n.dtls,
    );
    router.registerRtpReceiverByRid(
      l,
      new RTCRtpSimulcastParameters({ rid: "high", direction: "send" }),
      { codecs: [vp8(96), rtxOf(97, 96)], headerExtensions: [], encodings: [] },
      { deferConflicts: true },
    );

    // Act: l の RTX (SSRC 301、MID l、repaired-rtp-stream-id "high") が保留中に届く
    router.routeRtp(
      createSimulcastRtxPacket(
        createSimulcastMediaPacket({ ssrc: 300, sequenceNumber: 1, mid: "l" }),
        { rtxSsrc: 301, rtxSequenceNumber: 1, rrid: "high", mid: "l" },
      ),
      n.dtls,
    );

    // Assert: n の RTX として結び付かず、経路も作らない
    expect(n.receiver.ridByRtxSsrc[301]).toBeUndefined();
    expect(router.ssrcTable[301]).toBeUndefined();
  });

  test.each([
    ["PT が確定済みの m-line だけのもの", 120, "v"],
    ["PT が保留中の SSRC-less m-line だけのもの", 111, "l"],
    ["PT を両方が受ける (曖昧)", 112, "none"],
  ] as const)(
    "MID も経路もない新しい SSRC が、保留中と確定済みの両方の m-line にある RID を運ぶとき、%s なら受信先を PT で決める",
    (_, payloadType, owner) => {
      // Arrange: 同じ transport で、v は RID "high" (media SSRC 700) が確定済みで PT 120 と 112 を受け、
      // l は SSRC-less で PT 111 と 112 を受け、保留中の re-offer が l に RID "high" を与えた
      const { router, dtls, addReceiver } = createSsrcLessRouter();
      const l = addReceiver({ mid: "l", codecs: [opus(111), opus(112)] });
      l.setCurrentDirection("recvonly");
      const v = addReceiver({ mid: "v", codecs: [opus(120), opus(112)] });
      v.setCurrentDirection("recvonly");
      router.registerRtpReceiverByRid(
        v,
        new RTCRtpSimulcastParameters({ rid: "high", direction: "send" }),
        { codecs: [opus(120), opus(112)], headerExtensions: [], encodings: [] },
      );
      router.routeRtp(
        ssrcLessPacket({
          ssrc: 300,
          payloadType: 111,
          mid: "l",
          sequenceNumber: 1,
        }),
        dtls,
      );
      router.routeRtp(
        ssrcLessPacket({
          ssrc: 700,
          payloadType: 120,
          mid: "v",
          rid: "high",
          sequenceNumber: 1,
        }),
        dtls,
      );
      router.registerRtpReceiverByRid(
        l,
        new RTCRtpSimulcastParameters({ rid: "high", direction: "send" }),
        { codecs: [opus(111), opus(112)], headerExtensions: [], encodings: [] },
        { deferConflicts: true },
      );
      const lPayloads = collectTrackPayloads(l);
      const vHigh: string[] = [];
      v.receiver.trackByRID.high.onReceiveRtp.subscribe((rtp) =>
        vHigh.push(rtp.payload.toString()),
      );

      // Act: SSRC 701 の最初のパケットが MID なし・RID "high" 付きで届く
      router.routeRtp(
        ssrcLessPacket({
          ssrc: 701,
          payloadType,
          rid: "high",
          sequenceNumber: 2,
        }),
        dtls,
      );

      // Assert: PT が名指す m-line だけが受け、曖昧ならどちらにも届けない
      expect(vHigh).toEqual(owner === "v" ? ["payload-2"] : []);
      expect(lPayloads).toEqual(owner === "l" ? ["payload-2"] : []);
      expect(v.receiver.mediaSsrcByRid.high).toBe(owner === "v" ? 701 : 700);
    },
  );

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
