import { MediaStreamTrack, useH264, useVP8 } from "../../../src";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  assertTransportsClosed,
  closeDuringNextPreparedGather,
  closeOnSignalingState,
  createConnectedMultiVideoPeers,
  createConnectedVideoPeers,
  createPeerPair,
  createRelayOnlyPeers,
  createRewrittenOffer,
  createSimulcastPeers,
  createSplitOffer,
  createUnnegotiatedPeers,
  createUnnegotiatedVideoPeers,
  createVp8H264AnsweringPeers,
  expectSessionContinues,
  forceIceState,
  heldTransports,
  holdDtlsStart,
  holdNextGather,
  offeredVideoCodecs,
  receiveCodecNames,
  recordConnectionStates,
  recordIceConnectionStates,
  recordNegotiationEvents,
  sectionOf,
  settlesWithin,
  waitForCommittedNomination,
  waitForConnection,
  waitForDtlsConnected,
  waitForDtlsHandshake,
  waitForIce,
  waitForPeersConnected,
} from "../harness/negotiationTransactionUtils";

/** Wait for the next macrotask (`setImmediate`). */
const nextMacrotask = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Deterministic regressions for what the negotiation property test found
 * (see tests/pbt/fuzz/negotiationTransactionProperty.test.ts for the seeds).
 */
