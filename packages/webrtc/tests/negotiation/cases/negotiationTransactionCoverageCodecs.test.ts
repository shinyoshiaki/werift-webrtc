import {
  MediaStreamTrack,
  RTCRtpCodecParameters,
  type RTCRtpSender,
  SessionDescription,
  useH264,
  useNACK,
  usePLI,
  useREMB,
  useTWCC,
  useTransportWideCC,
  useVP8,
} from "../../../src";
import type { RTCDtlsTransport as DtlsTransport } from "../../../src/transport/dtls";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  createCommittedInactiveAudioPeers,
  createConnectedVideoPeers,
  createConnectedVideoPeersWith,
  createH264OnlyReoffer,
  createPeerPair,
  createUnnegotiatedPeers,
  offeredVideoCodecs,
  payloadTypeOf,
  pliReaches,
  recordSenderFeedback,
  sendRawRtp,
  twccFeedbackSent,
  videoWithoutFeedback,
  waitForPeersConnected,
  watchRtpText,
} from "../harness/negotiationTransactionUtils";

/** Act: seq first, first+1, first+4 (2 lost) on the sender's SSRC with `payloadType`; each must reach `incoming`. */
const sendWithGap = async (
  transceiver: { sender: RTCRtpSender; dtlsTransport: DtlsTransport },
  incoming: MediaStreamTrack,
  payloadType: number,
  first: number,
) => {
  for (const sequenceNumber of [first, first + 1, first + 4]) {
    const text = `t7b-${payloadType}-${sequenceNumber}`;
    const received = watchRtpText([incoming], text);
    await sendRawRtp(
      transceiver.dtlsTransport,
      { ssrc: transceiver.sender.ssrc, payloadType, sequenceNumber },
      Buffer.from(text),
    );
    await received;
  }
};

/** Codec settings: H264 with transport-cc feedback, then VP8 (transport-cc extension). */
const twccH264Config = () => ({
  codecs: {
    video: [
      useH264({
        rtcpFeedback: [useNACK(), usePLI(), useREMB(), useTWCC()],
      }),
      useVP8(),
    ],
  },
  headerExtensions: { video: [useTransportWideCC()] },
});

/** Arrange: replace `track.codec` with a copy whose RTCP feedback is `rtcpFeedback`. */
const setTrackFeedback = (
  track: MediaStreamTrack,
  rtcpFeedback: RTCRtpCodecParameters["rtcpFeedback"],
) => {
  track.codec = new RTCRtpCodecParameters({
    ...track.codec!,
    rtcpFeedback,
  });
};

/**
 * Spec coverage for codecs, RTCP feedback, routing keys and the develop
 * features inside the negotiation transaction (ticket 0ad06d37 sections
 * 2.4 / 2.5 / 2.6 / 2.8 / 5). Each test name starts with its requirement ID.
 * Every case ends with `expectSessionContinues` (next offer, ICE restart,
 * added DataChannel / transceiver, offer from the peer, traffic).
 */
