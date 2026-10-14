import {
  MediaStreamTrack,
  useAbsSendTime,
  useH264,
  useSdesMid,
  useVP8,
} from "../../../src";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  addOfferedCodec,
  addUnsupportedExtmaps,
  assertTransportsClosed,
  changeAnswererIceCredentials,
  closeDuringNextPreparedGather,
  closeOnSignalingState,
  createConnectedMultiVideoPeers,
  createConnectedVideoPeers,
  createIceRestartPranswer,
  createInitialPranswerConnection,
  createMutationSession,
  createPeerPair,
  createRelayOnlyPeers,
  createRewrittenOffer,
  createSimulcastPeers,
  createSplitOffer,
  createUnnegotiatedPeers,
  createUnnegotiatedVideoPeers,
  createVp8H264AnsweringPeers,
  currentRemoteGeneration,
  elapsedMs,
  expectSessionContinues,
  forceIceState,
  heldTransports,
  holdDtlsStart,
  holdNextGather,
  mungeSection,
  mutate,
  offeredVideoCodecs,
  provisionalIce,
  receiveCodecNames,
  recordConnectionStates,
  recordIceConnectionStates,
  recordNegotiationEvents,
  reverseSetupRole,
  sectionOf,
  settlesWithin,
  stubIceMdns,
  trickleCandidate,
  waitForCommittedNomination,
  waitForConnection,
  waitForDtlsConnected,
  waitForDtlsHandshake,
  waitForIce,
  waitForPeersConnected,
  waitForRemoteCandidatePort,
} from "../harness/negotiationTransactionUtils";

/** Wait for the next macrotask (`setImmediate`). */
const nextMacrotask = () => new Promise((resolve) => setImmediate(resolve));

/** `settled` turns true once `promise` settles. */
const settledFlag = (promise: Promise<unknown>) => {
  const flag = { settled: false };
  const settle = () => {
    flag.settled = true;
  };
  promise.then(settle, settle);
  return flag;
};

/**
 * `sdp` whose BUNDLE group keeps only `video`, without end-of-candidates,
 * and whose `audio` m-line carries the ICE credentials of the `video` m-line.
 */
const splitWithSharedCredentials = (
  sdp: string,
  video: string,
  audio: string,
) => {
  const split = sdp
    .replace(/^a=group:BUNDLE [^\r\n]+/m, `a=group:BUNDLE ${video}`)
    .replace(/^a=end-of-candidates\r?\n/gm, "");
  const tag = sectionOf(split, video);
  const ufrag = tag.match(/^a=ice-ufrag:(\S+)/m)![1];
  const pwd = tag.match(/^a=ice-pwd:(\S+)/m)![1];
  return mungeSection(split, audio, (section) =>
    section
      .replace(/^a=ice-ufrag:\S+/m, `a=ice-ufrag:${ufrag}`)
      .replace(/^a=ice-pwd:\S+/m, `a=ice-pwd:${pwd}`),
  );
};

