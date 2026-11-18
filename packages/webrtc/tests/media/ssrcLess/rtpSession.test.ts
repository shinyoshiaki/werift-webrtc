import { RtcpPayloadSpecificFeedback } from "../../../src";
import { RTCRtpCodingParameters } from "../../../src/media/parameters";
import { RTCRtpSender } from "../../../src/media/rtpSender";
import {
  createDtlsTransport,
  createFirPacket,
  createPliPacket,
} from "../../fixture";
import {
  collectDeliveredRtp,
  createSimulcastMediaPacket,
  createSimulcastRtxFor,
  createSimulcastRtxReceiver,
  retransmissionsOf,
} from "../rtpReceiverTestUtils";
import {
  collectRtcpRecipients,
  collectSenderRtcp,
  collectTrackPayloads,
  createCollidingSsrcLessRouter,
  createSenderSsrcWithRid,
  createSsrcLessRouter,
  inboundRtpSsrcs,
  opus,
  routeLabels,
  rtcpNamingSsrc,
  ssrcLessPacket,
  vp8,
} from "./arrange";
import {
  createIdentifierMatrix,
  createRouteMatrix,
  expectedRouteMatrix,
} from "./matrices";

/**
 * #356 3.7 / 3.11 / 3.12: SSRC, RID, repaired RID and MID resolve within the RTP
 * session (transport) the packet arrived on; within one session sender, SDP
 * and learned routes rank sender > sdp > learned.
 */
