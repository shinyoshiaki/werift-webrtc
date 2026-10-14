import {
  MediaStreamTrack,
  RTCIceTransport,
  RTCRtpCodecParameters,
  useH264,
  useVP8,
} from "../../../src";
import type { RTCDtlsTransport, RTCPeerConnection } from "../../../src";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  trickleCandidate,
  ufragOf,
  withBundle,
  withoutEoc,
} from "../harness/negotiationTransactionUtils";
import {
  addNegotiatedAudio,
  createConnectedMediaAndDataPeers,
  createConnectedVideoPeers,
  createDuplexSession,
  createPeerPair,
  createRewrittenOffer,
  createSimulcastPeers,
  createSplitOffer,
  createUnnegotiatedVideoPeers,
  failOnce,
  movePayloadType,
  negotiationInternals,
  recordNegotiationEvents,
  waitForCommittedNomination,
  waitForConnection,
  waitForDtlsConnected,
  waitForIce,
  waitForProvisionalNomination,
} from "../harness/negotiationTransactionUtils";

/** The transport the negotiation transaction prepared for `mid` (private state). */
const preparedTransport = (pc: RTCPeerConnection, mid: string) =>
  (
    pc as unknown as {
      negotiation: { transportByMid: Map<string, RTCDtlsTransport> };
    }
  ).negotiation.transportByMid.get(mid);