/**
 * Deterministic regressions for what the negotiation property test found
 * (see tests/pbt/negotiationTransactionProperty.test.ts for the seeds).
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
    "addIceCandidate does not wait for the gathering of a setLocalDescription before it (as develop)",
    {
      ref: "2.12-6; origin: property test (develop comparison)",
      exempt: "the test applies only a's answer",
      timeout: 20000,
    },
    async (c) => {
      // Arrange: 応答しない STUN server を持つ answerer。setLocalDescription は gather を待つ。b の候補は trickle で続く (offer に end-of-candidates を載せない)。
      const { a, b } = await c.given(
        createPeerPair({ iceServers: [{ urls: "stun:192.0.2.1:3478" }] }, {}),
      );
      b.addTransceiver("audio");
      await c.offer(b, { hold: true });
      await c.setRemote(
        a,
        mutate(b.localDescription!.sdp, ["noEndOfCandidates"]),
      );
      const answer = await a.createAnswer();
      const started = Date.now();

      // Act: answer の適用 (gather 待ち) の直後に remote 候補を追加する。
      const applying = c.start(a.setLocalDescription(answer));
      const answerApplied = settledFlag(applying);
      await a.addIceCandidate({
        candidate: "candidate:1 1 udp 2130706431 127.0.0.1 9 typ host",
        sdpMid: a.getTransceivers()[0].mid,
      });

      // Assert: 候補の追加は gather の完了を待たずに終わり、remote description に記録される。
      expect(Date.now() - started).toBeLessThan(1000);
      expect(answerApplied.settled).toEqual(false);
      expect(a.remoteDescription!.sdp).toContain("127.0.0.1 9 typ host");

      // Act: 後続の description 操作は先の 2 つの完了を待つ。
      const next = c.start(a.createOffer());
      await applying;
      await next;

      // Assert: answer が確定し、invariant を満たす。
      expect(a.signalingState).toEqual("stable");
      c.invariants(a);
    },
  );

  negotiationCase(
    "an ICE-lite peer's final answer with new credentials and generation 1 candidates connects without another restart",
    {
      ref: "2.12-10; origin: property test",
      exempt:
        "the answerer's ICE credentials were changed through its internals",
    },
    async (c) => {
      // Arrange: full の offerer と ICE-lite の answerer。pranswer で接続済み。
      const { a, b } = await c.given(
        createPeerPair({ iceServers: [] }, { iceServers: [], iceLite: true }),
      );
      const aOut = new MediaStreamTrack({ kind: "video" });
      const bOut = new MediaStreamTrack({ kind: "video" });
      const aVideo = a.addTransceiver(aOut, { direction: "sendrecv" });
      await c.offer(a);
      const bVideo = b.getTransceivers()[0];
      Object.assign(bVideo, { direction: "sendrecv" });
      await bVideo.sender.replaceTrack(bOut);
      await c.pranswer(b);
      await waitForPeersConnected(a, b);

      // Arrange: answerer は final answer で資格情報を変える (候補は generation 1)。
      await changeAnswererIceCredentials(b);
      await c.setLocal(b, await b.createAnswer());
      expect(b.localDescription!.sdp).toMatch(/ generation 1 /);

      // Act: offerer が final answer を適用する (offerer 自身は restart しない)。
      await c.setRemote(a, b.localDescription);

      // Assert: 次の restart の前に、新しい remote generation で pair を選び、checks の待機が決着する。
      const transport = a.iceTransports[0];
      await c.waitFor(
        () =>
          !!transport.connection.nominated &&
          transport.connection.remoteUsername ===
            transport.getRemoteParameters()?.usernameFragment,
        10000,
      );
      expect(await settlesWithin(transport.checksSettled(), 1000)).toEqual(
        true,
      );
      expect(["connected", "completed"]).toContain(transport.state);

      // Assert: 両方向に RTP が届く。
      await c.rtp(aOut, bVideo.receiver.track);
      await c.rtp(bOut, aVideo.receiver.track);
      c.invariants(a);
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
    "an answer whose codec was not in the offer is rejected before mutation",
    { ref: "2.5-4; origin: self-review (live state)" },
    async (c) => {
      // Arrange: 設定は Opus/PCMU に対応するが、offer は Opus だけを提案する。
      const { a, b } = await c.given(createUnnegotiatedPeers());
      const audio = a.addTransceiver("audio");
      Object.assign(audio, {
        codecs: a.config.codecs.audio!.filter(
          (codec) => codec.name.toLowerCase() === "opus",
        ),
      });
      await c.offer(a);
      const answer = await b.createAnswer();
      const unoffered = answer.sdp.replace(/opus\/48000\/2/i, "PCMU/8000");
      expect(unoffered).not.toEqual(answer.sdp);

      // Act / Assert: offer にない PCMU に差し替えた answer は InvalidAccessError で拒否され、状態は変わらない。
      await c.setRemote(a, unoffered, {
        type: "answer",
        rejects: "InvalidAccessError",
      });
      expect(a.signalingState).toEqual("have-local-offer");
      expect(a.currentRemoteDescription).toBe(null);

      // Assert: offer と合意する正しい answer はそのまま適用できる。
      await c.setRemote(a, answer);
      expect(a.signalingState).toEqual("stable");
    },
  );

  negotiationCase.for([
    { candidate: "a host candidate", host: "127.0.0.1" },
    { candidate: "an mDNS candidate", host: "peer.local" },
  ] as const)(
    "$candidate after end-of-candidates of an ICE restart pranswer reaches neither the pending SDP nor the provisional checklist",
    { ref: "5-12; origin: self-review (live state)" },
    async (c, { candidate, host }) => {
      // Arrange: pranswer の restart generation に end-of-candidates を適用する。
      const { a, mid, outgoing, incoming, ufrag } = await c.given(
        createIceRestartPranswer(),
      );
      const mdns = stubIceMdns(a);
      await c.addCandidate(a, {
        candidate: "",
        sdpMid: mid,
        usernameFragment: ufrag,
      });
      const pendingSdp = a.pendingRemoteDescription!.sdp;
      const provisional = provisionalIce(a);
      const candidates = provisional!.remoteCandidates.length;
      const pairs = provisional!.pairs.length;

      // Act: 同じ ufrag の候補が end-of-candidates の後に届く。
      await c.addCandidate(a, trickleCandidate(50999, ufrag, mid, host));

      // Assert: 完了済み generation の pending SDP と provisional checklist は変わらない。
      expect(a.pendingRemoteDescription!.sdp).toBe(pendingSdp);
      expect(a.pendingRemoteDescription!.sdp).toContain("a=end-of-candidates");
      expect(provisional!.remoteCandidatesEnd).toEqual(true);
      expect(provisional!.remoteCandidates.length).toEqual(candidates);
      expect(provisional!.pairs.length).toEqual(pairs);

      // Assert: mDNS 名の解決も始めない。
      expect(mdns.requested).toEqual(0);
      c.invariants(a);
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase(
    "an mDNS candidate that is still resolving does not hold later candidates or description operations",
    { ref: "2.8-1; origin: self-review (live state)" },
    async (c) => {
      // Arrange: current の remote generation が trickle 継続中の接続済み peer と、解決しない mDNS lookup
      const { b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers({}, { trickleOpen: true }),
      );
      const mdns = stubIceMdns(b);
      const generation = currentRemoteGeneration(b);

      // Act: mDNS 候補、通常の候補、description 操作をこの順に行う
      const mdnsElapsed = await elapsedMs(() =>
        b.addIceCandidate(
          trickleCandidate(
            50991,
            generation.ufrag,
            generation.mid,
            "peer.local",
          ),
        ),
      );
      const hostElapsed = await elapsedMs(() =>
        b.addIceCandidate(
          trickleCandidate(50992, generation.ufrag, generation.mid),
        ),
      );
      const offerElapsed = await elapsedMs(() => b.createOffer());

      // Assert: どの操作も mDNS の解決 (最大 10 秒) を待たずに終わり、通常の候補はすぐ checklist に入る
      expect(mdns.requested).toEqual(1);
      expect(Math.max(mdnsElapsed, hostElapsed, offerElapsed)).toBeLessThan(
        1000,
      );
      await waitForRemoteCandidatePort(b, 50992);
      await c.rtp(outgoing, incoming);

      // Act: mDNS の解決を完了させる
      mdns.resolveAll("127.0.0.1");

      // Assert: 解決後に mDNS 候補も同じ generation の checklist に入る
      await waitForRemoteCandidatePort(b, 50991);
      c.invariants(b);
    },
  );

  negotiationCase(
    "an mDNS candidate trickled before end-of-candidates of an ICE restart pranswer is kept",
    { ref: "2.7-T2 2.8-2 2.8-29 5-12; origin: self-review (live state)" },
    async (c) => {
      // Arrange: provisional generation の mDNS 候補を解決中にし、続けて EOC を送る。
      const { a, mid, ufrag } = await c.given(createIceRestartPranswer());
      const mdns = stubIceMdns(a);
      const resolving = c.start(
        a.addIceCandidate(trickleCandidate(50998, ufrag, mid, "peer.local")),
      );
      const end = c.start(
        a.addIceCandidate({
          candidate: "",
          sdpMid: mid,
          usernameFragment: ufrag,
        }),
      );
      await nextMacrotask();
      expect(mdns.requested).toEqual(1);

      // Act: mDNS 解決を完了させる。
      mdns.resolveAll("127.0.0.1");
      await Promise.all([resolving, end]);

      // Assert: EOC 前に届いた候補は pending SDP と provisional checklist に入り、その後に完了する。
      const provisional = provisionalIce(a);
      expect(
        provisional!.remoteCandidates.some(
          (candidate) => candidate.port === 50998,
        ),
      ).toEqual(true);
      expect(provisional!.remoteCandidatesEnd).toEqual(true);
      const section = sectionOf(a.pendingRemoteDescription!.sdp, mid);
      expect(section).toContain(" 50998 typ host");
      expect(section).toContain("a=end-of-candidates");
      c.invariants(a);
    },
  );

  negotiationCase(
    "header extension IDs the answer did not accept stay free for a later offer",
    { ref: "2.8-16; origin: self-review (live state)" },
    async (c) => {
      // Arrange: remote (a) の audio offer は werift (b) が受理しない extmap を空き ID すべてに載せる
      const { a, b } = await c.given(
        createPeerPair({
          headerExtensions: {
            audio: [useSdesMid()],
            video: [useSdesMid(), useAbsSendTime()],
          },
        }),
      );
      a.addTransceiver("audio");
      await c.offer(a, { hold: true });
      await c.setRemote(
        b,
        addUnsupportedExtmaps(a.localDescription!.sdp, "audio"),
      );
      await c.answer(b);

      // Act: werift (b) が video を追加して re-offer し、その ID をそのまま返す answer を適用する
      b.addTransceiver("video");
      await c.negotiate(b);

      // Assert: 受理されなかった ID は使用中ではないので、answer は拒否されず stable になる
      expect(b.signalingState).toEqual("stable");
      c.invariants(b);
    },
  );

  negotiationCase(
    "a payload type the answer did not accept can carry another codec in a later remote offer",
    { ref: "2.8-16; origin: self-review (live state)" },
    async (c) => {
      // Arrange: remote (a) の audio offer に werift (b) が受理しない codec を PT 110 で載せ、answer で確定する
      const { a, b } = await c.given(createPeerPair());
      a.addTransceiver("audio");
      await c.offer(a, { hold: true });
      await c.setRemote(
        b,
        addOfferedCodec(a.localDescription!.sdp, "audio", 110, "FOO/8000"),
      );
      await c.answer(b);
      expect(b.currentLocalDescription!.sdp).not.toContain("FOO/8000");

      // Act: remote の re-offer が PT 110 を別の codec に使う
      await c.offer(a, { hold: true });
      await c.setRemote(
        b,
        addOfferedCodec(a.localDescription!.sdp, "audio", 110, "BAR/8000"),
      );

      // Assert: PT 110 は使用中ではないので re-offer は拒否されない
      expect(b.signalingState).toEqual("have-remote-offer");
      await c.answer(b, { hold: true });
      c.invariants(b);
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
    "a re-answer with a=setup:actpass keeps the DTLS role of the live association",
    { ref: "2.8-47 2.11-5; origin: self-review (live state)" },
    async (c) => {
      // Arrange: 接続済みの peer (answerer は active で答え、offerer は server になる)
      const { a, b } = await c.given(createPeerPair());
      a.createDataChannel("role");
      await c.negotiate(a);
      const transport = a.dtlsTransports[0];
      await waitForDtlsConnected(transport);
      const role = transport.role;

      // Act: re-offer に a=setup:actpass の answer (b の前回の answer を書き換えたもの) が返る
      await c.offer(a, { hold: true });
      await c.setRemote(
        a,
        b.localDescription!.sdp.replace(/a=setup:\w+/g, "a=setup:actpass"),
        { type: "answer" },
      );

      // Assert: 拒否されず、確立済み association の role は変わらない
      expect(a.signalingState).toEqual("stable");
      expect(transport.role).toBe(role);
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
    "end-of-candidates trickled on a non-tag BUNDLE m-line completes the restarted generation",
    { ref: "2.8-28; origin: self-review (live state)" },
    async (c) => {
      // Arrange: audio (BUNDLE の非 tag) を含む session で、EOC を含まない ICE restart の re-offer を answerer に適用する。
      const { a, b } = await c.given(
        createConnectedVideoPeers({}, { withAudio: true }),
      );
      a.restartIce();
      await c.offer(a, { hold: true });
      const ufrag = a.localDescription!.sdp.match(/^a=ice-ufrag:(\S+)/m)![1];
      await c.setRemote(
        b,
        a.localDescription!.sdp.replace(/^a=end-of-candidates\r?\n/gm, ""),
      );
      const audioMid = b.getTransceivers().find((t) => t.kind === "audio")!.mid;

      // Act: 非 tag m-line に新 generation の EOC を trickle してから answer で確定する。
      await c.addCandidate(b, {
        candidate: "",
        sdpMid: audioMid,
        usernameFragment: ufrag,
      });
      await c.answer(b);

      // Assert: 確定した共有 transport の generation が EOC を記録し、current の全 m-line の SDP も EOC を持つ。
      const connection = b.iceTransports[0].connection;
      expect(connection.remoteUsername).toEqual(ufrag);
      expect(connection.remoteCandidatesEnd).toEqual(true);
      const current = b.currentRemoteDescription!.sdp;
      expect(current.match(/^a=end-of-candidates/gm)!.length).toEqual(
        current.match(/^m=/gm)!.length,
      );
      c.invariants(b);
    },
  );

  negotiationCase(
    "a final answer cannot reverse the DTLS role a first pranswer connected with",
    { ref: "2.8-33; origin: self-review (live state)" },
    async (c) => {
      // Arrange: 初回 pranswer で接続した offerer の DTLS role を控える。
      const { a, b, pranswer } = await c.given(
        createInitialPranswerConnection(),
      );
      const transport = a.dtlsTransports[0];
      const role = transport.role;

      // Act / Assert: a=setup を反転した final answer は適用前に拒否され、状態は変わらない。
      await c.setRemote(a, reverseSetupRole(pranswer), {
        type: "answer",
        rejects: "InvalidModificationError",
      });
      expect(transport.role).toBe(role);
      expect(a.signalingState).toEqual("have-remote-pranswer");

      // Act: pranswer と同じ role の final answer で確定し、通常の再交渉を行う。
      await c.setLocal(b, pranswer, { type: "answer" });
      await c.setRemote(a, pranswer, { type: "answer" });
      await c.negotiate(a);

      // Assert: 再交渉も成功し、role は維持される。
      expect(a.signalingState).toEqual("stable");
      expect(transport.role).toBe(role);
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
    "a candidate on the tag m-line after end-of-candidates on a non-tag member of a pending restart is ignored",
    { ref: "2.8-32; origin: self-review (live state)" },
    async (c) => {
      // Arrange: EOC を含まない ICE restart の re-offer を answerer に適用し、非 tag (audio) の m-line に新 generation の EOC を trickle する。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers({}, { withAudio: true }),
      );
      a.restartIce();
      await c.offer(a, { hold: true });
      const ufrag = a.localDescription!.sdp.match(/^a=ice-ufrag:(\S+)/m)![1];
      await c.setRemote(
        b,
        a.localDescription!.sdp.replace(/^a=end-of-candidates\r?\n/gm, ""),
      );
      const video = b.getTransceivers().find((t) => t.kind === "video")!.mid;
      const audio = b.getTransceivers().find((t) => t.kind === "audio")!.mid;
      await c.addCandidate(b, {
        candidate: "",
        sdpMid: audio,
        usernameFragment: ufrag,
      });

      // Act: 同じ BUNDLE の tag (video) m-line に、同じ generation の遅延候補を送り、answer で確定する。
      await c.addCandidate(b, trickleCandidate(49999, ufrag, video!));
      await c.answer(b);
      await Promise.all([
        waitForCommittedNomination(a),
        waitForCommittedNomination(b),
      ]);

      // Assert: 終端通知の後の候補は pending SDP にも確定後の ICE にも入らない (RFC 8838)。
      const connection = b.iceTransports[0].connection;
      expect(connection.remoteCandidatesEnd).toEqual(true);
      expect(
        connection.remoteCandidates.some(
          (candidate) => candidate.port === 49999,
        ),
      ).toEqual(false);
      expect(b.currentRemoteDescription!.sdp).not.toContain(" 49999 ");
      c.invariants(b);
      await c.rtp(outgoing, incoming);
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

  negotiationCase(
    "end-of-candidates on a pending restart reaches its BUNDLE group but not an m-line the offer splits off",
    { ref: "2.8-31; origin: self-review (live state)" },
    async (c) => {
      // Arrange: ICE restart と BUNDLE 解除 (audio を group から外す) を行い、両 MID が同じ ufrag/pwd を持つ remote offer を、transport 準備 (createAnswer) の前まで適用する。
      const { a, b } = await c.given(
        createConnectedVideoPeers({}, { withAudio: true }),
      );
      a.restartIce();
      const video = a.getTransceivers().find((t) => t.kind === "video")!.mid;
      const audio = a.getTransceivers().find((t) => t.kind === "audio")!.mid;
      const offer = await createRewrittenOffer(a, (sdp) =>
        splitWithSharedCredentials(sdp, video!, audio!),
      );
      const ufrag = sectionOf(offer.sdp, video!).match(
        /^a=ice-ufrag:(\S+)/m,
      )![1];
      await c.setRemote(b, offer);

      // Act: video (tag) にだけ end-of-candidates を通知し、分割される audio に候補を送る。
      await c.addCandidate(b, {
        candidate: "",
        sdpMid: video,
        usernameFragment: ufrag,
      });
      await c.addCandidate(b, trickleCandidate(49998, ufrag, audio!));

      // Assert: 終端は video の BUNDLE group だけが完了扱いになり、独立する audio は完了せず候補を受け入れる。
      const pending = b.pendingRemoteDescription!.sdp;
      expect(sectionOf(pending, video!)).toContain("a=end-of-candidates");
      expect(sectionOf(pending, audio!)).not.toContain("a=end-of-candidates");
      expect(sectionOf(pending, audio!)).toContain(" 49998 typ host");
    },
  );
});

/** Findings of the peer-diversity SDP mutations (negotiationTransactionMutation). */
describeCases("negotiation transaction mutation regressions", () => {
  negotiationCase(
    "an answer declining BUNDLE onto the same transport keeps the ended generation complete",
    { ref: "2.8-28 2.10-6; origin: SDP mutations" },
    async (c) => {
      // Arrange: 確立済み session (EOC 済み) で re-offer を両側に置く。
      const { a, b } = await c.given(createMutationSession("renegotiation"));
      await c.offer(a);
      const answer = await c.answer(b, { hold: true });

      // Act: BUNDLE も end-of-candidates も持たない answer を適用する。
      await c.setRemote(
        a,
        mutate(answer.sdp, ["noBundle", "noEndOfCandidates"]),
      );

      // Assert: 同じ transport・ufrag の m-line はどれも終端済みとして記録される。
      const current = a.currentRemoteDescription!.sdp;
      expect(sectionOf(current, "0")).toContain("a=end-of-candidates");
      expect(sectionOf(current, "1")).toContain("a=end-of-candidates");
      c.invariants(a);
    },
  );

  negotiationCase(
    "new remote credentials next to an inactive m-line keep only the new remote generation's candidates",
    {
      ref: "2.11-13; origin: SDP mutations",
      exempt: "the answer misdescribes b's ICE credentials",
    },
    async (c) => {
      // Arrange: 確立済み session で re-offer を両側に置く。
      const { a, b, aVideo } = await c.given(
        createMutationSession("renegotiation"),
      );
      await c.offer(a);
      const answer = await c.answer(b, { hold: true });

      // Act: tag の video を inactive にし、別の資格情報を持たせた answer を適用する (develop から既存の renomination 経路: inactive の m-line と資格情報の変更)。
      await c.setRemote(
        a,
        mutate(answer.sdp, ["videoInactive", "videoSeparateCredentials"]),
      );

      // Assert: live の remote generation は新しい資格情報で、前の generation の ufrag を名乗る候補は checklist に残らない。
      const connection = aVideo.dtlsTransport.iceTransport.connection;
      expect(connection.remoteUsername).toEqual("mutv");
      expect(
        connection.remoteCandidates.filter(
          (candidate) => candidate?.ufrag && candidate.ufrag !== "mutv",
        ),
      ).toEqual([]);
      c.invariants(a);
    },
  );

  negotiationCase(
    "new remote credentials in an answer keep the local credentials the offer described",
    { ref: "2.10-5; origin: SDP mutations" },
    async (c) => {
      // Arrange: 確立済み session で re-offer を両側に置く。
      const { a, b } = await c.given(createMutationSession("renegotiation"));
      await c.offer(a);
      const offered = sectionOf(a.localDescription!.sdp, "1").match(
        /^a=ice-ufrag:(\S+)/m,
      )![1];
      const answer = await c.answer(b, { hold: true });

      // Act: tag の video を拒否し、新しい tag の application が別の資格情報を持つ answer を適用する。
      await c.setRemote(
        a,
        mutate(answer.sdp, ["separateCredentials", "videoRejected"]),
      );

      // Assert: remote は新しい資格情報で checks をやり直し、local の資格情報は offer で伝えたまま (どの SDP にも無い資格情報を作らない)。
      const connection = a.sctpTransport!.dtlsTransport.iceTransport.connection;
      expect(connection.remoteUsername).toEqual("mutd");
      expect(connection.localUsername).toEqual(offered);
      c.invariants(a);
    },
  );

  negotiationCase(
    "a rejected m-line does not turn a credential change into a renomination",
    { ref: "2.10-5; origin: SDP mutations" },
    async (c) => {
      // Arrange: video を拒否し application に新しい資格情報を持たせた offer を b に届ける。
      const { a, b } = await c.given(createMutationSession("renegotiation"));
      await c.offer(a, { hold: true });
      await c.setRemote(
        b,
        mutate(a.localDescription!.sdp, [
          "separateCredentials",
          "videoRejected",
        ]),
      );
      const oldUfrag =
        b.sctpTransport!.dtlsTransport.iceTransport.connection.localUsername;
      await c.answer(b, { hold: true });

      // Act: b が新しい資格情報で答えた answer を a に適用する。
      await c.setRemote(a, b.localDescription);

      // Assert: a の checklist に b の旧 generation の候補は残らない。
      const connection = a.sctpTransport!.dtlsTransport.iceTransport.connection;
      expect(connection.remoteUsername).not.toBe(oldUfrag);
      expect(
        connection.remoteCandidates
          .map((candidate) => candidate?.ufrag ?? connection.remoteUsername)
          .filter((ufrag) => ufrag !== connection.remoteUsername),
      ).toEqual([]);
      c.invariants(a);
    },
  );
});