describeCases(
  "negotiation transaction spec coverage: codecs and feedback",
  () => {
    negotiationCase(
      "[2.4-T7b] NACK, transport-cc and PLI follow the codec of each packet, not the lowest payload type",
      { ref: "2.4-T7b" },
      async (c) => {
        // Arrange: H264 (feedback なし) が小さい PT、VP8 (NACK・PLI・transport-cc) が大きい PT。
        const { a, b, incoming } = await c.given(
          createConnectedVideoPeers({
            codecs: {
              video: [
                useH264({ rtcpFeedback: [] }),
                useVP8({ rtcpFeedback: [useNACK(), usePLI(), useTWCC()] }),
              ],
            },
          }),
        );
        const transceiver = a.getTransceivers()[0];
        const sender = transceiver.sender;
        const receiver = b.getTransceivers()[0].receiver;
        const h264 = payloadTypeOf(b.currentRemoteDescription!.sdp, "H264");
        const vp8 = payloadTypeOf(b.currentRemoteDescription!.sdp, "VP8");
        expect(h264).toBeLessThan(vp8);
        const feedback = recordSenderFeedback(sender);

        // Act: feedback のない H264 の PT で、欠落 (seq の飛び) を含む RTP を送る。
        await sendWithGap(transceiver, incoming, h264, 1000);
        await c.sleep(200);

        // Assert: H264 のパケットでは NACK も transport-cc も始まらず、PLI も送らない。
        expect(feedback.record.nacks).toEqual([]);
        expect(receiver.receiverTWCC).toEqual(undefined);
        expect(receiver.pliNegotiation(sender.ssrc)).toEqual({
          payloadType: h264,
          allowed: false,
        });
        expect(await pliReaches(receiver, sender)).toBe(false);

        // Act: 同じ SSRC で NACK・PLI・transport-cc を持つ VP8 の PT の RTP を欠落付きで送る。
        await sendWithGap(transceiver, incoming, vp8, 2000);
        await c.waitFor(() => feedback.record.nacks.length !== 0, 1000);

        // Assert: VP8 のパケットの欠落には NACK が相手 sender に届き、PLI も届く。
        for (const item of [2002, 2003]) {
          expect(feedback.record.nacks.flat()).toContain(item);
        }
        expect(receiver.pliNegotiation(sender.ssrc)).toEqual({
          payloadType: vp8,
          allowed: true,
        });
        expect(await pliReaches(receiver, sender)).toBe(true);

        // Assert: transport-cc も最小 PT (H264) ではなく、VP8 のパケットで開始する。
        expect(receiver.receiverTWCC).not.toEqual(undefined);
        c.invariants(b);
        feedback.stop();
      },
    );

    negotiationCase(
      "[2.4-5] transport-cc feedback a pranswer packet started stops on rollback",
      { ref: "2.4-5" },
      async (c) => {
        // Arrange: H264 (transport-cc 付き) と VP8 を設定し、初回は VP8 だけで確定した session。
        const { a, b, outgoing, incoming, sender, receiver, transceiver } =
          await c.given(
            createConnectedVideoPeersWith({
              offerer: twccH264Config(),
              answerer: twccH264Config(),
              offererPreferences: [useVP8()],
            }),
          );
        expect(receiver.receiverTWCC).toEqual(undefined);

        // Arrange: re-offer は H264 と VP8 の両方を提案し、answerer は H264 を先頭に答える。
        transceiver.setCodecPreferences([]);
        await c.offer(a);
        const answer = await b.createAnswer();
        expect(offeredVideoCodecs(answer.sdp)[0]).toEqual("H264");

        // Act: H264 の pranswer を両側に適用し、offerer が暫定の H264 で送る。
        await c.setLocal(b, answer, { type: "pranswer" });
        await c.setRemote(a, answer, { type: "pranswer" });

        // Assert: transport-cc を交渉した H264 のパケット受信で TWCC が始まり、feedback を送る。
        expect(sender.codec?.name.toUpperCase()).toEqual("H264");
        expect(await twccFeedbackSent(outgoing, receiver)).toBe(true);
        expect(receiver.receiverTWCC).not.toEqual(undefined);

        await c.rollback(a);

        // Assert: pending 中に始まった TWCC は止まり、current の VP8 の RTP には feedback を送らない。
        expect(receiver.receiverTWCC).toEqual(undefined);
        expect(sender.codec?.name.toUpperCase()).toEqual("VP8");
        expect(await twccFeedbackSent(outgoing, receiver)).toBe(false);

        // Assert: current の RTP は届き続ける。
        await c.rtp(outgoing, incoming);
      },
    );

    negotiationCase(
      "[2.4-7] a transceiver for a remote offer does not take the m-line of a committed inactive transceiver",
      { ref: "2.4-7" },
      async (c) => {
        // Arrange: inactive な audio m-line (index 0) を確定させる。
        const { a, b, inactive, inactiveMid } = await c.given(
          createCommittedInactiveAudioPeers(),
        );
        const kept = {
          mid: inactiveMid,
          mLineIndex: 0,
          currentDirection: "inactive",
          stopping: false,
          stopped: false,
        };
        expect(inactive.currentDirection).toEqual("inactive");
        a.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
          direction: "sendonly",
        });
        await c.offer(a, { hold: true });

        // Act: audio を追加した remote offer を answerer に適用する。
        await c.setRemote(b, a.localDescription);

        // Assert: 新しい m-line には新しい transceiver が作られ、inactive な transceiver の枠は奪われない。
        expect(inactive).toMatchObject(kept);
        expect(b.getTransceivers()[0]).toBe(inactive);
        const added = b.getTransceivers()[1];
        expect(added).not.toBe(undefined);
        expect(added.mid).not.toBe(inactiveMid);
        expect(added.mLineIndex).toEqual(1);

        await c.setRemote(b, "rollback");

        // Assert: rollback 後も inactive な transceiver はそのまま残る。
        expect(inactive).toMatchObject(kept);
        expect(b.getTransceivers()[0]).toBe(inactive);
        expect(b.getTransceivers()).toEqual([inactive]);

        // Act: 同じ offer を適用し直し、answer で確定する。
        await c.setRemote(b, a.localDescription);
        await c.answer(b);

        // Assert: 確定後も inactive な m-line は元の transceiver のまま、追加分は 2 本目の m-line。
        expect(inactive).toMatchObject(kept);
        expect(b.getTransceivers()[0]).toBe(inactive);
        expect(b.getTransceivers().length).toEqual(2);
        expect(b.getTransceivers()[1].mLineIndex).toEqual(1);
      },
    );

    negotiationCase(
      "[2.4-7] an unassociated inactive addTransceiver() is associated by a remote offer only within the documented constraint and keeps its direction",
      { ref: "2.4-7" },
      async (c) => {
        // Arrange: answerer の app が inactive な未関連付けの audio transceiver を持つ。
        const { a, b } = await c.given(createUnnegotiatedPeers());
        const appInactive = b.addTransceiver("audio", {
          direction: "inactive",
        });
        a.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
          direction: "sendonly",
        });
        await c.offer(a, { hold: true });

        // Act: audio の remote offer を適用する。
        await c.setRemote(b, a.localDescription);

        // Assert: 既知の制約 (6 章) どおり app の transceiver に関連付けるが、app が選んだ inactive は remote offer で変えず、別の transceiver も作らない。
        expect(b.getTransceivers()).toEqual([appInactive]);
        expect(appInactive.mid).toBe(a.getTransceivers()[0].mid);
        expect(appInactive.direction).toEqual("inactive");

        await c.setRemote(b, "rollback");

        // Assert: app の transceiver は未関連付けに戻り、inactive のまま残る。
        expect(b.getTransceivers()).toEqual([appInactive]);
        expect(appInactive.mid).toBe(null);
        expect(appInactive.direction).toEqual("inactive");

        // Act: 同じ offer に answer する。
        await c.setRemote(b, a.localDescription);
        const answer = await b.createAnswer();

        // Assert: answer の m-line は app の inactive を反映する (受信方向を奪わない)。
        expect(answer.sdp).toMatch(/^a=inactive\r?$/m);
        await c.setLocal(b, answer);
        await c.setRemote(a, b.localDescription);
        expect(appInactive.currentDirection).toEqual("inactive");
      },
    );

    negotiationCase(
      "[2.5-17] a rolled-back local offer leaves no pendingLocalOfferCodecs and the next offer resolves as before",
      { ref: "2.5-17" },
      async (c) => {
        // Arrange: VP8 + H264 で確定した session (setCodecPreferences なし)。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers({
            codecs: { video: [useVP8(), useH264()] },
          }),
        );
        const transceiver = a.getTransceivers()[0];
        const baseline = {
          pending: transceiver.pendingLocalOfferCodecs,
          needsResolution: transceiver.codecPreferencesNeedResolution,
          codecs: transceiver.codecs.map((codec) => codec.payloadType),
        };
        const offer = await a.createOffer();

        await c.setLocal(a, offer);

        // Assert: 適用中は offer の codec を pendingLocalOfferCodecs に持つ。
        expect(
          transceiver.pendingLocalOfferCodecs?.map(
            (codec) => codec.payloadType,
          ),
        ).toEqual(
          SessionDescription.parse(offer.sdp).media[0].rtp.codecs.map(
            (codec) => codec.payloadType,
          ),
        );

        await c.setLocal(a, "rollback");

        // Assert: rolled-back offer の pendingLocalOfferCodecs と再解決要求は baseline に戻る。
        expect(transceiver.pendingLocalOfferCodecs).toEqual(baseline.pending);
        expect(transceiver.codecPreferencesNeedResolution).toBe(
          baseline.needsResolution,
        );
        expect(transceiver.codecs.map((codec) => codec.payloadType)).toEqual(
          baseline.codecs,
        );

        // Assert: 次の offer は rollback 前と同じ codec を提案し、確定後も RTP が届く。
        const next = await a.createOffer();
        expect(offeredVideoCodecs(next.sdp)).toEqual(
          offeredVideoCodecs(offer.sdp),
        );
        await c.setLocal(a, next);
        await c.setRemote(b, a.localDescription);
        await c.answer(b);
        await c.rtp(outgoing, incoming);
      },
    );

    negotiationCase(
      "[2.5-17] a rolled-back remote offer restores the re-resolution request an unapplied createOffer consumed while it was pending",
      { ref: "2.5-17" },
      async (c) => {
        // Arrange: createAnswer 後の addTrack で、answer の H264 を commit しつつ再解決要求が残った answerer。
        const { a, b, transceiver } = await c.given(createH264OnlyReoffer());
        const answer = await b.createAnswer();
        b.addTrack(new MediaStreamTrack({ kind: "video" }));
        await c.setLocal(b, answer);
        await c.setRemote(a, b.localDescription);
        expect(transceiver.codecPreferencesNeedResolution).toBe(true);
        const baselineCodecs = transceiver.codecs.map(
          (codec) => codec.payloadType,
        );
        await c.offer(a);

        // Act: remote offer の pending 中に自分の offer を作る (適用しない。再解決要求を消費する)。
        const unapplied = await b.createOffer();

        // Assert: 未適用の createOffer で再解決要求は消費され、codec は解決し直されている。
        expect(offeredVideoCodecs(unapplied.sdp)).toEqual(["VP8", "H264"]);
        expect(transceiver.codecPreferencesNeedResolution).toBe(false);

        await c.rollback(b);

        // Assert: pending 中に消費した再解決要求と解決済み codec は baseline に戻る。
        expect(transceiver.codecPreferencesNeedResolution).toBe(true);
        expect(transceiver.codecs.map((codec) => codec.payloadType)).toEqual(
          baselineCodecs,
        );
        expect(transceiver.pendingLocalOfferCodecs).toEqual(undefined);

        // Assert: 次の自分の offer は設定から解決し直す (VP8 と H264)。
        const next = await b.createOffer();
        expect(offeredVideoCodecs(next.sdp)).toEqual(["VP8", "H264"]);
      },
    );

    negotiationCase(
      "[2.6-T1b] the configured SCTP MTU is kept when SCTP moves to another DTLS transport, on rollback and at the answer",
      { ref: "2.6-T1b" },
      async (c) => {
        // Arrange: MTU を設定した answerer が先に DataChannel を作り (SCTP は自分の transport)、video と DataChannel を同じ BUNDLE にした offer を受ける。
        const { a, b } = await c.given(
          createPeerPair({}, { sctp: { mtu: 1052 } }),
        );
        a.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
          direction: "sendonly",
        });
        const channel = a.createDataChannel("mtu");
        b.createDataChannel("answerer-own");
        const sctp = b.sctpTransport!;
        const ownTransport = sctp.dtlsTransport;
        expect(sctp.sctp.mtu).toEqual(1052);
        await c.offer(a, { hold: true });

        // Act: remote offer を適用する (SCTP は BUNDLE tag の video の transport へ移る)。
        await c.setRemote(b, a.localDescription);

        // Assert: 別 DTLS transport へ移った SCTP も設定の MTU を使う。
        expect(b.sctpTransport).toBe(sctp);
        expect(sctp.dtlsTransport).not.toBe(ownTransport);
        expect(sctp.sctp.mtu).toEqual(1052);

        await c.setRemote(b, "rollback");

        // Assert: 元の DTLS transport に戻した SCTP も設定の MTU を使う。
        expect(b.sctpTransport!.dtlsTransport).toBe(ownTransport);
        expect(b.sctpTransport!.sctp.mtu).toEqual(1052);

        // Act: 同じ offer を適用し直して answer で確定する。
        const remote = c.start(
          b.onDataChannel.watch((dataChannel) => dataChannel.label === "mtu"),
        );
        await c.setRemote(b, a.localDescription);
        await c.answer(b);

        // Assert: 確定した SCTP も設定の MTU で、DataChannel が実際に届く。
        expect(b.sctpTransport!.sctp.mtu).toEqual(1052);
        const [received] = await remote;
        await c.data(channel, received);
        c.invariants();
      },
    );

    negotiationCase(
      "[2.6-T4e] answering with a track source codec does not adopt it into the configured codecs",
      { ref: "2.6-T4e" },
      async (c) => {
        // Arrange: VP8 → H264 の順に設定し、H264 source の track を addTrack した answerer が VP8/H264 の offer を受ける。
        const { a, b } = await c.given(
          createPeerPair(
            { codecs: { video: [useVP8(), useH264()] } },
            { codecs: { video: [useVP8(), useH264()] } },
          ),
        );
        const offererOut = new MediaStreamTrack({ kind: "video" });
        const offererTransceiver = a.addTransceiver(offererOut, {
          direction: "sendrecv",
        });
        const h264Source = new MediaStreamTrack({
          kind: "video",
          codec: useH264(),
        });
        const answererSender = b.addTrack(h264Source);
        const answererTransceiver = b.getTransceivers()[0];
        expect(answererTransceiver.sender).toBe(answererSender);
        const configured = () =>
          b
            .getConfiguration()
            .codecs.video!.map(
              (codec) => `${codec.mimeType}/${codec.payloadType}`,
            );
        const before = configured();
        await c.offer(a, { hold: true });
        expect(offeredVideoCodecs(a.localDescription!.sdp)).toEqual([
          "VP8",
          "H264",
        ]);

        // Act: remote offer を適用し、answer を作って両側に適用する。
        await c.setRemote(b, a.localDescription);
        const answer = await c.answer(b);
        await waitForPeersConnected(a, b);

        // Assert: answer は develop の規則 (track source との積) で H264 だけを答え、事前検証は拒否しない。
        expect(b.getTransceivers()).toEqual([answererTransceiver]);
        expect(offeredVideoCodecs(answer.sdp)).toEqual(["H264"]);
        expect(answererTransceiver.sender.codec?.name.toUpperCase()).toEqual(
          "H264",
        );

        // Assert: track の codec は設定へ採用されず、設定の codec 順と PT は変わらない。
        expect(configured()).toEqual(before);

        // Assert: H264 で双方向に届く。
        await c.rtp(h264Source, offererTransceiver.receiver.track);
        await c.rtp(offererOut, answererTransceiver.receiver.track);
      },
    );

    negotiationCase(
      "[2.6-T4g] a remote answer keeps the answerer's codec order for the offerer's codecs and sender",
      { ref: "2.6-T4g" },
      async (c) => {
        // Arrange: offerer は VP8 → H264、answerer は H264 → VP8 の順で設定する。
        const { a, b } = await c.given(
          createPeerPair(
            { codecs: { video: [useVP8(), useH264()] } },
            { codecs: { video: [useH264(), useVP8()] } },
          ),
        );
        const outgoing = new MediaStreamTrack({ kind: "video" });
        const transceiver = a.addTransceiver(outgoing, {
          direction: "sendonly",
        });
        await c.offer(a, { hold: true });
        expect(offeredVideoCodecs(a.localDescription!.sdp)).toEqual([
          "VP8",
          "H264",
        ]);
        await c.setRemote(b, a.localDescription);
        await c.answer(b, { hold: true });

        // Act: H264 → VP8 の answer を offerer に remote answer として適用する。
        await c.setRemote(a, b.localDescription);
        await waitForPeersConnected(a, b);

        // Assert: offerer の確定 SDP・transceiver の codec・送信 codec は answer の順 (H264 先頭) を保つ。
        expect(offeredVideoCodecs(a.currentRemoteDescription!.sdp)).toEqual([
          "H264",
          "VP8",
        ]);
        expect(
          transceiver.codecs
            .map((codec) => codec.name.toUpperCase())
            .filter((name) => name !== "RTX"),
        ).toEqual(["H264", "VP8"]);
        expect(transceiver.sender.codec?.name.toUpperCase()).toEqual("H264");

        // Assert: answer の順の codec で RTP が届く。
        await c.rtp(outgoing, b.getTransceivers()[0].receiver.track);
      },
    );

    negotiationCase.for([
      { negotiated: "with", rewritten: "without", reached: true },
      { negotiated: "without", rewritten: "with", reached: false },
    ] as const)(
      "[5-7] PLI follows the receive codec table $negotiated NACK/PLI, not a remote track codec rewritten $rewritten it",
      { ref: "5-7" },
      async (c, row) => {
        // Arrange: NACK/PLI を交渉した (または交渉しない) session で、受信 track の codec を逆の feedback に書き換える。
        const { a, b, incoming } = await c.given(
          createConnectedVideoPeers(
            row.negotiated === "with" ? {} : videoWithoutFeedback,
          ),
        );
        const sender = a.getTransceivers()[0].sender;
        const receiver = b.getTransceivers()[0].receiver;
        if (row.negotiated === "with") setTrackFeedback(incoming, []);
        if (row.negotiated === "without") {
          setTrackFeedback(incoming, [useNACK(), usePLI()]);
        }

        const reached = await pliReaches(receiver, sender);

        // Assert: PLI の可否は track の codec ではなく、受信 codec 表 (current SDP) の feedback に従う。
        expect(reached).toBe(row.reached);
        c.invariants(b);
      },
    );
  },
);
