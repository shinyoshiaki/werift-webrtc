import {
  MediaStreamTrack,
  type RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCRtpReceiver,
  type RTCRtpSender,
  type RtpPacket,
  SessionDescription,
  useH264,
  useNACK,
  usePLI,
  useREMB,
  useSdesMid,
  useSdesRTPStreamId,
  useTWCC,
  useTransportWideCC,
  useVP8,
} from "../../../src";
import type { RTCDtlsTransport as DtlsTransport } from "../../../src/transport/dtls";
import {
  answerRemoteOffer,
  createBundlePairWithOutsideReoffer,
} from "../../issue/705.helpers";
import {
  ANSWER_OR_ROLLBACK,
  describeCases,
  negotiationCase,
} from "../harness/negotiationCase";
import {
  createCommittedInactiveAudioPeers,
  createConnectedVideoPeers,
  createConnectedVideoPeersWith,
  createConnectedVideoPeersWithRtx,
  createH264OnlyReoffer,
  createInitialPranswerConnection,
  createPeerPair,
  createSimulcastPeers,
  createUnnegotiatedPeers,
  createVp8H264AnsweringPeers,
  extmapId,
  mungeSection,
  offeredVideoCodecs,
  payloadTypeOf,
  pliReaches,
  receiveCodecNames,
  recordSenderFeedback,
  rewriteVideoFeedback,
  sendRawRtp,
  setExtmapId,
  twccFeedbackSent,
  videoWithoutFeedback,
  waitForPeersConnected,
  watchRtpText,
  withRtcpFeedback,
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

/** How many SSRC / RID routes of `pc`'s router lead to `endpoint`. */
const routesTo = (pc: RTCPeerConnection, endpoint: RTCRtpReceiver) => {
  const { router } = pc as unknown as {
    router: {
      ssrcTable: Record<number, unknown>;
      ridTable: Record<string, unknown>;
    };
  };
  return [
    ...Object.values(router.ssrcTable),
    ...Object.values(router.ridTable),
  ].filter((e) => e === endpoint).length;
};

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
 * Act: one RTX packet with `header` whose payload is the original
 * sequence number `osn` (2 bytes) + `text`; resolves with the track
 * of `receiver` that got the repaired packet and that packet.
 */
const sendRtx = async (
  transport: DtlsTransport,
  receiver: RTCRtpReceiver,
  header: { ssrc: number; payloadType: number; sequenceNumber: number },
  osn: number,
  text: string,
): Promise<{ track: MediaStreamTrack; packet: RtpPacket }> => {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(osn);
  const received = watchRtpText(receiver.tracks, text);
  await sendRawRtp(
    transport,
    header,
    Buffer.concat([prefix, Buffer.from(text)]),
  );
  return received;
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
      "[2.4-5] transport-cc feedback a re-offer adds starts only at the answer commit",
      { ref: "2.4-5" },
      async (c) => {
        // Arrange: transport-cc の header extension は交渉済みだが、current の VP8 は transport-cc feedback を持たない。
        const { a, b, outgoing, receiver } = await c.given(
          createConnectedVideoPeersWith({
            offerer: {
              codecs: { video: [useVP8()] },
              headerExtensions: { video: [useTransportWideCC()] },
            },
            answerer: {
              codecs: {
                video: [
                  useVP8({
                    rtcpFeedback: [useNACK(), usePLI(), useREMB(), useTWCC()],
                  }),
                ],
              },
              headerExtensions: { video: [useTransportWideCC()] },
            },
          }),
        );
        expect(receiver.receiverTWCC).toEqual(undefined);
        await c.offer(a, { hold: true });
        const withTwcc = withRtcpFeedback(
          a.localDescription!.sdp,
          "VP8",
          "transport-cc",
        );

        // Act: VP8 に transport-cc を足した re-offer を answerer に適用する (answer はまだ)。
        await c.setRemote(b, withTwcc, { type: "offer" });

        // Assert: pending 中は current の RTP に TWCC を始めず、feedback も送らない。
        expect(await twccFeedbackSent(outgoing, receiver)).toBe(false);
        expect(receiver.receiverTWCC).toEqual(undefined);

        // Act: answer で確定する。
        await c.answer(b);

        // Assert: commit で TWCC が始まり、受信した RTP への transport-cc feedback を session に送る。
        expect(b.currentLocalDescription!.sdp).toMatch(
          /^a=rtcp-fb:\d+ transport-cc/m,
        );
        expect(receiver.receiverTWCC).not.toEqual(undefined);
        expect(await twccFeedbackSent(outgoing, receiver)).toBe(true);
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

        // Act: 両側で rollback する。
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

        // Act: rollback する。
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
      "[2.4-7] a remote offer that puts a new MID on a committed inactive (not rejected) m-line does not take it",
      { ref: "2.4-7" },
      async (c) => {
        // Arrange: inactive な audio m-line (index 0、port 0 ではない) を確定させ、その位置に別の MID の sendonly audio を置いた offer を作る (拒否済みでない m-line の再利用)。
        const { a, b, inactive, inactiveMid } = await c.given(
          createCommittedInactiveAudioPeers(),
        );
        const current = b.currentRemoteDescription!.sdp;
        const offer = await a.createOffer();
        const recycled = mungeSection(offer.sdp, inactiveMid, (section) =>
          section
            .replace(/^a=mid:\S+/m, "a=mid:recycled")
            .replace(/^a=inactive/m, "a=sendonly"),
        ).replace(/^a=group:BUNDLE [^\r\n]+/m, "a=group:BUNDLE recycled");
        expect(SessionDescription.parse(recycled).media[0].port).not.toEqual(0);

        // Act: remote offer として適用する (受理でも拒否でもよい)。
        const outcome = await b
          .setRemoteDescription({ type: "offer", sdp: recycled })
          .then(
            () => "accepted",
            (error: Error) => error.name,
          );

        // Assert: remote offer のための transceiver は inactive な transceiver の枠を奪わない (停止も置き換えもされず、MID と m-line の位置を保つ)。
        expect(b.getTransceivers()).toContain(inactive);
        expect(inactive).toMatchObject({
          mid: inactiveMid,
          mLineIndex: 0,
          stopped: false,
          stopping: false,
        });

        // Assert: 拒否するなら状態を変えない (受理なら比較しない)。
        expect(outcome === "accepted" ? "stable" : b.signalingState).toEqual(
          "stable",
        );
        expect(
          outcome === "accepted" ? current : b.currentRemoteDescription!.sdp,
        ).toBe(current);
        c.invariants(b);
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

        // Act: rollback する。
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

        // Act: local offer を適用する。
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

        // Act: rollback する。
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

        // Act: remote offer を rollback する。
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

        // Act: rollback する。
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

    negotiationCase(
      "[2.8-36] a remote-created transceiver the application keeps returns to its created codecs and has no routes after rollback",
      { ref: "2.8-36" },
      async (c) => {
        // Arrange: 初回 pranswer で remote 起因の transceiver に codec・受信経路が付いている。
        const { b, remoteCreated } = await c.given(
          createInitialPranswerConnection(),
        );
        expect(remoteCreated.codecs.length).toBeGreaterThan(0);
        expect(routesTo(b, remoteCreated.receiver)).toBeGreaterThan(0);

        // Act: answerer で remote offer を rollback する。
        await c.setRemote(b, "rollback");

        // Assert: app が使う transceiver は残り、作成時の状態 (MID・direction・codec なし) に戻る。
        expect(b.getTransceivers()).toContain(remoteCreated);
        expect(remoteCreated).toMatchObject({
          mid: null,
          currentDirection: null,
          direction: "recvonly",
          codecs: [],
        });
        expect(remoteCreated.sender.codec).toEqual(undefined);
        expect(remoteCreated.receiver.snapshotReceiveTables()).toEqual({
          codecs: {},
          ssrcByRtx: {},
          stagedCodecs: {},
          stagedSsrcByRtx: {},
        });

        // Assert: 受信経路 (SSRC / MID+RID) はどれもその receiver を指さない。
        expect(routesTo(b, remoteCreated.receiver)).toEqual(0);
      },
    );

    negotiationCase(
      "[2.8-39] rolling back a first pranswer returns both peers' send and receive codecs to the unnegotiated state",
      { ref: "2.8-39" },
      async (c) => {
        // Arrange: answerer は H264 だけを選んだ answer を初回 pranswer として両側に適用し、H264 で通信する。
        const {
          a,
          b,
          offererOut,
          answererOut,
          offererTransceiver,
          answererTransceiver,
        } = await c.given(createVp8H264AnsweringPeers());
        answererTransceiver.setCodecPreferences([useH264()]);
        await c.pranswer(b);
        await waitForPeersConnected(a, b);
        expect(offererTransceiver.sender.codec?.name.toUpperCase()).toEqual(
          "H264",
        );
        expect(answererTransceiver.sender.codec?.name.toUpperCase()).toEqual(
          "H264",
        );
        await c.rtp(offererOut, answererTransceiver.receiver.track);

        // Act: 両側で初回交渉を rollback する。
        await c.rollback(b);

        // Assert: 送信 codec と受信表は pranswer 前 (未交渉) に戻る。
        expect(offererTransceiver.sender.codec).toEqual(undefined);
        expect(receiveCodecNames(offererTransceiver.receiver)).toEqual({});
        expect(answererTransceiver.sender.codec).toEqual(undefined);
        expect(receiveCodecNames(answererTransceiver.receiver)).toEqual({});

        // Act: 改めて preference なしで交渉する。
        answererTransceiver.setCodecPreferences([]);
        await c.offer(a);
        const answererSide = b.getTransceivers()[0];
        answererSide.setDirection("sendrecv");
        await answererSide.sender.replaceTrack(answererOut);
        await c.answer(b);
        await waitForPeersConnected(a, b);

        // Assert: 新しい交渉は VP8 で確定し、invariant を満たして届く。
        expect(offererTransceiver.sender.codec?.name.toUpperCase()).toEqual(
          "VP8",
        );
        await c.rtp(offererOut, answererSide.receiver.track);
      },
    );

    negotiationCase(
      "[5-7] PLI stays negotiated after a rolled-back re-offer that removes NACK/PLI for the same SSRC",
      { ref: "5-7" },
      async (c) => {
        // Arrange: 接続済み session は PLI を交渉済みで、実際に届く。
        const { a, b } = await c.given(createConnectedVideoPeers());
        const sender = a.getTransceivers()[0].sender;
        const receiver = b.getTransceivers()[0].receiver;
        expect(await pliReaches(receiver, sender)).toBe(true);

        // Act: 同じ SSRC の VP8 から NACK/PLI を外した re-offer を pending にする。
        await c.offer(a, { hold: true });
        await c.setRemote(
          b,
          rewriteVideoFeedback(a.localDescription!.sdp, "remove"),
          { type: "offer" },
        );

        // Assert: pending 中は current の受信 codec のまま PLI が届く。
        expect(await pliReaches(receiver, sender)).toBe(true);

        // Act: 両側で rollback する。
        await c.rollback(b);

        // Assert: rollback 後も current の設定に戻ったまま PLI が届く。
        expect(await pliReaches(receiver, sender)).toBe(true);
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

        // Act: PLI を要求する。
        const reached = await pliReaches(receiver, sender);

        // Assert: PLI の可否は track の codec ではなく、受信 codec 表 (current SDP) の feedback に従う。
        expect(reached).toBe(row.reached);
        c.invariants(b);
      },
    );

    negotiationCase.for(ANSWER_OR_ROLLBACK)(
      "[5-13] RTX packets resolve to the current media SSRC while a re-pairing is pending and after $finish",
      { ref: "5-13" },
      async (c, { finish }) => {
        // Arrange: RTX 付きで接続済み。FID の RTX SSRC はそのまま、対のメディア SSRC を変えた re-offer を作る。
        const { a, b, incoming } = await c.given(
          createConnectedVideoPeersWithRtx(),
        );
        const offer = await a.createOffer();
        const [, mediaSsrc, rtxSsrc] = offer.sdp
          .match(/^a=ssrc-group:FID (\d+) (\d+)/m)!
          .map(Number);
        const rtxPt = payloadTypeOf(offer.sdp, "rtx");
        const repaired = offer.sdp.split(String(mediaSsrc)).join("999333");
        const transport = a.getTransceivers()[0].dtlsTransport;
        const receiver = b.getTransceivers()[0].receiver;

        // Act: RTX の対応を変える remote offer を適用し、RTX パケットを送る。
        await c.setRemote(b, repaired, { type: "offer" });
        const pending = await sendRtx(
          transport,
          receiver,
          { ssrc: rtxSsrc, payloadType: rtxPt, sequenceNumber: 3001 },
          3000,
          `rtx-pending-${finish}`,
        );

        // Assert: pending 中は current の対応のメディア SSRC として current の track に届く。
        expect(pending.packet.header.ssrc).toEqual(mediaSsrc);
        expect(pending.track).toBe(incoming);

        // Act: answer で確定する、または rollback してから RTX を送る。
        await c.finish(b, finish);
        const after = await sendRtx(
          transport,
          receiver,
          { ssrc: rtxSsrc, payloadType: rtxPt, sequenceNumber: 3002 },
          3001,
          `rtx-after-${finish}`,
        );

        // Assert: 確定後は新しい対のメディア SSRC、rollback 後は元の SSRC として復元される。
        if (finish === "answer") {
          expect(after.packet.header.ssrc).toEqual(999333);
          expect(after.track).toBe(receiver.trackBySSRC[999333]);
        } else {
          expect(after.packet.header.ssrc).toEqual(mediaSsrc);
          expect(after.track).toBe(receiver.trackBySSRC[mediaSsrc]);
          expect(after.track).toBe(incoming);
        }
        c.invariants(b);
      },
    );

    negotiationCase(
      "[5-13] RTP that carries a header extension under its new id arrives after the answer commits the move",
      { ref: "5-13" },
      async (c) => {
        // Arrange: RID 拡張の URI を未使用の ID 12 へ移した re-offer を answerer に適用する。
        const { a, b, firstMid } = await c.given(createSimulcastPeers());
        const created = await a.createOffer();
        const offer = setExtmapId(created.sdp, useSdesRTPStreamId().uri, 12);
        expect(offer).toContain(`a=extmap:12 ${useSdesRTPStreamId().uri}`);
        await c.setRemote(b, offer, { type: "offer" });
        const current = b.currentRemoteDescription!.sdp;
        const midExtensionId = extmapId(current, useSdesMid().uri);
        const payloadType = payloadTypeOf(current, "VP8");

        // Act: answer で確定し、新しい ID 12 で RID を載せた RTP を送る。
        await c.finish(b, "answer");
        const track = b.getTransceivers()[0].receiver.trackByRID.high;
        const received = c.start(watchRtpText([track], "new-extension-id"));
        await sendRawRtp(
          a.getTransceivers()[0].dtlsTransport,
          {
            ssrc: 7777,
            payloadType,
            sequenceNumber: 500,
            extensions: [
              { id: midExtensionId, payload: Buffer.from(firstMid) },
              { id: 12, payload: Buffer.from("high") },
            ],
          },
          Buffer.from("new-extension-id"),
        );

        // Assert: 新しい ID の RID で high 層の track に届く。
        await received;
        c.invariants(b);
      },
    );

    negotiationCase(
      "[5-K14] an m-line outside the offered BUNDLE group offered with a=setup:active is answered passive (RFC 8842 section 5.3)",
      {
        ref: "5-K14",
        exempt:
          "the 705 helper's offer misdescribes the outside m-line ICE credentials (outsideufrag) the callee does not use, so the caller cannot continue",
        explicitInvariants: true,
      },
      async (c) => {
        // Arrange: 初回 offerer (DTLS server) の caller に、callee が group 外の audio を a=setup:active で提案する re-offer を用意する (705 helper の actpass を active にする)。
        const { caller, outsideMid, outsideOffer } = await c.given(
          createBundlePairWithOutsideReoffer({ reofferFrom: "callee" }),
        );
        const activeOffer = mungeSection(outsideOffer, outsideMid, (section) =>
          section.replace(/^a=setup:actpass/m, "a=setup:active"),
        );
        expect(activeOffer).not.toEqual(outsideOffer);

        // Act: re-offer に answer して確定する。
        const answer = await answerRemoteOffer(caller, activeOffer);

        // Assert: group 外の m-line は offer の逆の passive で答え、その独立 transport は server になる。
        expect(
          SessionDescription.parse(answer).media.find(
            (media) => media.rtp.muxId === outsideMid,
          )!.dtlsParams?.role,
        ).toEqual("server");
        expect(answer).toMatch(/^a=setup:passive\r?$/m);
        expect(
          caller.getTransceivers().map((t) => [t.mid, t.dtlsTransport.role]),
        ).toEqual([
          ["0", "server"],
          ["1", "server"],
          [outsideMid, "server"],
        ]);
      },
    );
  },
);