describeCases("negotiation transaction", () => {
  negotiationCase(
    "a remote offer whose BUNDLE member is not an exact MID creates nothing",
    { ref: "2.8-20; origin: BUNDLE group validation" },
    async (c) => {
      // Arrange: BUNDLE group の MID に suffix を付けた初回 offer を作る。
      const { a, b } = await c.given(createPeerPair());
      const events = recordNegotiationEvents(b);
      a.addTransceiver("audio");
      const offer = await a.createOffer();

      // Act: その offer を remote description として適用する。拒否され状態は変わらない。
      await c.setRemote(
        b,
        offer.sdp.replace(/^a=group:BUNDLE 0\b/m, "a=group:BUNDLE 0_extra"),
        { rejects: "OperationError" },
      );

      // Assert: transceiver も通知も作られず stable のまま。
      expect(b.remoteDescription).toEqual(null);
      expect(b.getTransceivers().length).toEqual(0);
      expect(events.remoteTransceivers).toEqual([]);
    },
  );

  negotiationCase(
    "a replacement local offer whose transport preparation fails keeps the earlier pending offer",
    { ref: "2.9-9" },
    async (c) => {
      // Arrange: audio を追加して交渉し、audio を BUNDLE から外す offer を pending にする (分割用の新 transport が準備される)。
      const { a, b, session } = await c.given(createDuplexSession());
      const audio = await addNegotiatedAudio(session, session.a, session.b);
      await c.setLocal(a, await createSplitOffer(a, audio.mid));
      const prepared = preparedTransport(a, audio.mid);
      expect(a.dtlsTransports).not.toContain(prepared);
      const replacement = await createSplitOffer(a, audio.mid);
      const gather = vi
        .spyOn(RTCIceTransport.prototype, "gather")
        .mockRejectedValueOnce(new Error("gather failed"));

      // Act: 新 transport の ICE gathering が失敗する replacement offer を適用する。失敗し、先行 pending offer と signaling state が残る。
      await c.setLocal(a, replacement, { rejects: "gather failed" });
      gather.mockRestore();

      // Assert: 準備済み transport も残り、既存の通信は続く。
      expect(preparedTransport(a, audio.mid)).toBe(prepared);
      expect(prepared!.iceTransport.state).not.toEqual("closed");
      await c.alive();

      // Act: 残った先行 offer に answer して commit する。
      await c.setRemote(b, a.localDescription);
      await c.answer(b);
      await waitForDtlsConnected(audio.transceiver.dtlsTransport);
      await waitForDtlsConnected(audio.remote().dtlsTransport);

      // Assert: 先行 offer の分割 transport で audio が届き、既存経路も続く。
      expect(audio.transceiver.dtlsTransport).toBe(prepared);
      await c.rtp(audio.out, audio.remote().receiver.track);
      await c.alive();
    },
  );

  negotiationCase.for([
    { when: "during a pending re-offer" },
    {
      when: "after an unapplied createOffer in stable",
      createOfferFirst: true,
    },
  ] as const)(
    "rollback keeps simulcast SSRCs learned $when",
    { ref: "2.4-1; origin: simulcast SSRC learning" },
    async (c, { when, createOfferFirst }) => {
      // Arrange: RID 付き packet で high/low の SSRC を受信側に学習させる。
      const { a, b, sendLayer } = await c.given(createSimulcastPeers());
      await sendLayer("low", 2222, "low-learned", { withRid: true });
      if (createOfferFirst) {
        await b.createOffer();
        c.invariants(b);
      }
      await c.offer(a);

      // Act: pending 中に RID 付き packet で別 SSRC を学習し、両側で rollback する。
      await sendLayer("high", 1111, "high-learned", { withRid: true });
      await c.rollback(a);

      // Assert: RID なし (SSRC のみ) の packet が学習済みの各層へ届き続ける。
      await sendLayer("high", 1111, "high-after-rollback", { withRid: false });
      await sendLayer("low", 2222, "low-after-rollback", { withRid: false });
      expect(b.signalingState).toEqual("stable");
    },
  );

  negotiationCase(
    "a remote offer that fails while applying leaves no partial state",
    { ref: "2.1-11 5-K3" },
    async (c) => {
      // Arrange: 音声を足す re-offer を作り、受信側の RTP 適用を一度だけ失敗させる。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers(),
      );
      a.addTransceiver("audio", { direction: "sendonly" });
      await c.offer(a, { hold: true });
      const count = b.getTransceivers().length;
      failOnce(negotiationInternals(b).transceiverManager, "setRemoteRTP");

      // Act: 事前検証を通った後の適用中に例外が起きる。description と transceiver は変わらない。
      await c.setRemote(b, a.localDescription, {
        rejects: "injected apply failure",
      });

      // Assert: stable に戻り、作りかけの transceiver も transaction も残らない。
      expect(b.signalingState).toEqual("stable");
      expect(b.getTransceivers().length).toEqual(count);
      expect(negotiationInternals(b).negotiation.inspect().phase).toEqual(
        "idle",
      );
      await c.rtp(outgoing, incoming);

      // Act: 同じ offer を改めて適用し交渉を完了する。
      await c.setRemote(b, a.localDescription);
      await c.answer(b);

      // Assert: 両側 stable で音声 m-line が加わり、既存 RTP も届く。
      expect(b.getTransceivers().length).toEqual(count + 1);
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase(
    "an answer that fails while applying returns to its pending offer",
    { ref: "2.1-11 2.1-T13" },
    async (c) => {
      // Arrange: re-offer と answer を用意し、offer 側の RTP 適用を一度だけ失敗させる。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers(),
      );
      await c.offer(a);
      await c.answer(b, { hold: true });
      failOnce(negotiationInternals(a).transceiverManager, "setRemoteRTP");

      // Act: answer の適用中に例外が起きる。pending offer のまま残る。
      await c.setRemote(a, b.localDescription, {
        rejects: "injected apply failure",
      });

      // Assert: transaction も pending に戻り、binding と current RTP は壊れない。
      expect(a.signalingState).toEqual("have-local-offer");
      expect(negotiationInternals(a).negotiation.inspect().phase).toEqual(
        "pending",
      );
      await c.rtp(outgoing, incoming);

      // Act: 同じ answer を改めて適用する。
      await c.setRemote(a, b.localDescription);

      // Assert: 交渉が完了し RTP も継続する。
      expect(a.signalingState).toEqual("stable");
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase(
    "an ICE restart answer that fails while applying keeps the committed generation and pair",
    { ref: "2.1-11" },
    async (c) => {
      // Arrange: 現在の ICE generation と選択済み pair を控え、ICE restart offer/answer を用意する。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers(),
      );
      const transport = a.iceTransports[0];
      const ufrag = transport.connection.localUsername;
      const pair = transport.getSelectedCandidatePair();
      const generation = a.iceGeneration;
      await c.offer(a, { iceRestart: true });
      await c.answer(b, { hold: true });
      failOnce(negotiationInternals(a).transceiverManager, "setRemoteRTP");

      // Act: restart answer の適用中に例外が起きる。
      await c.setRemote(a, b.localDescription, {
        rejects: "injected apply failure",
      });

      // Assert: restart は確定せず、generation・ufrag・選択済み pair が残り、RTP が届く。
      expect(a.signalingState).toEqual("have-local-offer");
      expect(a.iceGeneration).toEqual(generation);
      expect(transport.connection.localUsername).toEqual(ufrag);
      expect(transport.getSelectedCandidatePair()).toEqual(pair);
      await c.rtp(outgoing, incoming);

      // Act: 同じ answer を改めて適用する。
      await c.setRemote(a, b.localDescription);
      await waitForCommittedNomination(a);

      // Assert: 新しい generation に切り替わり、RTP も継続する。
      expect(a.signalingState).toEqual("stable");
      expect(a.iceGeneration).toEqual(generation + 1);
      expect(transport.connection.localUsername).not.toEqual(ufrag);
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase(
    "a queued candidate that the answer cannot place rejects the answer before commit",
    { ref: "2.7-3; origin: candidate queue" },
    async (c) => {
      // Arrange: 初回 offer/answer を作り、offerer に remote description より先に置き場所のない候補を積む。
      const { a, b, outgoing, incoming } = await c.given(
        createUnnegotiatedVideoPeers(),
      );
      await c.offer(a);
      await c.answer(b, { hold: true });
      const answer = b.localDescription!;
      await a.addIceCandidate({
        candidate: answer.sdp.match(/^a=(candidate:.*?)\r?$/m)![1],
        sdpMid: "missing-mid",
      });

      // Act: 置き場所のない候補が queue にある状態で answer を適用する。pending offer は残る。
      await c.setRemote(a, answer, { rejects: "OperationError" });

      // Assert: answer は commit されず、transaction が残り、answer の ICE 資格情報も入らない。
      expect(a.signalingState).toEqual("have-local-offer");
      expect(a.remoteDescription).toEqual(null);
      expect(negotiationInternals(a).negotiation.inspect().phase).toEqual(
        "pending",
      );
      expect(a.iceTransports[0].connection.remoteUsername).not.toEqual(
        answer.sdp.match(/^a=ice-ufrag:(.*?)\r?$/m)![1],
      );

      // Act: 同じ answer を改めて適用する (拒否した候補は queue から外れている)。
      await c.setRemote(a, answer);

      // Assert: 交渉が完了し、RTP が届く。
      expect(a.signalingState).toEqual("stable");
      await Promise.all([waitForConnection(a), waitForConnection(b)]);
      await c.rtp(outgoing, incoming());
    },
  );

  negotiationCase(
    "a queued candidate the remote offer cannot place rejects it before any application event",
    { ref: "origin: candidate queue" },
    async (c) => {
      // Arrange: answerer に remote description より先に置き場所のない候補を積み、通知を数える。
      const { a, b, outgoing, incoming } = await c.given(
        createUnnegotiatedVideoPeers(),
      );
      await c.offer(a, { hold: true });
      const offer = a.localDescription!;
      await b.addIceCandidate({
        candidate: offer.sdp.match(/^a=(candidate:.*?)\r?$/m)![1],
        sdpMid: "missing-mid",
      });
      const onTransceiver = vi.fn();
      const onTrack = vi.fn();
      b.onRemoteTransceiverAdded.subscribe(onTransceiver);
      b.onTrack.subscribe(onTrack);

      // Act: その状態で remote offer を適用する。拒否され状態は変わらない。
      await c.setRemote(b, offer, { rejects: "OperationError" });

      // Assert: transceiver/track の通知は一度も出ない。
      expect(b.signalingState).toEqual("stable");
      expect(b.remoteDescription).toEqual(null);
      expect(b.getTransceivers().length).toEqual(0);
      expect(onTransceiver.mock.calls.length).toEqual(0);
      expect(onTrack.mock.calls.length).toEqual(0);

      // Act: 同じ offer を改めて適用し交渉を完了する (拒否した候補は queue から外れている)。
      await c.setRemote(b, offer);
      await c.answer(b);

      // Assert: 通知は成立した交渉の分だけ 1 回ずつ出て、RTP が届く。
      expect(onTransceiver.mock.calls.length).toEqual(1);
      expect(onTrack.mock.calls.length).toEqual(1);
      await Promise.all([waitForConnection(a), waitForConnection(b)]);
      await c.rtp(outgoing, incoming());
    },
  );

  negotiationCase(
    "createOffer called while setLocalDescription is running does not invalidate that offer",
    { ref: "origin: operations chain" },
    async (c) => {
      // Arrange: re-offer A を作る。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers(),
      );
      const offerA = await a.createOffer();

      // Act: setLocalDescription(A) の完了を待たずに次の createOffer を呼ぶ。
      const [, offerB] = await Promise.all([
        a.setLocalDescription(offerA),
        a.createOffer(),
      ]);

      // Assert: 先行した A はそのまま適用され、B は A の後に作られる。
      expect(a.signalingState).toEqual("have-local-offer");
      expect(a.pendingLocalDescription!.sdp).toEqual(offerA.sdp);
      c.invariants(a);

      // Act: 後続の B を置換 offer として適用し、answer で確定する。
      await c.setLocal(a, offerB);
      await c.setRemote(b, a.localDescription);
      await c.answer(b);

      // Assert: 交渉が完了し、RTP も届く。
      expect(a.signalingState).toEqual("stable");
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase(
    "createAnswer called while setRemoteDescription is running answers that offer",
    { ref: "origin: operations chain" },
    async (c) => {
      // Arrange: re-offer を適用する。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers(),
      );
      await c.offer(a, { hold: true });

      // Act: setRemoteDescription(offer) の完了を待たずに createAnswer を呼ぶ。
      const [, answer] = await Promise.all([
        b.setRemoteDescription(a.localDescription!),
        b.createAnswer(),
      ]);

      // Assert: answer は適用後の offer に対して作られ、そのまま確定できる。
      expect(b.signalingState).toEqual("have-remote-offer");
      await c.setLocal(b, answer);
      await c.setRemote(a, b.localDescription);
      expect(a.signalingState).toEqual("stable");
      expect(b.signalingState).toEqual("stable");
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase(
    "rollback and close drop the transaction's references to closed or unused objects",
    {
      ref: "origin: transaction references",
      exempt: "a is closed to check what close releases",
    },
    async (c) => {
      // Arrange: 初回 offer を適用し、DataChannel 用の transport も作らせる。
      const { a } = await c.given(createUnnegotiatedVideoPeers());
      const internals = negotiationInternals(a);
      await c.offer(a, { hold: true });
      a.createDataChannel("references");
      await a.createOffer();

      // Act: rollback する。
      await c.setLocal(a, "rollback");

      // Assert: 停止した transport への参照は残らない。
      const afterRollback = internals.negotiation.inspect();
      expect(afterRollback.phase).toEqual("idle");
      expect(
        afterRollback.createdTransports.filter((t) => t.state === "closed"),
      ).toEqual([]);

      // Act: offer を作ったまま close する。
      await a.createOffer();
      await a.close();

      // Assert: transport と offer snapshot の参照をすべて手放す。
      const afterClose = internals.negotiation.inspect();
      expect(afterClose.createdTransports).toEqual([]);
      expect(afterClose.hasOfferSnapshot).toEqual(false);
    },
  );

  negotiationCase(
    "a pending payload type leaves the receiver codec table by rollback",
    { ref: "2.4-1 2.4-3 5-13" },
    async (c) => {
      // Arrange: 受信側の codec/RTX 対応表を控え、H264 を新しい PT 120 で提案する re-offer を用意する (current の PT の割当ては変えない)。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers({ codecs: { video: [useVP8(), useH264()] } }),
      );
      const receiver = b.getTransceivers()[0].receiver;
      const baseline = receiver.snapshotReceiveTables();
      const committedPt = Number(
        Object.entries(baseline.codecs).find(
          (entry) => entry[1].mimeType === "video/VP8",
        )![0],
      );
      await c.offer(a, { hold: true });
      const h264Pt = Number(
        a.localDescription!.sdp.match(/^a=rtpmap:(\d+) H264\/90000/im)![1],
      );

      // Act: 新 PT を含む remote offer を pending として適用する。
      await c.setRemote(
        b,
        movePayloadType(a.localDescription!.sdp, h264Pt, 120),
      );

      // Assert: pending 中は新 PT が加わるが既存 PT の解釈は変わらず、旧 RTP が届く。
      const pending = receiver.snapshotReceiveTables();
      expect(pending.codecs[120].mimeType.toLowerCase()).toEqual("video/h264");
      expect(pending.codecs[committedPt]).toEqual(baseline.codecs[committedPt]);
      await c.rtp(outgoing, incoming);

      // Act: 双方の pending description を rollback する。
      await c.rollback(a);

      // Assert: codec/RTX 対応表は baseline と完全に一致し、旧 RTP が届く。
      expect(receiver.snapshotReceiveTables()).toEqual(baseline);
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase(
    "ICE restart pranswer connects a pending generation and rollback keeps current RTP",
    { ref: "2.2-3 2.7-T2" },
    async (c) => {
      // Arrange: 現行 pair と ICE generation を記録する。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers(),
      );
      const oldOffererTransport = a.iceTransports[0];
      const oldAnswererTransport = b.iceTransports[0];
      const oldPair = oldOffererTransport.getSelectedCandidatePair();
      const oldDtls = a.dtlsTransports[0];
      const currentRemote = b.currentRemoteDescription!.sdp;

      // Act: restart offer と pranswer で新しい ICE generation の checks を進める。
      await c.offer(a, { iceRestart: true });
      await c.pranswer(b);
      await Promise.all([
        waitForProvisionalNomination(a),
        waitForProvisionalNomination(b),
      ]);

      // Assert: ICE restart は DTLS association を作り直さず、旧 pair で RTP が続く。
      expect(a.dtlsTransports).toEqual([oldDtls]);
      expect(oldOffererTransport.getSelectedCandidatePair()).toEqual(oldPair);
      await c.rtp(outgoing, incoming);

      // Act: 双方の pending description を破棄する。
      await c.rollback(a);

      // Assert: 旧 pair と SDP に戻り、RTP が実際に届く。
      expect(a.iceTransports[0]).toBe(oldOffererTransport);
      expect(b.iceTransports[0]).toBe(oldAnswererTransport);
      expect(oldOffererTransport.getSelectedCandidatePair()).toEqual(oldPair);
      expect(b.currentRemoteDescription!.sdp).toEqual(currentRemote);
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase.for([
    { outcome: "answer" },
    { outcome: "rollback" },
  ] as const)(
    "ICE restart pranswer over a connected SCTP association checks the new generation, then $outcome",
    { ref: "2.1-3 2.1-5 2.1-T4 2.1-T8 2.2-6 2.2-16 2.3-16 2.7-T3 2.7-T4b" },
    async (c, { outcome }) => {
      // Arrange: 現行 generation の selected pair と SCTP transport を控える。
      const { a, b, outgoing, incoming, channel, received } = await c.given(
        createConnectedMediaAndDataPeers(),
      );
      const offererIce = a.iceTransports[0];
      const answererIce = b.iceTransports[0];
      const offererPair = offererIce.connection.nominated;
      const answererPair = answererIce.connection.nominated;
      const sctpTransport = b.sctpTransport!.dtlsTransport;
      const currentRemote = b.currentRemoteDescription!.sdp;

      // Act: 確立済み SCTP を保つ restart offer に pranswer を返す。
      await c.offer(a, { iceRestart: true });
      const answer = await c.pranswer(b);
      const [offererConnection] = await waitForProvisionalNomination(a);
      const [answererConnection] = await waitForProvisionalNomination(b);

      // Assert: pending generation は pranswer の資格情報で nominate され、current の pair・SDP・association はそのまま通信を続ける。
      const offerUfrag = ufragOf(a.localDescription!.sdp);
      const answerUfrag = ufragOf(b.localDescription!.sdp);
      expect(offererConnection.provisionalNominated).not.toEqual(undefined);
      expect(offererIce.connection.nominated).toBe(offererPair);
      expect(answererIce.connection.nominated).toBe(answererPair);
      expect(offererIce.connection.remoteUsername).not.toEqual(answerUfrag);
      expect(answererIce.connection.remoteUsername).not.toEqual(offerUfrag);
      expect(answererConnection.provisionalNominated).not.toEqual(undefined);
      expect(b.sctpTransport!.dtlsTransport).toBe(sctpTransport);
      expect(b.currentRemoteDescription!.sdp).toEqual(currentRemote);
      await c.rtp(outgoing, incoming);
      await c.data(channel, received);

      if (outcome === "answer") {
        // Act: final answer で pending generation を commit する。
        await c.setLocal(b, answer);
        await c.setRemote(a, b.localDescription);
        await Promise.all([waitForIce(a), waitForIce(b)]);

        // Assert: 双方の live generation が SDP と一致し、SCTP は移動しない。
        expect(offererIce.getRemoteParameters()?.usernameFragment).toEqual(
          answerUfrag,
        );
        expect(answererIce.getRemoteParameters()?.usernameFragment).toEqual(
          offerUfrag,
        );
        expect(answererIce.localParameters.usernameFragment).toEqual(
          answerUfrag,
        );
      } else {
        // Act: 双方の pending description を rollback する。
        await c.rollback(a);

        // Assert: provisional generation は破棄され、current pair が残る。
        expect(offererIce.connection?.provisionalNominated).toEqual(undefined);
        expect(answererIce.connection?.provisionalNominated).toEqual(undefined);
        expect(offererIce.connection.nominated).toBe(offererPair);
        expect(answererIce.connection.nominated).toBe(answererPair);
        expect(b.currentRemoteDescription!.sdp).toEqual(currentRemote);
      }

      // Assert: commit/rollback 後も同じ association で RTP と DataChannel が届く。
      expect(b.sctpTransport!.dtlsTransport).toBe(sctpTransport);
      await c.rtp(outgoing, incoming);
      await c.data(channel, received);
      await c.data(received, channel);
    },
  );

  negotiationCase(
    "rollback removes remote-only objects and a repeated offer does not duplicate events",
    {
      ref: "2.1-7 2.1-10 2.1-T1 2.2-2 2.3-1 2.3-3 2.3-4 2.3-6 2.3-8 2.3-21 2.3-23 5-4",
    },
    async (c) => {
      // Arrange: remote offer が初回の transceiver を生成する。
      const { a, b } = await c.given(createPeerPair());
      const onTrack = vi.fn();
      const onRemoteTransceiver = vi.fn();
      b.onTrack.subscribe(onTrack);
      b.onRemoteTransceiverAdded.subscribe(onRemoteTransceiver);
      a.addTransceiver("audio");
      const offer = await a.createOffer();

      // Act: 同じ offer を再適用してから rollback する。
      await c.setRemote(b, offer);
      await c.setRemote(b, offer);

      // Assert: 同じ receiver と transceiver への通知は一度だけ。
      expect(onRemoteTransceiver.mock.calls.length).toEqual(1);
      expect(onTrack.mock.calls.length).toEqual(1);
      const oldTransceiver = b.getTransceivers()[0];
      await c.setRemote(b, "rollback");
      expect(b.getTransceivers().length).toEqual(0);
      expect(oldTransceiver.stopped).toEqual(true);

      // Act: rollback 後の新しい offer は新しい object を作る。
      await c.setRemote(b, offer);

      // Assert: 新しい receiver 遷移に対する通知だけが追加される。
      expect(onRemoteTransceiver.mock.calls.length).toEqual(2);
      expect(onTrack.mock.calls.length).toEqual(2);
      expect(b.getTransceivers()[0]).not.toBe(oldTransceiver);
    },
  );

  negotiationCase(
    "rollback keeps a remote-created transceiver that received a local track",
    { ref: "2.3-5 2.3-7 2.8-36" },
    async (c) => {
      // Arrange: remote offer で作成された transceiver に application が送信 track を付ける。
      const { a, b } = await c.given(createPeerPair());
      const localTrack = new MediaStreamTrack({ kind: "audio" });
      a.addTransceiver("audio", { direction: "sendonly" });
      const offer = await a.createOffer();
      await c.setRemote(b, offer);
      const transceiver = b.getTransceivers()[0];
      b.addTrack(localTrack);

      // Act: remote offer を取り消す。
      await c.setRemote(b, "rollback");

      // Assert: application 所有の sender/track は残り、旧 m-line との関連だけ外れる。
      expect(b.getTransceivers()).toContain(transceiver);
      expect(transceiver.sender.track).toBe(localTrack);
      expect(transceiver.mid).toEqual(null);
      expect(transceiver?.mLineIndex).toEqual(undefined);
    },
  );

  negotiationCase(
    "setLocalDescription accepts only the last created offer",
    { ref: "2.9-4 2.9-T10 2.9-T11" },
    async (c) => {
      // Arrange: offer を 2 回作り、1 回目の offer と書き換えた最新 offer を用意する。
      const { a } = await c.given(createPeerPair());
      a.addTransceiver("audio");
      const older = await a.createOffer();
      const latest = await a.createOffer();
      expect(older.sdp).not.toEqual(latest.sdp);

      // Act: 最新ではない / 書き換えた local offer を適用する。W3C どおり InvalidModificationError で拒否し、状態は変えない。
      await c.setLocal(a, older, { rejects: "InvalidModificationError" });
      await c.setLocal(a, latest.sdp.replace("a=sendrecv", "a=recvonly"), {
        rejects: "InvalidModificationError",
      });
      await c.setLocal(
        a,
        latest.sdp.replace(
          /a=ice-ufrag:[^\r\n]+/,
          "a=ice-ufrag:wronggeneration",
        ),
        { rejects: "InvalidModificationError" },
      );

      // Assert: stable のまま pending offer はない。
      expect(a.signalingState).toEqual("stable");
      expect(a.pendingLocalDescription).toEqual(null);

      // Act: 最新の offer を適用する。
      await c.setLocal(a, latest);

      // Assert: 最新 offer だけが pending になる。
      expect(a.signalingState).toEqual("have-local-offer");
      expect(a.pendingLocalDescription!.sdp).toContain("a=sendrecv");
    },
  );

  negotiationCase.for([
    { peer: "a peer that never created an offer", connected: false },
    {
      peer: "a connected peer whose own offers were already applied",
      connected: true,
    },
  ] as const)(
    "an offer created by another peer is rejected by $peer",
    { ref: "2.9-4" },
    async (c, { peer, connected }) => {
      // Arrange: offer を作る側と、それを自分の offer として渡される側を用意する。connected なら接続し、answerer 自身も一度 offer を作って適用し、交渉を完了させておく。
      const { a, b } = await c.given(createUnnegotiatedVideoPeers());
      if (connected === true) await c.negotiate(a);
      if (connected === true)
        await Promise.all([
          waitForIce(a),
          waitForIce(b),
          waitForConnection(a),
          waitForConnection(b),
        ]);
      if (connected === true) await c.negotiate(b);
      const foreignOffer = await a.createOffer();
      const phase = negotiationInternals(b).negotiation.inspect().phase;

      // Act: 他の peer が作った offer を setLocalDescription に渡す。拒否され、signaling state・pending/current description は変わらない。
      await c.setLocal(b, foreignOffer, {
        rejects: "InvalidModificationError",
      });

      // Assert: pending local はなく transaction も変わらない。
      expect(b.pendingLocalDescription).toEqual(null);
      expect(negotiationInternals(b).negotiation.inspect().phase).toEqual(
        phase,
      );

      // Act: 自分で作った offer なら適用できる。
      await c.offer(b, { hold: true });

      // Assert: 自身の offer で have-local-offer に進む。
      expect(b.signalingState).toEqual("have-local-offer");
    },
  );

  negotiationCase(
    "an unsupported offered codec rejects only its m-line",
    {
      ref: "origin: codec intersection per m-line",
      exempt:
        "the peers share no audio codec, so the audio transceiver the continuation adds cannot carry RTP",
    },
    async (c) => {
      // Arrange: codec の共通集合がない audio offer を作る。
      const { a, b } = await c.given(
        createPeerPair(
          {
            codecs: {
              audio: [
                new RTCRtpCodecParameters({
                  mimeType: "audio/PCMU",
                  clockRate: 8000,
                  channels: 1,
                }),
              ],
            },
          },
          {
            codecs: {
              audio: [
                new RTCRtpCodecParameters({
                  mimeType: "audio/opus",
                  clockRate: 48000,
                  channels: 2,
                }),
              ],
            },
          },
        ),
      );
      const onTrack = vi.fn();
      b.onTrack.subscribe(onTrack);
      a.addTransceiver("audio");
      await c.offer(a);

      // Act: remote offer を受け、answer を適用する。
      await c.setLocal(b, await b.createAnswer());

      // Assert: m-line 単位で拒否し、track event を送らない。
      expect(b.currentLocalDescription!.sdp).toMatch(/m=audio 0 /);
      expect(onTrack.mock.calls.length).toEqual(0);
    },
  );

  negotiationCase(
    "initial pranswer starts provisional DataChannel traffic and rollback closes it",
    { ref: "2.1-T4 2.2-4 2.2-5 2.2-16 2.2-17 2.3-13 2.3-14 2.3-16" },
    async (c) => {
      // Arrange: application m-line を持つ初回 offer を適用する。
      const { a, b } = await c.given(createPeerPair());
      const localChannel = a.createDataChannel("provisional");
      const events = recordNegotiationEvents(b);
      await c.offer(a);

      // Act: final answer を待たずに pranswer で接続する。
      const answer = await c.pranswer(b);
      await c.waitFor(() => localChannel.readyState === "open", 5000);

      // Assert: stable/current は空のままで provisional channel が公開される。
      expect(localChannel.readyState).toEqual("open");
      expect(events.dataChannels.at(-1)?.label).toEqual("provisional");
      expect(a.currentRemoteDescription).toEqual(null);
      expect(b.currentLocalDescription).toEqual(null);

      // Act: provisional negotiation を rollback する。
      await c.rollback(a);

      // Assert: current は空で pending-only association の channel は閉じる。
      expect(localChannel.readyState).toEqual("closed");
      expect(a.currentLocalDescription).toEqual(null);
      expect(a.iceTransports[0].connection.remoteUsername).not.toEqual(
        ufragOf(answer.sdp),
      );
    },
  );

  negotiationCase(
    "initial pranswer carries provisional RTP before final commit",
    { ref: "2.1-T1 2.2-1 2.2-2 2.3-1 2.3-3 2.3-6 2.7-3 5-3" },
    async (c) => {
      // Arrange: video の初回 offer を受け、receiver を pending に生成する。
      const { a, b } = await c.given(createPeerPair());
      const outgoing = new MediaStreamTrack({ kind: "video" });
      const events = recordNegotiationEvents(b);
      a.addTransceiver(outgoing, { direction: "sendonly" });
      await c.offer(a);

      // Act: 双方の pranswer だけで ICE/DTLS と RTP を開始する。
      const answer = await c.pranswer(b);
      await Promise.all([waitForConnection(a), waitForConnection(b)]);
      expect(events.tracks.length).toBeGreaterThan(0);
      await c.rtp(outgoing, events.tracks[0].track);

      // Act / Assert: 接続済み provisional DTLS の証明書差替えは拒否する。
      await c.setRemote(
        a,
        answer.sdp.replace(
          /a=fingerprint:sha-256 [^\r\n]+/,
          "a=fingerprint:sha-256 " + Array(32).fill("00").join(":"),
        ),
        { type: "answer", rejects: "InvalidModificationError" },
      );

      // Assert: current description は空のまま通信し、rollback で仮 transceiver を除外する。
      expect(b.currentRemoteDescription).toEqual(null);
      expect(a.currentLocalDescription).toEqual(null);
      await c.rollback(a);
      expect(b.getTransceivers().length).toEqual(0);
    },
  );

  negotiationCase(
    "a final answer can replace provisional SCTP limits without another channel event",
    { ref: "2.2-5 2.2-12 2.2-15 2.3-18 5-4" },
    async (c) => {
      // Arrange: application offer と provisional answer を作る。
      const { a, b } = await c.given(createPeerPair());
      const channel = a.createDataChannel("limits");
      const onDataChannel = vi.fn();
      b.onDataChannel.subscribe(onDataChannel);
      await c.offer(a);
      const answer = await b.createAnswer();
      const maxMessageSize = (size: number) =>
        answer.sdp.replace(
          /a=max-message-size:[^\r\n]+/,
          "a=max-message-size:" + size,
        );
      await c.setLocal(b, maxMessageSize(4096), { type: "pranswer" });
      await c.setRemote(a, b.localDescription);
      await c.waitFor(() => channel.readyState === "open", 5000);

      // Act: provisional answer を置換しても既存 channel object を再通知しない。
      await c.setLocal(b, maxMessageSize(3072), { type: "pranswer" });
      await c.setRemote(a, b.localDescription);
      expect(a.currentRemoteDescription).toEqual(null);
      expect(channel.readyState).toEqual("open");

      // Act: 最終 answer では別の max-message-size を採用する。
      await c.setLocal(b, maxMessageSize(2048), { type: "answer" });
      await c.setRemote(a, b.localDescription);

      // Assert: final SDP と association の上限が一致し、channel は再通知されない。
      expect(a.sctpTransport!.remoteMaxMessageSize).toEqual(2048);
      expect(channel.readyState).toEqual("open");
      expect(onDataChannel.mock.calls.length).toEqual(1);
    },
  );

  negotiationCase(
    "duplicate trickle candidate and EOC are idempotent within one generation",
    { ref: "2.1-10 2.3-21" },
    async (c) => {
      // Arrange: gathered candidate と EOC を含む offer を適用する。
      const { a, b } = await c.given(createPeerPair());
      a.addTransceiver("audio");
      await c.offer(a);
      const sdp = b.remoteDescription!.sdp;
      const mid = sdp.match(/a=mid:([^\r\n]+)/)![1];
      const candidate = {
        candidate: sdp.match(/a=(candidate:[^\r\n]+)/)![1],
        sdpMid: mid,
        usernameFragment: ufragOf(sdp),
      };
      const eoc = {
        candidate: "",
        sdpMid: mid,
        usernameFragment: ufragOf(sdp),
      };
      const beforeCount = b.iceTransports[0].getRemoteCandidates().length;

      // Act: 同じ candidate と EOC を二度ずつ trickle する。
      await c.addCandidate(b, candidate);
      await c.addCandidate(b, candidate);
      await c.addCandidate(b, eoc);
      await c.addCandidate(b, eoc);

      // Assert: description と ICE checklist に重複しない。
      expect(b.remoteDescription!.sdp).toEqual(sdp);
      expect(b.iceTransports[0].getRemoteCandidates().length).toEqual(
        beforeCount,
      );
    },
  );

  negotiationCase(
    "both peers commit matching local and remote ICE restart generations",
    { ref: "2.1-T7 2.2-3 2.2-6 2.7-T1 2.7-T3 2.7-T4a 5-K6" },
    async (c) => {
      // Arrange: current nomination と generation を控える。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers(),
      );
      const oldGeneration = a.iceGeneration;
      const oldPair = a.iceTransports[0].getSelectedCandidatePair();
      const oldDtls = a.dtlsTransports[0];

      // Act: local restart offer は pending に置き、旧 nomination を維持する。
      const offer = await a.createOffer({ iceRestart: true });
      const offeredUfrag = ufragOf(offer.sdp);
      expect(a.iceGeneration).toEqual(oldGeneration);
      await c.setLocal(a, offer);
      expect(a.iceTransports[0].getSelectedCandidatePair()).toEqual(oldPair);
      await c.rtp(outgoing, incoming);

      // Act: remote peer も新 generation を answer し、双方で確定する。
      await c.setRemote(b, a.localDescription);
      const answer = await b.createAnswer();
      const answeredUfrag = ufragOf(answer.sdp);
      await c.setLocal(b, answer, { type: "pranswer" });
      await c.setRemote(a, b.localDescription);

      // Assert: pranswer だけで新しい ICE generation が provisional に nominate される。
      await Promise.all([
        waitForProvisionalNomination(a),
        waitForProvisionalNomination(b),
      ]);

      // Assert: pranswer 中は旧 nomination で RTP が続き、current は旧 SDP のまま。
      expect(a.iceTransports[0].getSelectedCandidatePair()).toEqual(oldPair);
      expect(a.iceGeneration).toEqual(oldGeneration);
      await c.rtp(outgoing, incoming);

      // Act: 最終 answer で新 generation へ切り替える。
      await c.setLocal(b, answer);
      await c.setRemote(a, b.localDescription);
      await Promise.all([
        waitForIce(a),
        waitForIce(b),
        waitForConnection(a),
        waitForConnection(b),
      ]);

      // Assert: answer SDP、transport credentials と新 nomination が一致し、DTLS association は restart 前のものを使い続ける。
      expect(a.dtlsTransports).toEqual([oldDtls]);
      expect(a.iceGeneration).toBeGreaterThan(oldGeneration);
      expect(a.iceTransports[0].localParameters.usernameFragment).toEqual(
        offeredUfrag,
      );
      expect(b.iceTransports[0].localParameters.usernameFragment).toEqual(
        answeredUfrag,
      );
      expect(a.iceTransports[0].getSelectedCandidatePair()).not.toEqual(null);
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase(
    "partial BUNDLE keeps an unbundled media transport independent",
    { ref: "origin: partial BUNDLE (RFC 8843 7.3.2)" },
    async (c) => {
      // Arrange: audio/application は BUNDLE、video は独立する offer を offerer 自身が出す (offer で共有した transport を answer だけが分割することはできない: RFC 8843 7.3.2)。
      const { a, b } = await c.given(createPeerPair());
      const video = new MediaStreamTrack({ kind: "video" });
      const events = recordNegotiationEvents(b);
      a.addTransceiver("audio");
      a.addTransceiver(video, { direction: "sendonly" });
      a.createDataChannel("bundle");
      const probe = await a.createOffer();
      const mids = [...probe.sdp.matchAll(/a=mid:([^\r\n]+)/g)].map(
        (m) => m[1],
      );
      await c.setLocal(
        a,
        await createRewrittenOffer(a, (sdp) =>
          withBundle(sdp, [mids[0], mids[2]]),
        ),
      );

      // Act: 部分 BUNDLE offer を適用して answer を作る。
      await c.setRemote(b, a.localDescription);
      const answer = await b.createAnswer();

      // Assert: BUNDLE owner と独立 media の ICE/DTLS transport が分かれる。
      const [audio, remoteVideo] = b.getTransceivers();
      expect(answer.sdp).toContain("a=group:BUNDLE " + mids[0] + " " + mids[2]);
      expect(audio.dtlsTransport).toBe(b.sctpTransport!.dtlsTransport);
      expect(remoteVideo.dtlsTransport).not.toBe(audio.dtlsTransport);

      // Act: final answer 後に video RTP を独立 transport で送る。
      await c.setLocal(b, answer);
      await c.setRemote(a, b.localDescription);
      await Promise.all([
        waitForIce(a),
        waitForIce(b),
        waitForConnection(a),
        waitForConnection(b),
      ]);
      const receivedVideo = events.tracks.find(
        (e) => e.track.kind === "video",
      )!.track;
      await c.rtp(video, receivedVideo);

      // Act / Assert: 接続済み SCTP を別 DTLS owner へ移す answer / offer は適用前に拒否する。
      await c.setLocal(
        a,
        await createRewrittenOffer(a, (sdp) =>
          withBundle(sdp, [mids[1], mids[0], mids[2]]),
        ),
      );
      await c.setRemote(
        a,
        withBundle(a.currentRemoteDescription!.sdp, [
          mids[1],
          mids[0],
          mids[2],
        ]),
        { type: "answer", rejects: "InvalidModificationError" },
      );

      // Act / Assert: 受信側は offer の validate で拒否し、stable の current を保つ。
      await c.setRemote(b, a.localDescription, {
        rejects: "InvalidModificationError",
      });
      expect(b.signalingState).toEqual("stable");
      await c.setLocal(a, "rollback");
      await c.rtp(video, receivedVideo);

      // Act: 次の offer で全 m-line を BUNDLE に戻す。
      const oldVideoTransport = remoteVideo.dtlsTransport;
      await c.offer(a);
      const mergedAnswer = await b.createAnswer();
      expect(remoteVideo.dtlsTransport).toBe(oldVideoTransport);
      await c.rtp(video, receivedVideo);
      await c.setLocal(b, mergedAnswer);
      await c.setRemote(a, b.localDescription);

      // Assert: 旧 video owner は解放され、共有 transport で RTP が届く。
      expect(remoteVideo.dtlsTransport).toBe(audio.dtlsTransport);
      expect(oldVideoTransport.state).toEqual("closed");
      await c.rtp(video, receivedVideo);
    },
  );

  negotiationCase(
    "description and trickle operations serialize, and a rolled-back ufrag cannot be buffered",
    { ref: "origin: operations chain" },
    async (c) => {
      // Arrange: 同じ tick に渡す remote offer と candidate を用意する。candidate の trickle がまだ続いている offer として渡す (EOC 後の候補は破棄される)。
      const { a, b } = await c.given(createPeerPair());
      a.addTransceiver("audio");
      await c.offer(a, { hold: true });
      const offer = withoutEoc(a.localDescription!.sdp);
      const candidate = {
        candidate:
          "candidate:serial 1 udp 2113937151 192.0.2.13 12348 typ host",
        sdpMid: offer.match(/a=mid:([^\r\n]+)/)![1],
        usernameFragment: ufragOf(offer),
      };

      // Act: SRD と trickle を待たずに連続で開始する。
      await Promise.all([
        b.setRemoteDescription({ type: "offer", sdp: offer }),
        b.addIceCandidate(candidate),
      ]);

      // Assert: candidate は新しい pending description にだけ付く。
      expect(b.pendingRemoteDescription!.sdp).toContain("serial");
      await c.setRemote(b, "rollback");

      // Act / Assert: 破棄済み generation の遅延 candidate は次回用キューに入らない。
      await c.addCandidate(b, candidate, { rejects: "OperationError" });
    },
  );

  negotiationCase(
    "a trickle candidate of the unchanged ICE generation reaches the live checklist during a re-offer",
    { ref: "origin: same-generation trickle during a re-offer" },
    async (c) => {
      // Arrange: EOC 前の世代のまま ICE restart なしの re-offer を pending にし、同じ ufrag の新しい候補を作る。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers({}, { trickleOpen: true }),
      );
      await c.offer(a, { hold: true });
      await c.setRemote(b, withoutEoc(a.localDescription!.sdp));
      const offer = a.localDescription!.sdp;
      const candidate = trickleCandidate(
        40999,
        ufragOf(offer),
        offer.match(/^a=mid:(.*?)\r?$/m)![1],
      );
      const live = () =>
        b.iceTransports[0].connection.remoteCandidates.filter(
          (r) => r.port === 40999,
        ).length;
      expect(live()).toEqual(0);

      // Act: 同じ候補を 2 回 trickle する。
      await c.addCandidate(b, candidate);
      await c.addCandidate(b, candidate);

      // Assert: pending と current の両 SDP に記録され、稼働中 checklist には 1 回だけ届く。
      expect(b.pendingRemoteDescription!.sdp).toContain(" 40999 typ host");
      expect(b.currentRemoteDescription!.sdp).toContain(" 40999 typ host");
      expect(live()).toEqual(1);

      // Act: re-offer を rollback する。
      await c.rollback(b);

      // Assert: 同じ世代の候補は current に残り、既存 RTP も届く。
      expect(b.currentRemoteDescription!.sdp).toContain(" 40999 typ host");
      expect(live()).toEqual(1);
      await c.rtp(outgoing, incoming);
    },
  );
});