describeCases("negotiation transaction regressions", () => {
  negotiationCase.for([
    { offerer: "a", answerer: "b" },
    { offerer: "b", answerer: "a" },
  ] as const)(
    "a relay-only ICE restart offered by $offerer nominates once the held TURN allocation completes after the peer's candidates",
    { ref: "2.11-14; origin: property test" },
    async (c, { offerer, answerer }) => {
      // Arrange: 両 peer が relay-only で、DataChannel が TURN 経由で開いている。
      const { a, b, remote, channel, proxy, candidateErrors } = await c.given(
        createRelayOnlyPeers(),
      );
      const connections = () =>
        [a, b].map((pc) => pc.iceTransports[0].connection);
      const previous = connections().map(
        (connection) => connection.localUsername,
      );

      // Act: b の新しい TURN allocation を保留したまま ICE restart を確定する (a の relay 候補と end-of-candidates が、b のローカル候補より先に b へ届く)。
      proxy.hold();
      await c.offer(c.named(offerer), { iceRestart: true });
      await c.answer(c.named(answerer));
      await c.sleep(300);

      // Act: b の allocation を完了させる。
      proxy.release();

      // Assert: 両側が新しい generation の relay pair を nominate する。
      await c.waitFor(
        () =>
          connections().every(
            (connection, index) =>
              connection.localUsername !== previous[index] &&
              connection.nominated?.localCandidate.type === "relay" &&
              connection.nominated.localCandidate.ufrag ===
                connection.localUsername,
          ),
        15000,
      );

      // Assert: 元の DataChannel が relay 経由で双方向に届き、候補の配送は失敗しない。
      await c.data(channel, remote);
      await c.data(remote, channel);
      expect(candidateErrors).toEqual([]);
      c.invariants();
    },
  );

  negotiationCase(
    "close() from the stable event of a glare implicit rollback adds no pending offer and leaves no transport running",
    {
      ref: "2.11-15; origin: property test",
      exempt: "close() is the operation under test",
    },
    async (c) => {
      // Arrange: a は local offer を保留し、b は audio と video を足した offer を持つ。
      const { a, b } = await c.given(createPeerPair());
      a.addTransceiver("audio");
      b.addTransceiver("audio", { direction: "sendonly" });
      b.addTransceiver("video", { direction: "sendonly" });
      await c.offer(a, { hold: true });
      await c.offer(b, { hold: true });
      const closed = c.start(closeOnSignalingState(a, "stable"));

      // Act: glare の implicit rollback が通知する stable の handler から close() する。close に追い越された操作は InvalidStateError で失敗する。
      await c.setRemote(a, b.localDescription, {
        rejects: "InvalidStateError",
      });
      await closed;

      // Assert: 閉鎖後に pending の remote offer も新しい transceiver も追加されない。
      expect(a.signalingState).toEqual("closed");
      expect(a.pendingRemoteDescription).toBe(null);
      expect(a.getTransceivers().length).toEqual(1);

      // Assert: a が保持する transport (transceiver・交渉が作ったものを含む) はすべて閉じている。
      assertTransportsClosed([
        ...heldTransports(a),
        ...a.getTransceivers().map((t) => t.dtlsTransport),
      ]);
    },
  );

  negotiationCase(
    "close() from the stable event of a new local offer that rolls a remote pranswer back adds no pending offer and leaves no transport running",
    {
      ref: "2.11-15; origin: property test",
      exempt: "close() is the operation under test",
    },
    async (c) => {
      // Arrange: a の offer に b が pranswer を返し、a は have-remote-pranswer にある。
      const { a, b } = await c.given(createPeerPair());
      a.addTransceiver("audio");
      await c.offer(a);
      await c.pranswer(b);
      expect(a.signalingState).toEqual("have-remote-pranswer");
      a.addTransceiver("video");
      const offer = await a.createOffer();
      const closed = c.start(closeOnSignalingState(a, "stable"));

      // Act: pranswer を暗黙に rollback する新しい offer の stable の handler から close() する。close に追い越された操作は InvalidStateError で失敗する。
      await c.setLocal(a, offer, { rejects: "InvalidStateError" });
      await closed;

      // Assert: offer は pending にならない。
      expect(a.signalingState).toEqual("closed");
      expect(a.pendingLocalDescription).toBe(null);

      // Assert: a が保持する transport はすべて閉じている。
      assertTransportsClosed([
        ...heldTransports(a),
        ...a.getTransceivers().map((t) => t.dtlsTransport),
      ]);
    },
  );

  negotiationCase(
    "a bundlePolicy disable renegotiation pranswer does not fail the connection and the final answer connects",
    { ref: "2.12-2; origin: property test" },
    async (c) => {
      // Arrange: bundlePolicy disable で audio と DataChannel が接続済み。
      const { a, b } = await c.given(
        createPeerPair({ bundlePolicy: "disable" }),
      );
      a.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
        direction: "sendrecv",
      });
      a.createDataChannel("disable");
      await c.negotiate(a);
      await waitForPeersConnected(a, b);
      const aStates = recordConnectionStates(a);
      const bStates = recordConnectionStates(b);
      const aOut = new MediaStreamTrack({ kind: "video" });
      const aTransceiver = a.addTransceiver(aOut, { direction: "sendrecv" });

      // Act: 新しい video (独自の transport) を足した re-offer に pranswer を返す。
      await c.offer(a);
      const pranswer = await c.pranswer(b);
      await c.sleep(1500);

      // Assert: remote パラメータのない transport を開始しないので、pranswer 中に failed にならない。
      expect(aStates).not.toContain("failed");
      expect(bStates).not.toContain("failed");
      expect([a.connectionState, b.connectionState]).toEqual([
        "connected",
        "connected",
      ]);

      // Act: final answer で確定する (pranswer と同じ SDP)。
      await c.setLocal(b, pranswer);
      await c.setRemote(a, b.localDescription);
      await waitForPeersConnected(a, b);

      // Assert: 新しい video の RTP が届き、どちらも failed を通らない。
      const bVideo = b
        .getTransceivers()
        .find((t) => t.mid === aTransceiver.mid);
      await waitForDtlsConnected(aTransceiver.dtlsTransport);
      await waitForDtlsConnected(bVideo!.dtlsTransport);
      await c.rtp(aOut, bVideo!.receiver.track);
      expect(aStates).not.toContain("failed");
      expect(bStates).not.toContain("failed");
    },
  );

  negotiationCase(
    "a simulcast layer whose MID extension names no route is still routed by its RID (as develop)",
    { ref: "2.12-5; origin: property test (develop comparison)" },
    async (c) => {
      // Arrange: simulcast (high / low) を受信する接続済み session。
      const { b, sendLayer } = await c.given(createSimulcastPeers());

      // Act / Assert: どの route も使わない MID 値と RID を持つ RTP も、RID の層に届く。
      await sendLayer("high", 0x5001, "rid-unknown-mid-high", {
        withRid: true,
        headerMid: "unrouted",
      });
      await sendLayer("low", 0x5002, "rid-unknown-mid-low", {
        withRid: true,
        headerMid: "unrouted",
      });

      // Assert: MID が route と一致する RTP は従来どおり MID+RID で届く。
      await sendLayer("high", 0x5003, "rid-known-mid-high", { withRid: true });
      c.invariants(b);
    },
  );

  negotiationCase(
    "the final answer after an ICE restart pranswer reuses the pranswer credentials",
    { ref: "2.9-7; origin: property test" },
    async (c) => {
      // Arrange: ICE restart offer に pranswer を返す。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers(),
      );
      const ufragOf = (sdp: string) => sdp.match(/^a=ice-ufrag:(.*?)\r?$/m)![1];
      await c.offer(a, { iceRestart: true });
      const pranswer = await c.pranswer(b);

      // Act: 最終 answer を改めて作って適用する。
      const answer = await c.answer(b);

      // Assert: pranswer で広告した資格情報のまま確定し、live と SDP が一致して RTP が届く。
      expect(ufragOf(answer.sdp)).toEqual(ufragOf(pranswer.sdp));
      expect(b.iceTransports[0].connection.localUsername).toEqual(
        ufragOf(pranswer.sdp),
      );
      c.invariants();
      await Promise.all([
        waitForCommittedNomination(a),
        waitForCommittedNomination(b),
      ]);
      await c.rtp(outgoing, incoming);
    },
  );
});

