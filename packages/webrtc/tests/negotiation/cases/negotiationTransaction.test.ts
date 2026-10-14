import { RTCIceTransport, RTCRtpCodecParameters } from "../../../src";
import type { RTCDtlsTransport, RTCPeerConnection } from "../../../src";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import { ufragOf } from "../harness/negotiationTransactionUtils";
import {
  addNegotiatedAudio,
  createConnectedVideoPeers,
  createDuplexSession,
  createPeerPair,
  createSimulcastPeers,
  createSplitOffer,
  createUnnegotiatedVideoPeers,
  failOnce,
  negotiationInternals,
  recordNegotiationEvents,
  waitForCommittedNomination,
  waitForConnection,
  waitForDtlsConnected,
  waitForIce,
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
});
