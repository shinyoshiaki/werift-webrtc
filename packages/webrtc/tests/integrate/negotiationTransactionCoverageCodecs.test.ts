import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useAbsSendTime,
  useH264,
  useNACK,
  usePLI,
  useREMB,
  useSdesMid,
  useSdesRTPStreamId,
  useTWCC,
  useTransportWideCC,
  useVP8,
} from "../../src";
import {
  answerRemoteOffer,
  closeAll,
  createBundlePairWithOutsideReoffer,
  parseSdp,
} from "../issue/705.helpers";
import {
  assertNegotiationInvariants,
  createCommittedInactiveAudioPeers,
  createConnectedSendParamPeers,
  createConnectedVideoPeers,
  createConnectedVideoPeersWith,
  createConnectedVideoPeersWithRtx,
  createH264OnlyReoffer,
  createInitialPranswerConnection,
  createSimulcastPeers,
  createTwccH264OnlyReoffer,
  createUnnegotiatedPeers,
  createVp8H264AnsweringPeers,
  createVp8RtxSessionWithH264Reoffer,
  enforceSessionContinuation,
  exemptFromContinuation,
  expectSessionContinues,
  mungeSection,
  offeredVideoCodecs,
  payloadTypeOf,
  pliReaches,
  receiveCodecNames,
  recordSenderFeedback,
  rewriteVideoFeedback,
  sendAndExpectData,
  sendAndExpectRtp,
  sendRawRtp,
  twccFeedbackSent,
  videoWithoutFeedback,
  waitForPeersConnected,
  watchRtpText,
  withRtcpFeedback,
  withoutCodecs,
  withoutExtmap,
} from "./negotiationTransactionUtils";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spec coverage for codecs, RTCP feedback, routing keys and the develop
 * features inside the negotiation transaction (ticket 0ad06d37 sections
 * 2.4 / 2.5 / 2.6 / 2.8 / 5). Each test name starts with its requirement ID.
 */