describe("media/router: 識別子と経路は RTP session (transport) ごとに解決する (#356)", () => {
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

  test("学習済みの SSRC を同じ transport の別 m-line の SDP が名指すと、学習していた m-line はその SSRC を手放す", async () => {
    // Arrange: l が MID l で 500 を学習済み。同じ transport の n は別の PT を受ける
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const l = addReceiver({ mid: "l" });
    const n = addReceiver({ mid: "n", codecs: [opus(112)] });
    router.routeRtp(
      ssrcLessPacket({ ssrc: 500, payloadType: 111, mid: "l" }),
      dtls,
    );

    // Act: answer が n に a=ssrc:500 を与える
    router.registerRtpReceiverBySsrc(n, {
      codecs: [opus(112)],
      headerExtensions: [],
      encodings: [new RTCRtpCodingParameters({ ssrc: 500, payloadType: 112 })],
    });

    // Assert: 500 は n の経路になり、l の学習 SSRC・track・統計から消える
    expect(router.ssrcTable[500]).toBe(n.receiver);
    expect(l.receiver.fallbackSsrcs).toEqual([]);
    expect(l.receiver.trackBySSRC[500]).toBeUndefined();
    expect(l.receiver.track.ssrc).toBeUndefined();
    expect(await inboundRtpSsrcs(l)).toEqual([]);
  });

  test("別 transport が先に学習した SSRC を RTX SSRC として学習しても、rrid を省いた後続の RTX で欠落した媒体を復元する", () => {
    // Arrange: transport B の SSRC-less receiver b が SSRC 55 を学習済み。transport A の simulcast receiver
    // (RID "low") が、同じ数値の 55 を RTX SSRC として学習する
    const { router, addReceiver } = createSsrcLessRouter();
    const other = createDtlsTransport();
    const b = addReceiver({ mid: "b", transport: other });
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, mid: "b" }),
      other,
    );
    const simulcast = createSimulcastRtxReceiver({ router });
    const delivered = collectDeliveredRtp(simulcast.receiver.trackByRID.low);
    const media = (sequenceNumber: number, rid?: string) =>
      createSimulcastMediaPacket({ ssrc: 2000, sequenceNumber, rid });
    router.routeRtp(media(1, "low"), simulcast.dtls);
    router.routeRtp(media(3, "low"), simulcast.dtls);
    router.routeRtp(
      createSimulcastRtxFor(2000, 2, {
        rtxSsrc: 55,
        rtxSequenceNumber: 1,
        rrid: "low",
      }),
      simulcast.dtls,
    );

    // Act: rid / rrid を省いた媒体と RTX が続く
    router.routeRtp(media(4), simulcast.dtls);
    router.routeRtp(media(6), simulcast.dtls);
    router.routeRtp(
      createSimulcastRtxFor(2000, 5, { rtxSsrc: 55, rtxSequenceNumber: 2 }),
      simulcast.dtls,
    );

    // Assert: 2 つ目の RTX も媒体 SSRC で復元され、b の経路は残る
    expect(retransmissionsOf(delivered)).toEqual([
      [2000, 2],
      [2000, 5],
    ]);
    expect(router.ssrcTable[55]).toBe(b.receiver);
  });

  // #356 3.11: 同じ SSRC を名指す 2 つの終端 {sender, sdp, learned} × {同じ transport, 別 transport}
  // × 登録順の全セル (sender どうしはローカルで起きないので除く)。
  const routeMatrix = (["sender", "sdp", "learned"] as const)
    .flatMap((first) =>
      (["sender", "sdp", "learned"] as const).map((second) => ({
        first,
        second,
      })),
    )
    .filter(({ first, second }) => !(first === "sender" && second === "sender"))
    .flatMap((pair) =>
      [true, false].map((sameTransport) => ({ ...pair, sameTransport })),
    );
  test.each(routeMatrix)(
    "経路の組み合わせ: $first → $second (同じ transport: $sameTransport) で RTP と RTCP が正しい終端に届く",
    ({ first, second, sameTransport }) => {
      // Arrange: 同じ SSRC を名指す 2 つの終端
      const matrix = createRouteMatrix({ first, second, sameTransport });

      // Act: 登録順に経路を作り、各 transport に RTP と SR / RR / NACK / PLI / TWCC を流す
      matrix.register();
      const got = matrix.probe();

      // Assert: 各 transport で勝つ終端だけに届き、負けた学習側は SSRC を忘れる
      const expected = expectedRouteMatrix(matrix.ends, matrix.transports);
      expect(got).toEqual(expected.got);
      for (const end of matrix.ends) {
        if (end.kind !== "learned") continue;
        const receiver = end.transceiver!.receiver;
        expect(receiver.hasFallbackSsrc(matrix.ssrc), end.label).toBe(
          expected.keeps[end.label],
        );
        expect(receiver.track.ssrc, end.label).toBe(
          expected.keeps[end.label] ? matrix.ssrc : undefined,
        );
      }
    },
  );

  // #356 3.11: sender を含むセルに、rollback・受信側の登録解除・transport の付け替え (BUNDLE の
  // 統合) を加えた派生ケース。
  const senderCells = routeMatrix.filter(
    ({ first, second }) => first === "sender" || second === "sender",
  );
  test.each(
    senderCells.flatMap((cell) =>
      (["rollback", "unregister", "merge"] as const)
        .filter((op) => op !== "merge" || !cell.sameTransport)
        .map((op) => ({ ...cell, op })),
    ),
  )(
    "経路の組み合わせ $first → $second (同じ transport: $sameTransport) の後の $op でも、残る終端に正しく届く",
    ({ first, second, sameTransport, op }) => {
      // Arrange: 経路を作る前の baseline を取ってから、登録順に経路を作る
      const matrix = createRouteMatrix({ first, second, sameTransport });
      const baseline = matrix.router.snapshotRoutes();
      matrix.register();
      const receiverEnd = matrix.ends.find((e) => e.kind !== "sender")!;
      const senderEnd = matrix.ends.find((e) => e.kind === "sender")!;
      const keptBefore = Object.fromEntries(
        matrix.ends
          .filter((e) => e.kind === "learned")
          .map((e) => [
            e.label,
            e.transceiver!.receiver.hasFallbackSsrc(matrix.ssrc),
          ]),
      );

      // Act: rollback (SDP の経路は baseline に戻り、パケット由来と live な sender は残る)、
      // 受信側の登録解除、または受信側を sender の transport に付け替える
      let ends = matrix.ends;
      if (op === "rollback") {
        matrix.router.restoreRoutes(baseline, {
          endpoints: new Set(
            matrix.ends.flatMap((e) =>
              e.transceiver
                ? [e.transceiver.receiver, e.transceiver.sender]
                : [],
            ),
          ),
          liveSenders: [senderEnd.sender!],
        });
        ends = ends.filter((e) => e.kind !== "sdp");
      } else if (op === "unregister") {
        matrix.router.unregisterTransceiver(receiverEnd.transceiver!);
        matrix.transceivers.splice(
          matrix.transceivers.indexOf(receiverEnd.transceiver!),
          1,
        );
        ends = ends.filter((e) => e !== receiverEnd);
      } else {
        receiverEnd.transceiver!.setDtlsTransport(senderEnd.transport);
        ends = ends.map((e) =>
          e === receiverEnd ? { ...e, transport: senderEnd.transport } : e,
        );
      }
      // 登録時に負けて忘れた学習側は、経路を持たない
      ends = ends.filter((e) => e.kind !== "learned" || keptBefore[e.label]);
      const got = matrix.probe();

      // Assert: 残る終端だけで組み合わせ表の規則どおりに届き、負けた学習側は SSRC を忘れる
      const transports = [...new Set(ends.map((e) => e.transport))];
      const expected = expectedRouteMatrix(
        ends,
        matrix.transports.filter((t) => transports.includes(t)),
      );
      for (const end of matrix.ends) {
        const index = matrix.transports.indexOf(end.transport);
        const wanted = (expected.got[end.label] ?? []).map((what) =>
          what.startsWith("rtp:t")
            ? `rtp:t${matrix.transports.indexOf(
                ends.find((e) => e.label === end.label)!.transport,
              )}`
            : what,
        );
        expect(got[end.label], `${end.label} (transport ${index})`).toEqual(
          wanted,
        );
      }
      for (const end of ends) {
        if (end.kind !== "learned") continue;
        expect(
          end.transceiver!.receiver.hasFallbackSsrc(matrix.ssrc),
          end.label,
        ).toBe(expected.keeps[end.label]);
      }
    },
  );

  test("別 transport の同じ SSRC の受信先を 1 つの交渉でそれぞれ変えると、commit で両方が新しい receiver に移る", () => {
    // Arrange: transport A の a1 と transport B の b1 が SDP で SSRC 55 を受けている
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const other = createDtlsTransport();
    const a1 = addReceiver({ mid: "a1" });
    const a2 = addReceiver({ mid: "a2" });
    const b1 = addReceiver({ mid: "b1", transport: other });
    const b2 = addReceiver({ mid: "b2", transport: other });
    const sdp55 = {
      codecs: [opus()],
      headerExtensions: [],
      encodings: [new RTCRtpCodingParameters({ ssrc: 55, payloadType: 111 })],
    };
    router.registerRtpReceiverBySsrc(a1, sdp55);
    router.registerRtpReceiverBySsrc(b1, sdp55);
    // a2 / b2 は保留中の description が加えた m-line (まだ ontrack を通知していない)
    a2.firedReceiving = false;
    b2.firedReceiving = false;

    // Act: 保留中の description が 55 を A では a2、B では b2 に移し、commit する
    router.registerRtpReceiverBySsrc(a2, sdp55, { deferConflicts: true });
    router.registerRtpReceiverBySsrc(b2, sdp55, { deferConflicts: true });
    router.commitStaged();
    // commit 後の各 receiver の track (a2 / b2 は description が作った track) で受ける
    const payloads = Object.fromEntries(
      [a1, a2, b1, b2].map((t) => [t.mid!, collectTrackPayloads(t)]),
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 1 }),
      dtls,
    );
    router.routeRtp(
      ssrcLessPacket({ ssrc: 55, payloadType: 111, sequenceNumber: 2 }),
      other,
    );

    // Assert: A の RTP は a2 に、B の RTP は b2 に届く
    expect(payloads).toEqual({
      a1: [],
      a2: ["payload-1"],
      b1: [],
      b2: ["payload-2"],
    });
  });

  test("別 transport に同じ SSRC の仮経路を 2 つ追加しても、仮経路の破棄で両方とも消える", () => {
    // Arrange: transport A の a と transport B の b がある
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const other = createDtlsTransport();
    const a = addReceiver({ mid: "a" });
    const b = addReceiver({ mid: "b", transport: other });
    a.firedReceiving = false;
    b.firedReceiving = false;
    const sdp55 = {
      codecs: [opus()],
      headerExtensions: [],
      encodings: [new RTCRtpCodingParameters({ ssrc: 55, payloadType: 111 })],
    };

    // Act: 保留中の description が両方に 55 を仮経路として与え、後の pranswer がそれを破棄する
    router.registerRtpReceiverBySsrc(a, sdp55, { deferConflicts: true });
    router.registerRtpReceiverBySsrc(b, sdp55, { deferConflicts: true });
    router.discardProvisional();

    // Assert: どちらの transport にも 55 の経路は残らない
    expect(router.routeEntries.filter((r) => r.ssrc === 55)).toEqual([]);
  });

  // #356 3.12: 識別子 {RID, RRID, 学習 SSRC, SDP SSRC} × MID {なし, 自分の m-line, 別 transport
  // の m-line} × {持ち主と同じ transport, 別 transport}。期待値: 識別子はパケットの RTP session
  // の中でだけ解決し、別 transport の m-line を名指す MID は破棄、SDP 由来の経路は MID で
  // 動かず、届いた transport にその PT を受ける SSRC-less の m-line があれば PT で学習する。
  const identifierCells = [
    // [識別子, MID, transport, 受ける receiver, RTCP を受ける receiver]
    ["rid", "none", "same", "s", "s"],
    ["rid", "own", "same", "s", "s"],
    ["rid", "other", "same", null, null],
    ["rid", "none", "other", null, null],
    ["rid", "own", "other", null, null],
    ["rid", "other", "other", null, null],
    ["rrid", "none", "same", "s", "s"],
    ["rrid", "own", "same", "s", "s"],
    ["rrid", "other", "same", null, null],
    ["rrid", "none", "other", null, null],
    ["rrid", "own", "other", null, null],
    ["rrid", "other", "other", null, null],
    ["learned", "none", "same", "a", "a"],
    ["learned", "own", "same", "a", "a"],
    ["learned", "other", "same", null, "a"],
    ["learned", "none", "other", null, null],
    ["learned", "own", "other", null, null],
    ["learned", "other", "other", null, null],
    ["sdp", "none", "same", "n", "n"],
    ["sdp", "own", "same", "n", "n"],
    ["sdp", "other", "same", "n", "n"],
    ["sdp", "none", "other", "a", "a"],
    ["sdp", "own", "other", null, null],
    ["sdp", "other", "other", "a", "a"],
  ] as const;
  test.each(identifierCells)(
    "識別子の組み合わせ: %s (MID: %s、transport: %s) は %s が受け、RTCP は %s に届く",
    (kind, midCase, where, taker, rtcpTo) => {
      // Arrange: transport A に a (学習 SSRC 500)、transport B に s (RID high) と n (SDP SSRC 600)
      const matrix = createIdentifierMatrix();
      const ownerOnB = kind !== "learned";
      const ownMid = { rid: "s", rrid: "s", learned: "a", sdp: "n" }[kind];
      const otherMid = ownerOnB ? "a" : "n";
      const mid =
        midCase === "none" ? undefined : midCase === "own" ? ownMid : otherMid;
      const ownerTransport = ownerOnB ? matrix.transportB : matrix.transportA;
      const otherTransport = ownerOnB ? matrix.transportA : matrix.transportB;
      const transport = where === "same" ? ownerTransport : otherTransport;

      // Act: 識別子のパケットと、その SSRC を名指す SR / NACK / PLI を同じ transport に流す
      const got = matrix.send(kind, mid, transport);

      // Assert: パケットの RTP session の receiver だけが受け、RTCP も同じ先に届き、
      // 別 transport の receiver の状態は変わらない
      expect(got.taken).toEqual(taker ? [taker] : []);
      expect(got.rtcp).toEqual(rtcpTo ? [rtcpTo] : []);
      if (transport === matrix.transportA) {
        expect(matrix.s.receiver.ridByRtxSsrc).toEqual(got.before.rtx);
        expect(matrix.s.receiver.mediaSsrcByRid).toEqual(got.before.media);
      } else {
        expect(matrix.a.receiver.fallbackSsrcs).toEqual(got.before.fallback);
      }
    },
  );

  test("compatible の PLI / FIR 救済は、パケットの transport 上の送信側だけに届く", () => {
    // Arrange: transport A に映像の送信側が 1 つだけあり、B は別の RTP session
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const transportB = createDtlsTransport();
    const v = addReceiver({ kind: "video", mid: "v", codecs: [vp8()] });
    v.sender.dtlsTransport = dtls;
    router.registerRtpSender(v.sender);
    const got = collectSenderRtcp(v.sender);

    // Act: B で未知の SSRC と A の送信側の RTX SSRC を名指す PLI / FIR が届く
    router.routeRtcp(
      createPliPacket({ senderSsrc: 1, mediaSsrc: 424242 }),
      transportB,
    );
    router.routeRtcp(
      createPliPacket({ senderSsrc: 1, mediaSsrc: v.sender.rtxSsrc }),
      transportB,
    );
    router.routeRtcp(
      createFirPacket({
        senderSsrc: 1,
        fir: [{ ssrc: 424242, sequenceNumber: 1 }],
      }),
      transportB,
    );

    // Assert: 別の RTP session の要求は A の送信側に届かない
    expect(got).toEqual([]);

    // Act: 同じ PLI が A で届く
    router.routeRtcp(
      createPliPacket({ senderSsrc: 1, mediaSsrc: 424242 }),
      dtls,
    );

    // Assert: A の要求は従来どおり唯一の映像送信側に届く
    expect(got).toEqual([RtcpPayloadSpecificFeedback.type]);
  });

  test.each([
    ["rid", "same"],
    ["rrid", "same"],
    ["rid", "other"],
    ["rrid", "other"],
  ] as const)(
    "%s 付き RTP がローカル送信側の SSRC で届く (送信側は %s transport)",
    (kind, where) => {
      // Arrange: RID high の受信側 s と、SSRC X の送信側 (同じ transport か別 transport)
      const { ssrc, send } = createSenderSsrcWithRid(where);

      // Act: s の transport で、SSRC X と RID (または repaired RID) を持つパケットが届く
      const got = send(kind);

      if (where === "same") {
        // Assert: 同じ RTP session では送信側の SSRC の衝突 (RFC 3550 8.2) なので、
        // RID があっても受信側に届かず、何も学習せず、経路は送信側だけ
        expect(got.delivered).toEqual([]);
        expect(got.knows).toBe(false);
        expect(got.media).toEqual({});
        expect(got.rtx).toEqual({});
        expect(got.routes).toEqual(["sender:sender"]);
      } else {
        // Assert: 別 transport の送信側とは別のストリームなので、RID の受信側が受けて学習し、
        // 送信側の経路も残る
        if (kind === "rid") {
          expect(got.delivered).toEqual([ssrc]);
          expect(got.media).toEqual({ high: ssrc });
        } else {
          expect(got.rtx).toEqual({ [ssrc]: "high" });
        }
        expect(got.knows).toBe(true);
        expect(got.routes).toEqual(["sender:sender", "learned:s"]);
      }
    },
  );

  test("RID で学習した SSRC と同じ SSRC の送信側が登録されると、学習経路は消え RID 受信側に届かない", () => {
    // Arrange: RID high が SSRC X を学習し、同じ transport に SSRC X の送信側ができる
    const {
      router,
      transceiver: s,
      dtls,
    } = createSimulcastRtxReceiver({
      mid: "s",
    });
    router.transceivers = () => [s];
    s.firedReceiving = true;
    const sender = new RTCRtpSender("video");
    sender.dtlsTransport = dtls;
    const ssrc = sender.ssrc;
    router.routeRtp(
      createSimulcastMediaPacket({
        ssrc,
        sequenceNumber: 1,
        rid: "high",
        mid: "s",
      }),
      dtls,
    );
    const delivered = collectDeliveredRtp(s.receiver.trackByRID.high);
    const recipients = collectRtcpRecipients({ s });
    const senderRtcp = collectSenderRtcp(sender);

    // Act: 送信側を登録し、RID なしの SSRC X の RTP と SR が届く
    router.registerRtpSender(sender);
    router.routeRtp(
      createSimulcastMediaPacket({ ssrc, sequenceNumber: 2, mid: null }),
      dtls,
    );
    router.routeRtcp(rtcpNamingSsrc.SR(ssrc), dtls);

    // Assert: 経路は送信側だけになり、RTP も SR も RID 受信側に届かない
    // (SR は経路の勝者である送信側に届く、経路表の規則どおり)
    expect(routeLabels(router, ssrc, { s: s.receiver, sender })).toEqual([
      "sender:sender",
    ]);
    expect(s.receiver.knowsSsrc(ssrc)).toBe(false);
    expect(delivered).toEqual([]);
    expect(recipients).toEqual([]);
    expect(senderRtcp).toEqual([rtcpNamingSsrc.SR(ssrc).type]);
  });

  test("RID で学習した SSRC を同じ transport の別 m-line の answer が名指すと、RID の学習は消える", () => {
    // Arrange: transport B で RID high が SSRC 55 を学習している
    const { router, transportB, s, n } = createIdentifierMatrix();
    router.routeRtp(
      createSimulcastMediaPacket({
        ssrc: 55,
        sequenceNumber: 1,
        rid: "high",
        mid: "s",
      }),
      transportB,
    );
    const recipients = collectRtcpRecipients({ s, n });

    // Act: answer が B の m-line n に SSRC 55 を与え、55 の SR が届く
    router.registerRtpReceiverBySsrc(n, {
      codecs: [opus()],
      headerExtensions: [],
      encodings: [new RTCRtpCodingParameters({ ssrc: 55, payloadType: 111 })],
    });
    router.routeRtcp(rtcpNamingSsrc.SR(55), transportB);

    // Assert: 経路は SDP の n だけで、s は 55 を RID の媒体 SSRC として持たない
    expect(routeLabels(router, 55, { s: s.receiver, n: n.receiver })).toEqual([
      "sdp:n",
    ]);
    expect(s.receiver.knowsSsrc(55)).toBe(false);
    expect(s.receiver.mediaSsrcByRid).toEqual({});
    expect(recipients).toEqual(["n"]);
  });

  test("pending の description が別 transport の m-line に与えた SSRC は、commit で BUNDLE に合流すると前の SDP 経路を置き換える", () => {
    // Arrange: A の r1 が SDP SSRC 4000、B の r2 が 5000 を持ち、pending の再 offer が
    // 4000 を r2 に、4001 を r1 に移す
    const { router, dtls, addReceiver } = createSsrcLessRouter();
    const transportB = createDtlsTransport();
    const r1 = addReceiver({ mid: "1", ssrc: 4000 });
    r1.setCurrentDirection("recvonly");
    const r2 = addReceiver({ mid: "2", transport: transportB, ssrc: 5000 });
    r2.setCurrentDirection("recvonly");
    const encodingOf = (ssrc: number) => ({
      codecs: [opus()],
      headerExtensions: [],
      encodings: [new RTCRtpCodingParameters({ ssrc, payloadType: 111 })],
    });
    router.registerRtpReceiverBySsrc(r1, encodingOf(4001), {
      deferConflicts: true,
    });
    router.registerRtpReceiverBySsrc(r2, encodingOf(4000), {
      deferConflicts: true,
    });

    // Act: commit で r2 が A へ合流し、SSRC 4000 の RTP と SR が A で届く
    r2.setDtlsTransport(dtls);
    router.commitStaged();
    const r1Payloads = collectTrackPayloads(r1);
    const r2Payloads: string[] = [];
    for (const track of r2.receiver.tracks) {
      track.onReceiveRtp.subscribe((rtp) =>
        r2Payloads.push(rtp.payload.toString()),
      );
    }
    const recipients = collectRtcpRecipients({ r1, r2 });
    router.routeRtp(
      ssrcLessPacket({ ssrc: 4000, payloadType: 111, sequenceNumber: 9 }),
      dtls,
    );
    router.routeRtcp(rtcpNamingSsrc.SR(4000), dtls);

    // Assert: 4000 の経路は後の description の r2 だけで、RTP と SR も r2 に届く
    expect(
      routeLabels(router, 4000, { r1: r1.receiver, r2: r2.receiver }),
    ).toEqual(["sdp:r2"]);
    expect(r1Payloads).toEqual([]);
    expect(r2Payloads).toEqual(["payload-9"]);
    expect(recipients).toEqual(["r2"]);
  });
});