/** Findings of the pre-review self-review of pending writes to live state. */
describeCases("negotiation transaction live-state regressions", () => {
  negotiationCase(
    "a transceiver created for a remote offer does not make negotiation needed",
    { ref: "2.3-20 2.4-6 5-K6; origin: self-review (live state)" },
    async (c) => {
      // Arrange: answerer の negotiationneeded を数える。
      const { a, b } = await c.given(createConnectedVideoPeers());
      const events = recordNegotiationEvents(b);

      // Act: audio m-line を足した offer を受けて answer を返す。
      a.addTransceiver("audio", { direction: "sendonly" });
      await c.negotiate(a);
      await nextMacrotask();

      // Assert: remote offer 由来の transceiver では再交渉は要求されない。
      expect(events.negotiationNeeded).toEqual(0);
      expect(b.getTransceivers().length).toEqual(2);
    },
  );

  negotiationCase(
    "adding video after an inactive audio m-line does not take the audio m-line",
    { ref: "2.4-7; origin: self-review (live state)" },
    async (c) => {
      // Arrange: inactive な audio m-line を確定させる。
      const { a } = await c.given(createUnnegotiatedPeers());
      const audio = a.addTransceiver("audio", { direction: "inactive" });
      await c.negotiate(a);
      const audioMid = audio.mid;
      expect(audio.currentDirection).toEqual("inactive");

      // Act: 別 kind の video を追加して、自身の offer を作って適用する。
      const video = a.addTransceiver("video");
      await c.offer(a, { hold: true });

      // Assert: audio は MID と index を保ち、video は新しい m-line を末尾に持つ。
      expect(audio.mid).toBe(audioMid);
      expect(audio.mLineIndex).toEqual(0);
      expect(video.mid).not.toBe(audioMid);
      expect(video.mLineIndex).toEqual(1);
      expect(a.getTransceivers()).toEqual([audio, video]);
    },
  );

  negotiationCase(
    "close() during a pending BUNDLE split stops the transports the proposal prepared",
    {
      ref: "2.8-17; origin: self-review (live state)",
      exempt: "close() is the operation under test",
    },
    async (c) => {
      // Arrange: video と audio を BUNDLE で共有する接続済み peer で、audio を分割する offer を適用中にする
      const { a, b } = await c.given(
        createConnectedVideoPeers({}, { withAudio: true }),
      );
      const audioMid = a.getTransceivers().find((t) => t.kind === "audio")!.mid;
      const liveBefore = a.dtlsTransports.length;
      await c.setLocal(a, await createSplitOffer(a, audioMid!));
      const held = heldTransports(a);
      expect(held.size).toBeGreaterThan(liveBefore);

      // Act: pending のまま close する
      await a.close();
      await b.close();

      // Assert: 分割用に用意した transport も含め、すべての DTLS / ICE が閉じる
      assertTransportsClosed(held);
    },
  );

  negotiationCase(
    "a local pranswer applied again over a connected BUNDLE split keeps its checks settled through the final answer and close()",
    { ref: "2.12-9; origin: self-review (live state)" },
    async (c) => {
      // Arrange: audio を分割する re-offer に pranswer を返し、分割先の transport で暫定接続する。
      const { a, b } = await c.given(
        createConnectedVideoPeers({}, { withAudio: true }),
      );
      const audioMid = a.getTransceivers().find((t) => t.kind === "audio")!.mid;
      await c.setLocal(a, await createSplitOffer(a, audioMid!));
      await c.setRemote(b, a.localDescription);
      const answer = await b.createAnswer();
      await c.setLocal(b, answer.sdp, { type: "pranswer" });
      await c.setRemote(a, answer.sdp, { type: "pranswer" });
      const held = [...heldTransports(a), ...heldTransports(b)];
      await Promise.all(
        held.map((transport) => waitForDtlsConnected(transport)),
      );
      const iceStates = () => held.map((t) => t.iceTransport.state);
      const connected = iceStates();
      expect(
        connected.filter((s) => !["connected", "completed"].includes(s)),
      ).toEqual([]);

      // Act: 同じ local pranswer をもう一度適用する。
      await c.setLocal(b, answer.sdp, { type: "pranswer" });
      await c.sleep(300);

      // Assert: 接続済みの generation の checks はやり直さず (checking に戻らない)、待機は決着している。
      expect(iceStates()).toEqual(connected);
      expect(
        await Promise.all(
          held.map((t) => settlesWithin(t.iceTransport.checksSettled(), 1000)),
        ),
      ).toEqual(held.map(() => true));
      c.invariants(b);

      // Act: final answer で確定する。
      await c.setLocal(b, answer.sdp, { type: "answer" });
      await c.setRemote(a, answer.sdp, { type: "answer" });
      await waitForPeersConnected(a, b);

      // Assert: 確定後も checking に戻らず、集約した接続状態と一致する。
      expect([a.connectionState, b.connectionState]).toEqual([
        "connected",
        "connected",
      ]);
      expect(
        [...a.iceTransports, ...b.iceTransports]
          .map((t) => t.state)
          .filter((s) => !["connected", "completed"].includes(s)),
      ).toEqual([]);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(a, b, "split-pranswer-again");

      // Act: close する。
      c.exempt("close() is the operation under test after the continuation");
      const transports = [...heldTransports(a), ...heldTransports(b), ...held];
      await Promise.all([a.close(), b.close()]);

      // Assert: すべての transport が閉じ、checks の待機も決着する。
      assertTransportsClosed(transports);
      expect(
        await Promise.all(
          transports.map((t) =>
            settlesWithin(t.iceTransport.checksSettled(), 1000),
          ),
        ),
      ).toEqual(transports.map(() => true));
    },
  );

  negotiationCase(
    "close() after a provisional split connection stops both peers' pending transports",
    {
      ref: "2.2-3 2.7-3 2.8-17; origin: self-review (live state)",
      exempt: "close() is the operation under test",
    },
    async (c) => {
      // Arrange: audio を分割する re-offer に pranswer を返し、分割先の transport で暫定接続する
      const { a, b } = await c.given(
        createConnectedVideoPeers({}, { withAudio: true }),
      );
      const audioMid = a.getTransceivers().find((t) => t.kind === "audio")!.mid;
      await c.setLocal(a, await createSplitOffer(a, audioMid!));
      await c.setRemote(b, a.localDescription);
      const answer = await b.createAnswer();
      await c.setLocal(b, answer.sdp, { type: "pranswer" });
      await c.setRemote(a, answer.sdp, { type: "pranswer" });
      const held = [...heldTransports(a), ...heldTransports(b)];
      await Promise.all(
        held.map((transport) => waitForDtlsConnected(transport)),
      );

      // Act: 両 peer を pending のまま close する
      await a.close();
      await b.close();

      // Assert: 暫定接続した transport も含め、ICE / DTLS が動き続けない
      assertTransportsClosed(held);
    },
  );

  negotiationCase(
    "restartIce() beside a new m-line with bundlePolicy disable offers the new transport's gathered candidates",
    { ref: "2.8-7; origin: self-review (live state)" },
    async (c) => {
      // Arrange: BUNDLE しない接続済み peer
      const { a, b } = await c.given(
        createPeerPair({ bundlePolicy: "disable" }),
      );
      a.addTransceiver("audio");
      await c.negotiate(a);

      // Act: 新しい m-line の追加と ICE restart を 1 つの offer で行う
      const video = a.addTransceiver("video");
      a.restartIce();
      await c.offer(a, { hold: true });

      // Assert: まだ generation を持たない新しい transport は restart を stage せず、集めた候補を offer する
      expect(sectionOf(a.localDescription!.sdp, video.mid!)).toMatch(
        /^a=candidate:/m,
      );
      await c.setRemote(b, a.localDescription);
      await c.answer(b);
      await waitForDtlsConnected(video.dtlsTransport);
      c.invariants(a);
    },
  );

  negotiationCase(
    "close() while an ICE restart answer commits keeps the state closed",
    {
      ref: "2.8-19; origin: self-review (live state)",
      exempt: "close() is the operation under test",
    },
    async (c) => {
      // Arrange: ICE restart の answer を適用する直前まで交渉する
      const { a, b } = await c.given(createConnectedVideoPeers());
      a.restartIce();
      await c.offer(a);
      await c.answer(b, { hold: true });

      // Act: answer の適用 (restart の commit) の途中で close する
      const gather = holdNextGather(a);
      const applying = c.start(a.setRemoteDescription(b.localDescription!));
      await gather.reached;
      await a.close();
      gather.release();

      // Assert: close に追い越された操作は成功を報告せず、signalingState は closed のまま
      await c.rejects(applying, "InvalidStateError");
      expect(a.signalingState).toEqual("closed");
    },
  );

  negotiationCase(
    "an answer applied during the DTLS handshake keeps the connected ICE state",
    { ref: "2.8-23 2.8-24 2.8-26; origin: self-review (live state)" },
    async (c) => {
      // Arrange: 初回交渉の answerer 側 DTLS 開始を止め、offerer の handshake を ICE 接続済み・DTLS connecting の状態に留める。
      const { a, b, outgoing, incoming } = await c.given(
        createUnnegotiatedVideoPeers(),
      );
      await c.offer(a);
      await c.answer(b, { hold: true });
      const held = holdDtlsStart(b);
      await c.setRemote(a, b.localDescription);
      await waitForIce(a);
      await waitForDtlsHandshake(a.dtlsTransports[0]);

      // Act: handshake 中に次の offer/answer を交換し、answer を適用する。
      await c.negotiate(a);

      // Assert: 接続済みの ICE は checking に戻らず、DTLS 完了前に connected を報告しない。
      await c.sleep(100);
      expect(a.iceConnectionState).toEqual("connected");
      expect(a.dtlsTransports[0].state).toEqual("connecting");
      expect(a.connectionState).toEqual("connecting");

      // Act: 止めていた handshake を進める。
      held.release();
      await waitForDtlsConnected(a.dtlsTransports[0]);
      await waitForConnection(a);

      // Assert: ICE は connected のまま、DTLS 完了後に connected になり、RTP も届く。
      expect(a.iceConnectionState).toEqual("connected");
      expect(a.connectionState).toEqual("connected");
      await c.rtp(outgoing, incoming());
    },
  );

  negotiationCase(
    "an answer without an ICE restart leaves a failed ICE generation failed",
    { ref: "2.8-23 2.8-24 2.8-27; origin: self-review (live state)" },
    async (c) => {
      // Arrange: 確立済みの session で offerer の ICE generation を failed にする (consent の期限切れ相当)。
      const { a } = await c.given(createConnectedVideoPeers());
      forceIceState(a, "failed");
      const iceStates = recordIceConnectionStates(a);

      // Act: ICE restart を含まない再交渉を answer まで行う。
      await c.negotiate(a);
      await c.sleep(100);

      // Assert: failed の generation は接続確認をやり直さず (checking に戻らず)、connectionState も connected に上書きされない。
      expect(iceStates).not.toContain("checking");
      expect(a.iceConnectionState).toEqual("failed");
      expect(a.connectionState).not.toEqual("connected");
    },
  );

  negotiationCase(
    "an ICE restart keeps the configured icePasswordPrefix",
    { ref: "2.8-11; origin: self-review (live state)" },
    async (c) => {
      // Arrange: icePasswordPrefix を設定した接続済み peer。
      const { a } = await c.given(
        createConnectedVideoPeers({ icePasswordPrefix: "werift" }),
      );

      // Act: ICE restart の offer を作る
      a.restartIce();
      const offer = await a.createOffer();

      // Assert: 新しい generation の ICE password にも prefix が付く
      const password = offer.sdp.match(/^a=ice-pwd:(\S+)/m)![1];
      expect(password).toMatch(/^werift/);
      expect(password).not.toBe(
        a.currentLocalDescription!.sdp.match(/^a=ice-pwd:(\S+)/m)![1],
      );
    },
  );

  negotiationCase(
    "the local answer lists codecs in the answerer's preference order",
    { ref: "2.6-T4g; origin: self-review (live state)" },
    async (c) => {
      // Arrange: offerer は H264 → VP8、answerer は VP8 → H264 の順で設定する。
      const { a, b } = await c.given(
        createPeerPair(
          { codecs: { video: [useH264(), useVP8()] } },
          { codecs: { video: [useVP8(), useH264()] } },
        ),
      );
      a.addTransceiver("video");
      await c.offer(a);

      // Act: answer を作る。
      const answer = await b.createAnswer();

      // Assert: answer の codec 順は remote offer ではなく answerer の設定順になる。
      expect(offeredVideoCodecs(answer.sdp)).toEqual(["VP8", "H264"]);
    },
  );

  negotiationCase(
    "a saved answer commits its own codecs after an unapplied createOffer() resolved others",
    { ref: "2.8-37 2.8-38 2.9-8 2.9-T1; origin: self-review (live state)" },
    async (c) => {
      // Arrange: VP8 の answer を作って保存し、その後 H264 を選んで offer を作る (適用しない)。
      const {
        a,
        b,
        offererOut,
        answererOut,
        offererTransceiver,
        answererTransceiver,
      } = await c.given(createVp8H264AnsweringPeers());
      answererTransceiver.setCodecPreferences([useVP8()]);
      const answer = await b.createAnswer();
      answererTransceiver.setCodecPreferences([useH264()]);
      await b.createOffer();

      // Act: 保存した VP8 の answer を両 peer に適用する。
      await c.setLocal(b, answer);
      await c.setRemote(a, b.localDescription);
      await waitForPeersConnected(a, b);

      // Assert: 送受信は適用した answer の VP8 で確定し、双方向に RTP が届く。
      expect(offeredVideoCodecs(b.currentLocalDescription!.sdp)).toEqual([
        "VP8",
      ]);
      expect(answererTransceiver.sender?.codec?.mimeType.toLowerCase()).toEqual(
        "video/vp8",
      );
      expect(
        Object.values(receiveCodecNames(answererTransceiver.receiver)),
      ).toEqual(["VP8"]);
      await c.rtp(offererOut, answererTransceiver.receiver.track);
      await c.rtp(answererOut, offererTransceiver.receiver.track);

      // Assert: 未適用の offer で選んだ H264 は次の offer で解決し直される。
      const next = await b.createOffer();
      expect(offeredVideoCodecs(next.sdp)).toEqual(["H264"]);

      // Arrange: answerer の codec の選択を既定に戻す (H264 だけの選択は VP8 しか持たない offerer の次の offer と両立しない。develop と同じく sRD が失敗する)。
      answererTransceiver.setCodecPreferences([]);
    },
  );

  negotiationCase(
    "a max-compat first offer connects to a peer that answers without BUNDLE",
    { ref: "2.8-41 2.8-42; origin: self-review (live state)" },
    async (c) => {
      // Arrange: 既定 (max-compat) の offerer と、BUNDLE を使わず m-line ごとに独立した ICE 資格情報で答える answerer。
      const { a, b } = await c.given(
        createPeerPair({}, { bundlePolicy: "disable" }),
      );
      const audioOut = new MediaStreamTrack({ kind: "audio" });
      const videoOut = new MediaStreamTrack({ kind: "video" });
      a.addTransceiver(audioOut, { direction: "sendonly" });
      a.addTransceiver(videoOut, { direction: "sendonly" });

      // Act: 初回交渉を行い、すべての transport の接続を待つ。
      await c.negotiate(a);
      await Promise.all(
        [...a.dtlsTransports, ...b.dtlsTransports].map((transport) =>
          waitForDtlsConnected(transport),
        ),
      );

      // Assert: BUNDLE なしの answer を受理し、m-line ごとの transport で接続して audio・video とも届く。
      expect(a.signalingState).toEqual("stable");
      expect(new Set(a.dtlsTransports).size).toEqual(2);
      const received = (kind: string) =>
        b.getTransceivers().find((t) => t.kind === kind)!.receiver.track;
      await c.rtp(audioOut, received("audio"));
      await c.rtp(videoOut, received("video"));
    },
  );

  negotiationCase(
    "close() while createAnswer() prepares the transports of a BUNDLE split leaves none running",
    {
      ref: "2.8-18; origin: self-review (live state)",
      exempt: "close() is the operation under test",
    },
    async (c) => {
      // Arrange: 3 m-line の BUNDLE から 2 つを外す (owner transport を 2 つ準備させる) re-offer を受ける。
      const { a, b } = await c.given(createConnectedMultiVideoPeers(3));
      const mids = a.getTransceivers().map((t) => t.mid);
      expect(mids.length).toEqual(3);
      const split = await createRewrittenOffer(a, (sdp) =>
        sdp.replace(/^a=group:BUNDLE [^\r\n]+/m, "a=group:BUNDLE " + mids[0]),
      );
      await c.setLocal(a, split);
      await c.setRemote(b, a.localDescription);
      const hook = closeDuringNextPreparedGather(b);
      c.closing({ close: () => hook.restore() });

      // Act: createAnswer の transport 準備 (最初の gather) の途中で close する。
      await c.rejects(() => b.createAnswer(), "InvalidStateError");
      await hook.closed();
      hook.restore();

      // Assert: 準備を始めた transport は止まり、close の後に新しい transport は作られない。
      expect(hook.gathered.map((transport) => transport.state)).toEqual([
        "closed",
      ]);
      expect(b.connectionState).toEqual("closed");
    },
  );
});