describe(
  "negotiation transaction spec coverage: codecs and feedback",
  // 各テストの最後に session の継続 (再交渉 4 回と RTP / DataChannel の確認) を検証するため長めにする。
  { timeout: 60_000 },
  () => {
    enforceSessionContinuation();

    test("[2.4-T7b] NACK, transport-cc and PLI follow the codec of each packet, not the lowest payload type", async () => {
      // Arrange: H264 (feedback なし) が小さい PT、VP8 (NACK・PLI・transport-cc) が大きい PT。
      const { offerer, answerer, incoming } = await createConnectedVideoPeers({
        codecs: {
          video: [
            useH264({ rtcpFeedback: [] }),
            useVP8({ rtcpFeedback: [useNACK(), usePLI(), useTWCC()] }),
          ],
        },
      });
      try {
        const [transceiver] = offerer.getTransceivers();
        const sender = transceiver.sender;
        const receiver = answerer.getTransceivers()[0].receiver;
        const sdp = answerer.currentRemoteDescription!.sdp;
        const h264 = payloadTypeOf(sdp, "H264");
        const vp8 = payloadTypeOf(sdp, "VP8");
        expect(h264).toBeLessThan(vp8);
        const feedback = recordSenderFeedback(sender);
        const sendWithGap = async (payloadType: number, first: number) => {
          for (const sequenceNumber of [first, first + 1, first + 4]) {
            const text = `t7b-${payloadType}-${sequenceNumber}`;
            const received = watchRtpText([incoming], text);
            await sendRawRtp(
              transceiver.dtlsTransport,
              { ssrc: sender.ssrc, payloadType, sequenceNumber },
              Buffer.from(text),
            );
            await received;
          }
        };

        try {
          // Act: feedback のない H264 の PT で、欠落 (seq の飛び) を含む RTP を送る。
          await sendWithGap(h264, 1000);
          await sleep(200);

          // Assert: H264 のパケットでは NACK も transport-cc も始まらず、PLI も送らない。
          expect(feedback.record.nacks).toEqual([]);
          expect(receiver.receiverTWCC).toBeUndefined();
          expect(receiver.pliNegotiation(sender.ssrc)).toEqual({
            payloadType: h264,
            allowed: false,
          });
          expect(await pliReaches(receiver, sender)).toBe(false);

          // Act: 同じ SSRC で NACK・PLI・transport-cc を持つ VP8 の PT の RTP を欠落付きで送る。
          await sendWithGap(vp8, 2000);
          const deadline = Date.now() + 1000;
          while (feedback.record.nacks.length === 0 && Date.now() < deadline) {
            await sleep(20);
          }

          // Assert: VP8 のパケットの欠落には NACK が相手 sender に届き、PLI も届く。
          expect(feedback.record.nacks.flat()).toEqual(
            expect.arrayContaining([2002, 2003]),
          );
          expect(receiver.pliNegotiation(sender.ssrc)).toEqual({
            payloadType: vp8,
            allowed: true,
          });
          expect(await pliReaches(receiver, sender)).toBe(true);
          // Assert: transport-cc も最小 PT (H264) ではなく、VP8 のパケットで開始する。
          expect(receiver.receiverTWCC).toBeDefined();
          assertNegotiationInvariants(answerer);
        } finally {
          feedback.stop();
        }
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "t7b");
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test("[2.4-4] a remote pranswer that changes codec, RTX, RED and header extensions of the senders is fully undone by rollback", async () => {
      // Arrange: video (VP8+RTX、H264) と audio (RED+Opus) を送り、両方に MID と abs-send-time を交渉した session。
      const { offerer, answerer, outgoing, incoming } =
        await createConnectedSendParamPeers();
      try {
        const [video, audio] = offerer.getTransceivers();
        const before = [video, audio].map((t) => t.sender.snapshotSendParams());
        const absSendTime = useAbsSendTime().uri;
        expect(before[0].codec?.name.toUpperCase()).toBe("VP8");
        expect(before[0].rtxPayloadType).toBeDefined();
        expect(before[1].redRedundantPayloadType).toBeDefined();
        expect(before[0].headerExtensions.map((e) => e.uri)).toContain(
          absSendTime,
        );
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);
        const answer = (await answerer.createAnswer()).sdp;
        // pranswer: video は VP8 (と その RTX) を外して H264、audio は RED を外して Opus、abs-send-time なし。
        const pranswer = withoutExtmap(
          withoutCodecs(withoutCodecs(answer, "video", ["VP8"]), "audio", [
            "red",
          ]),
          absSendTime,
        );

        // Act: 送信パラメータを変える remote pranswer を offerer に適用する。
        await offerer.setRemoteDescription({ type: "pranswer", sdp: pranswer });

        // Assert: 再交渉の pranswer は送信パラメータを暫定的に pranswer の値にする (2.10)。
        const pending = [video, audio].map((t) =>
          t.sender.snapshotSendParams(),
        );
        expect(pending[0].codec?.name.toUpperCase()).toBe("H264");
        expect(pending[0].rtxPayloadType).toBeUndefined();
        expect(pending[0].headerExtensions.map((e) => e.uri)).not.toContain(
          absSendTime,
        );
        expect(pending[1].codec?.name.toLowerCase()).toBe("opus");
        expect(pending[1].redRedundantPayloadType).toBeUndefined();
        assertNegotiationInvariants(offerer);

        // Act: 両側で rollback する。
        await offerer.setLocalDescription({ type: "rollback" });
        await answerer.setRemoteDescription({ type: "rollback" });

        // Assert: codec・RTX・RED・header extension・MID・RID を含む送信パラメータが適用前と完全に一致する。
        expect(video.sender.snapshotSendParams()).toEqual(before[0]);
        expect(audio.sender.snapshotSendParams()).toEqual(before[1]);
        assertNegotiationInvariants(offerer);
        assertNegotiationInvariants(answerer);
        // Assert: current の VP8 で RTP が届く。
        await sendAndExpectRtp(outgoing, incoming, "send-params-restored");
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(
          offerer,
          answerer,
          "pranswer-rollback-params",
        );
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test("[2.4-5] transport-cc feedback a re-offer adds starts only at the answer commit", async () => {
      // Arrange: transport-cc の header extension は交渉済みだが、current の VP8 は transport-cc feedback を持たない。
      const { offerer, answerer, outgoing, sender, receiver, close } =
        await createConnectedVideoPeersWith({
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
        });
      try {
        expect(receiver.receiverTWCC).toBeUndefined();
        await offerer.setLocalDescription(await offerer.createOffer());
        const withTwcc = withRtcpFeedback(
          offerer.localDescription!.sdp,
          "VP8",
          "transport-cc",
        );

        // Act: VP8 に transport-cc を足した re-offer を answerer に適用する (answer はまだ)。
        await answerer.setRemoteDescription({ type: "offer", sdp: withTwcc });

        // Assert: pending 中は current の RTP に TWCC を始めず、feedback も送らない。
        expect(await twccFeedbackSent(outgoing, receiver)).toBe(false);
        expect(receiver.receiverTWCC).toBeUndefined();
        assertNegotiationInvariants(answerer);

        // Act: answer で確定する。
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);

        // Assert: commit で TWCC が始まり、受信した RTP への transport-cc feedback を session に送る。
        expect(answerer.currentLocalDescription!.sdp).toMatch(
          /^a=rtcp-fb:\d+ transport-cc/m,
        );
        expect(receiver.receiverTWCC).toBeDefined();
        expect(await twccFeedbackSent(outgoing, receiver)).toBe(true);
        assertNegotiationInvariants(answerer);
        assertNegotiationInvariants(offerer);
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "twcc-at-commit");
      } finally {
        await close();
      }
    });

    test("[2.4-5] transport-cc feedback a pranswer packet started stops on rollback", async () => {
      // Arrange: H264 (transport-cc 付き) と VP8 を設定し、初回は VP8 だけで確定した session。
      const config = () => ({
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
      const {
        offerer,
        answerer,
        outgoing,
        incoming,
        sender,
        receiver,
        transceiver,
        close,
      } = await createConnectedVideoPeersWith({
        offerer: config(),
        answerer: config(),
        offererPreferences: [useVP8()],
      });
      try {
        expect(receiver.receiverTWCC).toBeUndefined();
        // re-offer は H264 と VP8 の両方を提案し、answerer は H264 を先頭に答える。
        transceiver.setCodecPreferences([]);
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);
        const answer = (await answerer.createAnswer()).sdp;
        expect(offeredVideoCodecs(answer)[0]).toBe("H264");

        // Act: H264 の pranswer を両側に適用し、offerer が暫定の H264 で送る。
        await answerer.setLocalDescription({ type: "pranswer", sdp: answer });
        await offerer.setRemoteDescription({ type: "pranswer", sdp: answer });

        // Assert: transport-cc を交渉した H264 のパケット受信で TWCC が始まり、feedback を送る。
        expect(sender.codec?.name.toUpperCase()).toBe("H264");
        expect(await twccFeedbackSent(outgoing, receiver)).toBe(true);
        expect(receiver.receiverTWCC).toBeDefined();
        assertNegotiationInvariants(answerer);

        // Act: 両側で rollback する。
        await offerer.setLocalDescription({ type: "rollback" });
        await answerer.setRemoteDescription({ type: "rollback" });

        // Assert: pending 中に始まった TWCC は止まり、current の VP8 の RTP には feedback を送らない。
        expect(receiver.receiverTWCC).toBeUndefined();
        expect(sender.codec?.name.toUpperCase()).toBe("VP8");
        expect(await twccFeedbackSent(outgoing, receiver)).toBe(false);
        assertNegotiationInvariants(answerer);
        assertNegotiationInvariants(offerer);
        // Assert: current の RTP は届き続ける。
        await sendAndExpectRtp(outgoing, incoming, "twcc-rollback");
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "twcc-rollback");
      } finally {
        await close();
      }
    });

    test("[2.4-7] a transceiver for a remote offer does not take the m-line of a committed inactive transceiver", async () => {
      // Arrange: inactive な audio m-line (index 0) を確定させる。
      const { offerer, answerer, inactive, inactiveMid, close } =
        await createCommittedInactiveAudioPeers();
      try {
        expect(inactive.currentDirection).toBe("inactive");
        const expectInactiveKept = () => {
          expect(inactive.mid).toBe(inactiveMid);
          expect(inactive.mLineIndex).toBe(0);
          expect(inactive.currentDirection).toBe("inactive");
          expect(inactive.stopping).toBe(false);
          expect(inactive.stopped).toBe(false);
          expect(answerer.getTransceivers()[0]).toBe(inactive);
        };
        offerer.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
          direction: "sendonly",
        });
        await offerer.setLocalDescription(await offerer.createOffer());

        // Act: audio を追加した remote offer を answerer に適用する。
        await answerer.setRemoteDescription(offerer.localDescription!);

        // Assert: 新しい m-line には新しい transceiver が作られ、inactive な transceiver の枠は奪われない。
        expectInactiveKept();
        const [, added] = answerer.getTransceivers();
        expect(added).toBeDefined();
        expect(added.mid).not.toBe(inactiveMid);
        expect(added.mLineIndex).toBe(1);
        assertNegotiationInvariants(answerer);

        // Act: rollback する。
        await answerer.setRemoteDescription({ type: "rollback" });
        // Assert: rollback 後も inactive な transceiver はそのまま残る。
        expectInactiveKept();
        expect(answerer.getTransceivers()).toEqual([inactive]);

        // Act: 同じ offer を適用し直し、answer で確定する。
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);

        // Assert: 確定後も inactive な m-line は元の transceiver のまま、追加分は 2 本目の m-line。
        expectInactiveKept();
        expect(answerer.getTransceivers()).toHaveLength(2);
        expect(answerer.getTransceivers()[1].mLineIndex).toBe(1);
        assertNegotiationInvariants(answerer);
        assertNegotiationInvariants(offerer);
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "inactive-kept");
      } finally {
        await close();
      }
    });

    test("[2.4-7] a remote offer that puts a new MID on a committed inactive (not rejected) m-line does not take it", async () => {
      // Arrange: inactive な audio m-line (index 0、port 0 ではない) を確定させ、その位置に
      // 別の MID の sendonly audio を置いた offer を作る (拒否済みでない m-line の再利用)。
      const { offerer, answerer, inactive, inactiveMid, close } =
        await createCommittedInactiveAudioPeers();
      try {
        const current = answerer.currentRemoteDescription!.sdp;
        const offer = (await offerer.createOffer()).sdp;
        const recycled = mungeSection(offer, inactiveMid, (section) =>
          section
            .replace(/^a=mid:\S+/m, "a=mid:recycled")
            .replace(/^a=inactive/m, "a=sendonly"),
        ).replace(/^a=group:BUNDLE [^\r\n]+/m, "a=group:BUNDLE recycled");
        expect(parseSdp(recycled).media[0].port).not.toBe(0);

        // Act: remote offer として適用する (受理でも拒否でもよい)。
        const outcome = await answerer
          .setRemoteDescription({ type: "offer", sdp: recycled })
          .then(
            () => "accepted",
            (error: Error) => error.name,
          );

        // Assert: remote offer のための transceiver は inactive な transceiver の枠を奪わない
        // (停止も置き換えもされず、MID と m-line の位置を保つ)。
        expect(answerer.getTransceivers()).toContain(inactive);
        expect(inactive.mid).toBe(inactiveMid);
        expect(inactive.mLineIndex).toBe(0);
        expect(inactive.stopped).toBe(false);
        expect(inactive.stopping).toBe(false);
        if (outcome !== "accepted") {
          // Assert: 拒否するなら状態を変えない。
          expect(answerer.signalingState).toBe("stable");
          expect(answerer.currentRemoteDescription!.sdp).toBe(current);
        }
        assertNegotiationInvariants(answerer);
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "recycled-mid");
      } finally {
        await close();
      }
    });

    test("[2.4-7] an unassociated inactive addTransceiver() is associated by a remote offer only within the documented constraint and keeps its direction", async () => {
      const { offerer, answerer, close } = createUnnegotiatedPeers();
      try {
        // Arrange: answerer の app が inactive な未関連付けの audio transceiver を持つ。
        const appInactive = answerer.addTransceiver("audio", {
          direction: "inactive",
        });
        offerer.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
          direction: "sendonly",
        });
        await offerer.setLocalDescription(await offerer.createOffer());

        // Act: audio の remote offer を適用する。
        await answerer.setRemoteDescription(offerer.localDescription!);

        // Assert: 既知の制約 (6 章) どおり app の transceiver に関連付けるが、
        // app が選んだ inactive は remote offer で変えず、別の transceiver も作らない。
        expect(answerer.getTransceivers()).toEqual([appInactive]);
        expect(appInactive.mid).toBe(offerer.getTransceivers()[0].mid);
        expect(appInactive.direction).toBe("inactive");
        assertNegotiationInvariants(answerer);

        // Act: rollback する。
        await answerer.setRemoteDescription({ type: "rollback" });

        // Assert: app の transceiver は未関連付けに戻り、inactive のまま残る。
        expect(answerer.getTransceivers()).toEqual([appInactive]);
        expect(appInactive.mid).toBeNull();
        expect(appInactive.direction).toBe("inactive");

        // Act: 同じ offer に answer する。
        await answerer.setRemoteDescription(offerer.localDescription!);
        const answer = await answerer.createAnswer();

        // Assert: answer の m-line は app の inactive を反映する (受信方向を奪わない)。
        expect(answer.sdp).toMatch(/^a=inactive\r?$/m);
        await answerer.setLocalDescription(answer);
        await offerer.setRemoteDescription(answerer.localDescription!);
        expect(appInactive.currentDirection).toBe("inactive");
        assertNegotiationInvariants(answerer);
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "app-inactive");
      } finally {
        await close();
      }
    });

    test("[2.5-16] createAnswer only proposes: sender, receive codec / RTX tables, TWCC and the remote track codec switch at the local answer commit", async () => {
      // Arrange: VP8+RTX で確定した session に、H264(transport-cc)+RTX だけの re-offer が届いている。
      const {
        offerer,
        answerer,
        offererOut,
        answererOut,
        offererTransceiver,
        answererTransceiver,
        close,
      } = await createVp8RtxSessionWithH264Reoffer();
      try {
        const receiver = answererTransceiver.receiver;
        const sender = answererTransceiver.sender;
        const remoteTrack = receiver.track;
        const vp8 = payloadTypeOf(
          answerer.currentRemoteDescription!.sdp,
          "VP8",
        );
        const tablesBefore = receiver.snapshotReceiveTables();
        const sendBefore = sender.snapshotSendParams();
        expect(sendBefore.codec?.name.toUpperCase()).toBe("VP8");
        expect(remoteTrack.codec?.name.toUpperCase()).toBe("VP8");
        expect(receiver.receiverTWCC).toBeUndefined();

        // Act: answer を作る (まだ適用しない)。
        const answer = await answerer.createAnswer();

        // Assert: answer は H264+RTX を提案するが、live の送受信は current のまま変わらない。
        expect(offeredVideoCodecs(answer.sdp)).toEqual(["H264"]);
        expect(answer.sdp).toMatch(/^a=rtpmap:\d+ rtx\/90000/m);
        expect(sender.snapshotSendParams()).toEqual(sendBefore);
        expect(receiver.snapshotReceiveTables()).toEqual(tablesBefore);
        expect(receiver.receiverTWCC).toBeUndefined();
        expect(remoteTrack.codec?.name.toUpperCase()).toBe("VP8");
        assertNegotiationInvariants(answerer);
        await sendAndExpectRtp(
          offererOut,
          remoteTrack,
          "create-answer-pending",
        );

        // Act: answer を適用して commit する。
        await answerer.setLocalDescription(answer);
        await offerer.setRemoteDescription(answerer.localDescription!);

        // Assert: commit で sender・受信 codec/RTX 表・TWCC・remote track の codec が answer の値に切り替わる。
        const h264 = payloadTypeOf(answer.sdp, "H264");
        const rtx = Number(
          answer.sdp.match(new RegExp(`^a=fmtp:(\\d+) apt=${h264}`, "m"))![1],
        );
        expect(sender.codec?.name.toUpperCase()).toBe("H264");
        expect(receiveCodecNames(receiver)).toEqual({
          [h264]: "H264",
          [rtx]: "RTX",
        });
        expect(receiver.snapshotReceiveTables().codecs[vp8]).toBeUndefined();
        expect(receiver.receiverTWCC).toBeDefined();
        expect(remoteTrack.codec?.name.toUpperCase()).toBe("H264");
        assertNegotiationInvariants(answerer);
        assertNegotiationInvariants(offerer);
        // Assert: 確定した H264 で双方向に届く。
        await sendAndExpectRtp(offererOut, remoteTrack, "answer-commit-a-to-b");
        await sendAndExpectRtp(
          answererOut,
          offererTransceiver.receiver.track,
          "answer-commit-b-to-a",
        );
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "answer-commit");
      } finally {
        await close();
      }
    });

    test("[2.5-17] a rolled-back local offer leaves no pendingLocalOfferCodecs and the next offer resolves as before", async () => {
      // Arrange: VP8 + H264 で確定した session (setCodecPreferences なし)。
      const { offerer, answerer, outgoing, incoming } =
        await createConnectedVideoPeers({
          codecs: { video: [useVP8(), useH264()] },
        });
      try {
        const [transceiver] = offerer.getTransceivers();
        const baseline = {
          pending: transceiver.pendingLocalOfferCodecs,
          needsResolution: transceiver.codecPreferencesNeedResolution,
          codecs: transceiver.codecs.map((c) => c.payloadType),
        };
        const offer = await offerer.createOffer();

        // Act: local offer を適用する。
        await offerer.setLocalDescription(offer);
        // Assert: 適用中は offer の codec を pendingLocalOfferCodecs に持つ。
        expect(
          transceiver.pendingLocalOfferCodecs?.map((c) => c.payloadType),
        ).toEqual(
          parseSdp(offer.sdp).media[0].rtp.codecs.map((c) => c.payloadType),
        );
        // Act: rollback する。
        await offerer.setLocalDescription({ type: "rollback" });

        // Assert: rolled-back offer の pendingLocalOfferCodecs と再解決要求は baseline に戻る。
        expect(transceiver.pendingLocalOfferCodecs).toEqual(baseline.pending);
        expect(transceiver.codecPreferencesNeedResolution).toBe(
          baseline.needsResolution,
        );
        expect(transceiver.codecs.map((c) => c.payloadType)).toEqual(
          baseline.codecs,
        );
        assertNegotiationInvariants(offerer);
        // Assert: 次の offer は rollback 前と同じ codec を提案し、確定後も RTP が届く。
        const next = await offerer.createOffer();
        expect(offeredVideoCodecs(next.sdp)).toEqual(
          offeredVideoCodecs(offer.sdp),
        );
        await offerer.setLocalDescription(next);
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);
        assertNegotiationInvariants(offerer);
        await sendAndExpectRtp(outgoing, incoming, "after-offer-rollback");
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "offer-rollback");
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test("[2.5-17] a rolled-back remote offer restores the re-resolution request an unapplied createOffer consumed while it was pending", async () => {
      // Arrange: createAnswer 後の addTrack で、answer の H264 を commit しつつ再解決要求が残った answerer。
      const { offerer, answerer, transceiver } = await createH264OnlyReoffer();
      try {
        const answer = await answerer.createAnswer();
        answerer.addTrack(new MediaStreamTrack({ kind: "video" }));
        await answerer.setLocalDescription(answer);
        await offerer.setRemoteDescription(answerer.localDescription!);
        expect(transceiver.codecPreferencesNeedResolution).toBe(true);
        const baselineCodecs = transceiver.codecs.map((c) => c.payloadType);
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);

        // Act: remote offer の pending 中に自分の offer を作る (適用しない。再解決要求を消費する)。
        const unapplied = await answerer.createOffer();
        // Assert: 未適用の createOffer で再解決要求は消費され、codec は解決し直されている。
        expect(offeredVideoCodecs(unapplied.sdp)).toEqual(["VP8", "H264"]);
        expect(transceiver.codecPreferencesNeedResolution).toBe(false);
        // Act: remote offer を rollback する。
        await answerer.setRemoteDescription({ type: "rollback" });
        await offerer.setLocalDescription({ type: "rollback" });

        // Assert: pending 中に消費した再解決要求と解決済み codec は baseline に戻る。
        expect(transceiver.codecPreferencesNeedResolution).toBe(true);
        expect(transceiver.codecs.map((c) => c.payloadType)).toEqual(
          baselineCodecs,
        );
        expect(transceiver.pendingLocalOfferCodecs).toBeUndefined();
        assertNegotiationInvariants(answerer);
        // Assert: 次の自分の offer は設定から解決し直す (VP8 と H264)。
        expect(offeredVideoCodecs((await answerer.createOffer()).sdp)).toEqual([
          "VP8",
          "H264",
        ]);
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(
          offerer,
          answerer,
          "remote-offer-rollback",
        );
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test("[2.6-T1b] the configured SCTP MTU is kept when SCTP moves to another DTLS transport, on rollback and at the answer", async () => {
      // Arrange: MTU を設定した answerer が先に DataChannel を作り (SCTP は自分の transport)、
      // video と DataChannel を同じ BUNDLE にした offer を受ける。
      const offerer = new RTCPeerConnection();
      const answerer = new RTCPeerConnection({ sctp: { mtu: 1052 } });
      try {
        offerer.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
          direction: "sendonly",
        });
        const channel = offerer.createDataChannel("mtu");
        answerer.createDataChannel("answerer-own");
        const sctp = answerer.sctpTransport!;
        const ownTransport = sctp.dtlsTransport;
        expect(sctp.sctp.mtu).toBe(1052);
        await offerer.setLocalDescription(await offerer.createOffer());

        // Act: remote offer を適用する (SCTP は BUNDLE tag の video の transport へ移る)。
        await answerer.setRemoteDescription(offerer.localDescription!);

        // Assert: 別 DTLS transport へ移った SCTP も設定の MTU を使う。
        expect(answerer.sctpTransport).toBe(sctp);
        expect(sctp.dtlsTransport).not.toBe(ownTransport);
        expect(sctp.sctp.mtu).toBe(1052);
        assertNegotiationInvariants(answerer);

        // Act: rollback する。
        await answerer.setRemoteDescription({ type: "rollback" });

        // Assert: 元の DTLS transport に戻した SCTP も設定の MTU を使う。
        expect(answerer.sctpTransport!.dtlsTransport).toBe(ownTransport);
        expect(answerer.sctpTransport!.sctp.mtu).toBe(1052);
        assertNegotiationInvariants(answerer);

        // Act: 同じ offer を適用し直して answer で確定する。
        const remote = answerer.onDataChannel.watch((c) => c.label === "mtu");
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);

        // Assert: 確定した SCTP も設定の MTU で、DataChannel が実際に届く。
        expect(answerer.sctpTransport!.sctp.mtu).toBe(1052);
        const [received] = await remote;
        await sendAndExpectData(channel, received, "mtu-after-answer");
        assertNegotiationInvariants(answerer);
        assertNegotiationInvariants(offerer);
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "sctp-mtu");
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test("[2.6-T4e] answering with a track source codec does not adopt it into the configured codecs", async () => {
      // Arrange: VP8 → H264 の順に設定し、H264 source の track を addTrack した answerer が VP8/H264 の offer を受ける。
      const config = () => ({ codecs: { video: [useVP8(), useH264()] } });
      const offerer = new RTCPeerConnection(config());
      const answerer = new RTCPeerConnection(config());
      try {
        const offererOut = new MediaStreamTrack({ kind: "video" });
        const offererTransceiver = offerer.addTransceiver(offererOut, {
          direction: "sendrecv",
        });
        const h264Source = new MediaStreamTrack({
          kind: "video",
          codec: useH264(),
        });
        const answererSender = answerer.addTrack(h264Source);
        const [answererTransceiver] = answerer.getTransceivers();
        expect(answererTransceiver.sender).toBe(answererSender);
        const configured = () =>
          answerer
            .getConfiguration()
            .codecs.video!.map((c) => `${c.mimeType}/${c.payloadType}`);
        const before = configured();
        await offerer.setLocalDescription(await offerer.createOffer());
        expect(offeredVideoCodecs(offerer.localDescription!.sdp)).toEqual([
          "VP8",
          "H264",
        ]);

        // Act: remote offer を適用し、answer を作って両側に適用する。
        await answerer.setRemoteDescription(offerer.localDescription!);
        const answer = await answerer.createAnswer();
        await answerer.setLocalDescription(answer);
        await offerer.setRemoteDescription(answerer.localDescription!);
        await waitForPeersConnected(offerer, answerer);

        // Assert: answer は develop の規則 (track source との積) で H264 だけを答え、事前検証は拒否しない。
        expect(answerer.getTransceivers()).toEqual([answererTransceiver]);
        expect(offeredVideoCodecs(answer.sdp)).toEqual(["H264"]);
        expect(answererTransceiver.sender.codec?.name.toUpperCase()).toBe(
          "H264",
        );
        // Assert: track の codec は設定へ採用されず、設定の codec 順と PT は変わらない。
        expect(configured()).toEqual(before);
        assertNegotiationInvariants(answerer);
        assertNegotiationInvariants(offerer);
        // Assert: H264 で双方向に届く。
        await sendAndExpectRtp(
          h264Source,
          offererTransceiver.receiver.track,
          "track-codec-b-to-a",
        );
        await sendAndExpectRtp(
          offererOut,
          answererTransceiver.receiver.track,
          "track-codec-a-to-b",
        );
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "track-codec");
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test("[2.6-T4g] a remote answer keeps the answerer's codec order for the offerer's codecs and sender", async () => {
      // Arrange: offerer は VP8 → H264、answerer は H264 → VP8 の順で設定する。
      const offerer = new RTCPeerConnection({
        codecs: { video: [useVP8(), useH264()] },
      });
      const answerer = new RTCPeerConnection({
        codecs: { video: [useH264(), useVP8()] },
      });
      try {
        const outgoing = new MediaStreamTrack({ kind: "video" });
        const transceiver = offerer.addTransceiver(outgoing, {
          direction: "sendonly",
        });
        await offerer.setLocalDescription(await offerer.createOffer());
        expect(offeredVideoCodecs(offerer.localDescription!.sdp)).toEqual([
          "VP8",
          "H264",
        ]);
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());

        // Act: H264 → VP8 の answer を offerer に remote answer として適用する。
        await offerer.setRemoteDescription(answerer.localDescription!);
        await waitForPeersConnected(offerer, answerer);

        // Assert: offerer の確定 SDP・transceiver の codec・送信 codec は answer の順 (H264 先頭) を保つ。
        expect(
          offeredVideoCodecs(offerer.currentRemoteDescription!.sdp),
        ).toEqual(["H264", "VP8"]);
        expect(
          transceiver.codecs
            .map((c) => c.name.toUpperCase())
            .filter((name) => name !== "RTX"),
        ).toEqual(["H264", "VP8"]);
        expect(transceiver.sender.codec?.name.toUpperCase()).toBe("H264");
        assertNegotiationInvariants(offerer);
        // Assert: answer の順の codec で RTP が届く。
        await sendAndExpectRtp(
          outgoing,
          answerer.getTransceivers()[0].receiver.track,
          "remote-answer-order",
        );
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "remote-answer-order");
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test.each([
      ["stops", "VP8"],
      ["starts", "H264"],
    ] as const)(
      "[2.6-T4h] the local answer commit %s transport-cc with the answered codec without a preference change",
      async (change, twccCodec) => {
        // Arrange: current は VP8、H264 だけの re-offer を answerer に適用済み。transport-cc feedback は twccCodec の codec だけが持つ。
        const {
          offerer,
          answerer,
          outgoing,
          incoming,
          sender,
          receiver,
          close,
        } = await createTwccH264OnlyReoffer(twccCodec);
        try {
          const currentTwcc = twccCodec === "VP8";
          expect(!!receiver.receiverTWCC).toBe(currentTwcc);

          // Act: preference を変えずに answer を作って commit する。
          await answerer.setLocalDescription(await answerer.createAnswer());
          await offerer.setRemoteDescription(answerer.localDescription!);

          // Assert: 受信表と remote track の codec は H264 に、TWCC は H264 の feedback に置き換わる。
          expect(Object.values(receiveCodecNames(receiver))).toEqual(["H264"]);
          expect(incoming.codec?.name.toUpperCase()).toBe("H264");
          expect(!!receiver.receiverTWCC).toBe(change === "starts");
          // Assert: 受信した RTP に transport-cc feedback を送るか (starts) / 送らないか (stops)。
          expect(await twccFeedbackSent(outgoing, receiver)).toBe(
            change === "starts",
          );
          assertNegotiationInvariants(answerer);
          assertNegotiationInvariants(offerer);
          await sendAndExpectRtp(outgoing, incoming, `twcc-${change}`);
          // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
          await expectSessionContinues(offerer, answerer, `twcc-${change}`);
        } finally {
          await close();
        }
      },
    );

    test("[2.8-36] a remote-created transceiver the application keeps returns to its created codecs and has no routes after rollback", async () => {
      const { offerer, answerer, remoteCreated, close } =
        await createInitialPranswerConnection();
      try {
        // Arrange: 初回 pranswer で remote 起因の transceiver に codec・受信経路が付いている。
        const router = (
          answerer as unknown as {
            router: {
              ssrcTable: Record<number, unknown>;
              ridTable: Record<string, unknown>;
            };
          }
        ).router;
        const routesTo = (endpoint: unknown) =>
          [
            ...Object.values(router.ssrcTable),
            ...Object.values(router.ridTable),
          ].filter((e) => e === endpoint).length;
        expect(remoteCreated.codecs.length).toBeGreaterThan(0);
        expect(routesTo(remoteCreated.receiver)).toBeGreaterThan(0);

        // Act: answerer で remote offer を rollback する。
        await answerer.setRemoteDescription({ type: "rollback" });

        // Assert: app が使う transceiver は残り、作成時の状態 (MID・direction・codec なし) に戻る。
        expect(answerer.getTransceivers()).toContain(remoteCreated);
        expect(remoteCreated.mid).toBeNull();
        expect(remoteCreated.currentDirection).toBeNull();
        expect(remoteCreated.direction).toBe("recvonly");
        expect(remoteCreated.codecs).toEqual([]);
        expect(remoteCreated.sender.codec).toBeUndefined();
        expect(remoteCreated.receiver.snapshotReceiveTables()).toEqual({
          codecs: {},
          ssrcByRtx: {},
          stagedCodecs: {},
          stagedSsrcByRtx: {},
        });
        // Assert: 受信経路 (SSRC / MID+RID) はどれもその receiver を指さない。
        expect(routesTo(remoteCreated.receiver)).toBe(0);
        assertNegotiationInvariants(answerer);
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(
          offerer,
          answerer,
          "remote-created-rollback",
        );
      } finally {
        await close();
      }
    });

    test("[2.8-39] rolling back a first pranswer returns both peers' send and receive codecs to the unnegotiated state", async () => {
      const {
        offerer,
        answerer,
        offererOut,
        answererOut,
        offererTransceiver,
        answererTransceiver,
        close,
      } = await createVp8H264AnsweringPeers();
      try {
        // Arrange: answerer は H264 だけを選んだ answer を初回 pranswer として両側に適用し、H264 で通信する。
        answererTransceiver.setCodecPreferences([useH264()]);
        const pranswer = (await answerer.createAnswer()).sdp;
        await answerer.setLocalDescription({ type: "pranswer", sdp: pranswer });
        await offerer.setRemoteDescription({ type: "pranswer", sdp: pranswer });
        await waitForPeersConnected(offerer, answerer);
        expect(offererTransceiver.sender.codec?.name.toUpperCase()).toBe(
          "H264",
        );
        expect(answererTransceiver.sender.codec?.name.toUpperCase()).toBe(
          "H264",
        );
        await sendAndExpectRtp(
          offererOut,
          answererTransceiver.receiver.track,
          "first-pranswer-h264",
        );

        // Act: 両側で初回交渉を rollback する。
        await answerer.setRemoteDescription({ type: "rollback" });
        await offerer.setLocalDescription({ type: "rollback" });

        // Assert: 送信 codec と受信表は pranswer 前 (未交渉) に戻る。
        for (const transceiver of [offererTransceiver, answererTransceiver]) {
          expect(transceiver.sender.codec).toBeUndefined();
          expect(receiveCodecNames(transceiver.receiver)).toEqual({});
        }
        assertNegotiationInvariants(offerer);
        assertNegotiationInvariants(answerer);

        // Act: 改めて preference なしで交渉する。
        answererTransceiver.setCodecPreferences([]);
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);
        const [answererSide] = answerer.getTransceivers();
        answererSide.direction = "sendrecv";
        await answererSide.sender.replaceTrack(answererOut);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);
        await waitForPeersConnected(offerer, answerer);

        // Assert: 新しい交渉は VP8 で確定し、invariant を満たして届く。
        expect(offererTransceiver.sender.codec?.name.toUpperCase()).toBe("VP8");
        assertNegotiationInvariants(offerer);
        assertNegotiationInvariants(answerer);
        await sendAndExpectRtp(
          offererOut,
          answererSide.receiver.track,
          "after-first-pranswer-rollback",
        );
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(
          offerer,
          answerer,
          "first-pranswer-rollback",
        );
      } finally {
        await close();
      }
    });

    test("[5-7] PLI stays negotiated after a rolled-back re-offer that removes NACK/PLI for the same SSRC", async () => {
      const { offerer, answerer } = await createConnectedVideoPeers();
      const sender = offerer.getTransceivers()[0].sender;
      const receiver = answerer.getTransceivers()[0].receiver;
      try {
        // Arrange: 接続済み session は PLI を交渉済みで、実際に届く。
        expect(await pliReaches(receiver, sender)).toBe(true);

        // Act: 同じ SSRC の VP8 から NACK/PLI を外した re-offer を pending にする。
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription({
          type: "offer",
          sdp: rewriteVideoFeedback(offerer.localDescription!.sdp, "remove"),
        });
        // Assert: pending 中は current の受信 codec のまま PLI が届く。
        expect(await pliReaches(receiver, sender)).toBe(true);
        assertNegotiationInvariants(answerer);

        // Act: 両側で rollback する。
        await answerer.setRemoteDescription({ type: "rollback" });
        await offerer.setLocalDescription({ type: "rollback" });

        // Assert: rollback 後も current の設定に戻ったまま PLI が届く。
        expect(await pliReaches(receiver, sender)).toBe(true);
        assertNegotiationInvariants(answerer);
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "pli-rollback");
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test.each([
      ["with", "without"],
      ["without", "with"],
    ] as const)(
      "[5-7] PLI follows the receive codec table %s NACK/PLI, not a remote track codec rewritten %s it",
      async (negotiated, _rewritten) => {
        // Arrange: NACK/PLI を交渉した (または交渉しない) session で、受信 track の codec を逆の feedback に書き換える。
        const { offerer, answerer, incoming } = await createConnectedVideoPeers(
          negotiated === "with" ? {} : videoWithoutFeedback,
        );
        const sender = offerer.getTransceivers()[0].sender;
        const receiver = answerer.getTransceivers()[0].receiver;
        try {
          const codec = incoming.codec!;
          incoming.codec = new RTCRtpCodecParameters({
            ...codec,
            rtcpFeedback: negotiated === "with" ? [] : [useNACK(), usePLI()],
          });

          // Act: PLI を要求する。
          const reached = await pliReaches(receiver, sender);

          // Assert: PLI の可否は track の codec ではなく、受信 codec 表 (current SDP) の feedback に従う。
          expect(reached).toBe(negotiated === "with");
          assertNegotiationInvariants(answerer);
          // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
          await expectSessionContinues(offerer, answerer, `pli-${negotiated}`);
        } finally {
          await Promise.allSettled([offerer.close(), answerer.close()]);
        }
      },
    );

    test.each(["answer", "rollback"] as const)(
      "[5-13] RTX packets resolve to the current media SSRC while a re-pairing is pending and after %s",
      async (finish) => {
        // Arrange: RTX 付きで接続済み。FID の RTX SSRC はそのまま、対のメディア SSRC を変えた re-offer を作る。
        const { offerer, answerer, incoming } =
          await createConnectedVideoPeersWithRtx();
        try {
          const offer = (await offerer.createOffer()).sdp;
          const [, mediaSsrc, rtxSsrc] = offer
            .match(/^a=ssrc-group:FID (\d+) (\d+)/m)!
            .map(Number);
          const rtxPt = payloadTypeOf(offer, "rtx");
          const repaired = offer.split(String(mediaSsrc)).join("999333");
          const transport = offerer.getTransceivers()[0].dtlsTransport;
          const receiver = answerer.getTransceivers()[0].receiver;
          let rtxSequence = 3000;
          const sendRtx = async (text: string) => {
            // RTX の payload は元の sequence number (2 byte) + 元の payload。
            const osn = Buffer.alloc(2);
            osn.writeUInt16BE(rtxSequence);
            const received = watchRtpText(receiver.tracks, text);
            await sendRawRtp(
              transport,
              {
                ssrc: rtxSsrc,
                payloadType: rtxPt,
                sequenceNumber: ++rtxSequence,
              },
              Buffer.concat([osn, Buffer.from(text)]),
            );
            return received;
          };

          // Act: RTX の対応を変える remote offer を適用し、RTX パケットを送る。
          await answerer.setRemoteDescription({ type: "offer", sdp: repaired });
          const pending = await sendRtx(`rtx-pending-${finish}`);

          // Assert: pending 中は current の対応のメディア SSRC として current の track に届く。
          expect(pending.packet.header.ssrc).toBe(mediaSsrc);
          expect(pending.track).toBe(incoming);
          assertNegotiationInvariants(answerer);

          // Act: answer で確定する、または rollback してから RTX を送る。
          if (finish === "answer") {
            await answerer.setLocalDescription(await answerer.createAnswer());
          } else {
            await answerer.setRemoteDescription({ type: "rollback" });
          }
          const after = await sendRtx(`rtx-after-${finish}`);

          // Assert: 確定後は新しい対のメディア SSRC、rollback 後は元の SSRC として復元される。
          const expected = finish === "answer" ? 999333 : mediaSsrc;
          expect(after.packet.header.ssrc).toBe(expected);
          expect(after.track).toBe(receiver.trackBySSRC[expected]);
          if (finish === "rollback") expect(after.track).toBe(incoming);
          assertNegotiationInvariants(answerer);
          // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
          await expectSessionContinues(offerer, answerer, `rtx-${finish}`);
        } finally {
          await Promise.allSettled([offerer.close(), answerer.close()]);
        }
      },
    );

    test("[5-13] RTP that carries a header extension under its new id arrives after the answer commits the move", async () => {
      const { offerer, answerer, firstMid, ridExtensionId, close } =
        await createSimulcastPeers();
      try {
        // Arrange: RID 拡張の URI を未使用の ID 12 へ移した re-offer を answerer に適用する。
        const offer = (await offerer.createOffer()).sdp.replace(
          new RegExp(
            `^a=extmap:${ridExtensionId} (${useSdesRTPStreamId().uri})`,
            "gm",
          ),
          "a=extmap:12 $1",
        );
        expect(offer).toContain(`a=extmap:12 ${useSdesRTPStreamId().uri}`);
        await answerer.setRemoteDescription({ type: "offer", sdp: offer });
        const current = answerer.currentRemoteDescription!.sdp;
        const midExtensionId = Number(
          current.match(
            new RegExp(`^a=extmap:(\\d+) ${useSdesMid().uri}`, "m"),
          )![1],
        );
        const payloadType = payloadTypeOf(current, "VP8");

        // Act: answer で確定し、新しい ID 12 で RID を載せた RTP を送る。
        await answerer.setLocalDescription(await answerer.createAnswer());
        const track = answerer.getTransceivers()[0].receiver.trackByRID.high;
        const received = watchRtpText([track], "new-extension-id");
        await sendRawRtp(
          offerer.getTransceivers()[0].dtlsTransport,
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
        assertNegotiationInvariants(answerer);
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "extension-id-move");
      } finally {
        await close();
      }
    });

    test.each(["answer", "rollback"] as const)(
      "[5-13] RTP received while a fmtp change is staged is decoded with the current fmtp until %s",
      async (finish) => {
        // Arrange: 接続済みの VP8 に fmtp を足した re-offer を作る。
        const { offerer, answerer, outgoing, incoming } =
          await createConnectedVideoPeers();
        try {
          const receiver = answerer.getTransceivers()[0].receiver;
          const offer = (await offerer.createOffer()).sdp;
          const pt = payloadTypeOf(offer, "VP8");
          const currentFmtp =
            receiver.snapshotReceiveTables().codecs[pt].parameters;
          const changed = offer.replace(
            new RegExp(`^(a=rtpmap:${pt} VP8/90000)`, "m"),
            `$1\r\na=fmtp:${pt} max-fr=30`,
          );

          // Act: fmtp を変える remote offer を適用し、RTP を送る。
          await answerer.setRemoteDescription({ type: "offer", sdp: changed });

          // Assert: fmtp の変更は staged で、pending 中の RTP は current の fmtp の codec で処理されて届く。
          const tables = receiver.snapshotReceiveTables();
          expect(tables.codecs[pt].parameters).toBe(currentFmtp);
          expect(tables.stagedCodecs[pt]?.parameters).toBe("max-fr=30");
          await sendAndExpectRtp(outgoing, incoming, `fmtp-pending-${finish}`);
          assertNegotiationInvariants(answerer);

          // Act: answer で確定する、または rollback する。
          if (finish === "answer") {
            await answerer.setLocalDescription(await answerer.createAnswer());
          } else {
            await answerer.setRemoteDescription({ type: "rollback" });
          }

          // Assert: 確定すると新しい fmtp に、rollback なら current の fmtp に戻り、RTP が届く。
          expect(receiver.snapshotReceiveTables().codecs[pt].parameters).toBe(
            finish === "answer" ? "max-fr=30" : currentFmtp,
          );
          expect(receiver.snapshotReceiveTables().stagedCodecs).toEqual({});
          await sendAndExpectRtp(outgoing, incoming, `fmtp-after-${finish}`);
          assertNegotiationInvariants(answerer);
          // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
          await expectSessionContinues(offerer, answerer, `fmtp-${finish}`);
        } finally {
          await Promise.allSettled([offerer.close(), answerer.close()]);
        }
      },
    );

    test("[5-K14] an m-line outside the offered BUNDLE group offered with a=setup:active is answered passive (RFC 8842 section 5.3)", async () => {
      // Arrange: 初回 offerer (DTLS server) の caller に、callee が group 外の audio を
      // a=setup:active で提案する re-offer を用意する (705 helper の actpass を active にする)。
      const { caller, callee, outsideMid, outsideOffer } =
        await createBundlePairWithOutsideReoffer({ reofferFrom: "callee" });
      // 705 helper の offer は group 外 m-line の ICE 資格情報を callee の実際の値と異なる値に
      // 書き換えており、caller の transport は callee が使わない資格情報を持つため継続できない。
      exemptFromContinuation(
        [caller, callee],
        "offer misdescribes the outside m-line ICE credentials (outsideufrag) the callee does not use",
      );
      try {
        const activeOffer = mungeSection(outsideOffer, outsideMid, (section) =>
          section.replace(/^a=setup:actpass/m, "a=setup:active"),
        );
        expect(activeOffer).not.toBe(outsideOffer);

        // Act: re-offer に answer して確定する。
        const answer = await answerRemoteOffer(caller, activeOffer);

        // Assert: group 外の m-line は offer の逆の passive で答え、その独立 transport は server になる。
        const outside = parseSdp(answer).media.find(
          (media) => media.rtp.muxId === outsideMid,
        )!;
        expect(outside.dtlsParams?.role).toBe("server");
        expect(answer).toMatch(/^a=setup:passive\r?$/m);
        const roles = caller
          .getTransceivers()
          .map((t) => [t.mid, t.dtlsTransport.role]);
        expect(roles).toEqual([
          ["0", "server"],
          ["1", "server"],
          [outsideMid, "server"],
        ]);
        // invariant helper は呼ばない: 705 helper の offer は group 外 m-line の資格情報だけを
        // 書き換えた (相手の実際の動作と食い違う) SDP で、ICE の検査は対象外。
      } finally {
        await closeAll(caller, callee);
      }
    });
  },
);
