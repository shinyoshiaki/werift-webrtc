import { vi } from "vitest";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  useAbsSendTime,
  useH264,
  useSdesMid,
  useVP8,
} from "../../src";
import { negotiate as negotiatePair } from "../issue/705.helpers";
import {
  addOfferedCodec,
  addUnsupportedExtmaps,
  assertNegotiationInvariants,
  assertTransportsClosed,
  closeDuringNextPreparedGather,
  createConnectedMultiVideoPeers,
  createConnectedVideoPeers,
  createConnectedVideoPeersWithRtx,
  createDuplexSession,
  createH264OnlyReoffer,
  createIceRestartPranswer,
  createInitialPranswerConnection,
  createMutationSession,
  createRelayOnlyPeers,
  createRewrittenOffer,
  createSimulcastPeers,
  createSplitOffer,
  createUnnegotiatedPeers,
  createUnnegotiatedVideoPeers,
  createVp8H264AnsweringPeers,
  currentRemoteGeneration,
  elapsedMs,
  enforceSessionContinuation,
  exemptFromContinuation,
  expectSessionAlive,
  expectSessionContinues,
  forceIceState,
  heldTransports,
  holdDtlsStart,
  holdNextGather,
  mungeSection,
  mutate,
  negotiate,
  offeredVideoCodecs,
  pliReaches,
  provisionalIce,
  receiveCodecNames,
  recordIceConnectionStates,
  reverseSetupRole,
  rewriteVideoFeedback,
  sectionOf,
  sendAndExpectData,
  sendAndExpectRtp,
  stubIceMdns,
  trickleCandidate,
  videoWithoutFeedback,
  waitForCommittedNomination,
  waitForConnection,
  waitForDtlsConnected,
  waitForDtlsHandshake,
  waitForIce,
  waitForPeersConnected,
  waitForRemoteCandidatePort,
  waitUntil,
} from "./negotiationTransactionUtils";

/**
 * Deterministic regressions for what the negotiation property test found
 * (see negotiationTransactionProperty.test.ts for the seeds).
 */
describe("negotiation transaction regressions", () => {
  enforceSessionContinuation();

  test.each(["a", "b"] as const)(
    "a relay-only ICE restart offered by %s nominates once the held TURN allocation completes after the peer's candidates",
    async (offererName) => {
      // Arrange: 両 peer が relay-only で、DataChannel が TURN 経由で開いている。
      const peers = await createRelayOnlyPeers();
      const { a, b, channel, remote, proxy, candidateErrors } = peers;
      try {
        const [offerer, answerer] = offererName === "a" ? [a, b] : [b, a];
        const connections = () =>
          [a, b].map((pc) => pc.iceTransports[0].connection);
        const previous = connections().map((c) => c.localUsername);

        // Act: b の新しい TURN allocation を保留したまま ICE restart を確定する
        // (a の relay 候補と end-of-candidates が、b のローカル候補より先に b へ届く)。
        proxy.hold();
        await offerer.setLocalDescription(
          await offerer.createOffer({ iceRestart: true }),
        );
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Act: b の allocation を完了させる。
        proxy.release();

        // Assert: 両側が新しい generation の relay pair を nominate する。
        await waitUntil(
          () =>
            connections().every(
              (c, index) =>
                c.localUsername !== previous[index] &&
                c.nominated?.localCandidate.type === "relay" &&
                c.nominated.localCandidate.ufrag === c.localUsername,
            ),
          "the restarted relay generation was not nominated",
          15000,
        );
        // Assert: 元の DataChannel が relay 経由で双方向に届き、候補の配送は失敗しない。
        await sendAndExpectData(channel, remote, `relay-${offererName}-ab`);
        await sendAndExpectData(remote, channel, `relay-${offererName}-ba`);
        expect(candidateErrors).toEqual([]);
        assertNegotiationInvariants(a);
        assertNegotiationInvariants(b);

        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(a, b, `relay-restart-${offererName}`);
      } finally {
        await peers.close();
      }
    },
    60000,
  );

  test("close() from the stable event of a glare implicit rollback adds no pending offer and leaves no transport running", async () => {
    // Arrange: a は local offer を保留し、b は audio と video を足した offer を持つ。
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    try {
      a.addTransceiver("audio");
      b.addTransceiver("audio", { direction: "sendonly" });
      b.addTransceiver("video", { direction: "sendonly" });
      await a.setLocalDescription(await a.createOffer());
      await b.setLocalDescription(await b.createOffer());
      // Arrange: close() が検証対象なので、両 peer は継続確認の対象外にする。
      exemptFromContinuation([a, b], "close() is the operation under test");
      let closing: Promise<void> | undefined;
      a.signalingStateChange.subscribe((state) => {
        if (state === "stable") closing = a.close();
      });

      // Act: glare の implicit rollback が通知する stable の handler から close() する。
      const applying = a.setRemoteDescription(b.localDescription!);

      // Assert: close に追い越された操作は InvalidStateError で失敗する。
      await expect(applying).rejects.toMatchObject({
        name: "InvalidStateError",
      });
      await closing;
      // Assert: 閉鎖後に pending の remote offer も新しい transceiver も追加されない。
      expect(a.signalingState).toBe("closed");
      expect(a.pendingRemoteDescription).toBeNull();
      expect(a.getTransceivers()).toHaveLength(1);
      // Assert: a が保持する transport (transceiver・交渉が作ったものを含む) はすべて閉じている。
      assertTransportsClosed([
        ...heldTransports(a),
        ...a.getTransceivers().map((t) => t.dtlsTransport),
      ]);
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  });

  test("close() from the stable event of a new local offer that rolls a remote pranswer back adds no pending offer and leaves no transport running", async () => {
    // Arrange: a の offer に b が pranswer を返し、a は have-remote-pranswer にある。
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    try {
      a.addTransceiver("audio");
      await a.setLocalDescription(await a.createOffer());
      await b.setRemoteDescription(a.localDescription!);
      const pranswer = await b.createAnswer();
      await b.setLocalDescription({ type: "pranswer", sdp: pranswer.sdp });
      await a.setRemoteDescription(b.localDescription!);
      expect(a.signalingState).toBe("have-remote-pranswer");
      // Arrange: close() が検証対象なので、両 peer は継続確認の対象外にする。
      exemptFromContinuation([a, b], "close() is the operation under test");
      a.addTransceiver("video");
      const offer = await a.createOffer();
      let closing: Promise<void> | undefined;
      a.signalingStateChange.subscribe((state) => {
        if (state === "stable") closing = a.close();
      });

      // Act: pranswer を暗黙に rollback する新しい offer の stable の handler から close() する。
      const applying = a.setLocalDescription(offer);

      // Assert: close に追い越された操作は InvalidStateError で失敗し、offer は pending にならない。
      await expect(applying).rejects.toMatchObject({
        name: "InvalidStateError",
      });
      await closing;
      expect(a.signalingState).toBe("closed");
      expect(a.pendingLocalDescription).toBeNull();
      // Assert: a が保持する transport はすべて閉じている。
      assertTransportsClosed([
        ...heldTransports(a),
        ...a.getTransceivers().map((t) => t.dtlsTransport),
      ]);
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  });

  test.each([
    { operation: "stop", kept: false },
    { operation: "direction", kept: false },
    { operation: "setCodecPreferences", kept: false },
    { operation: "replaceTrack", kept: true },
    { operation: "addTrack", kept: true },
  ] as const)(
    "rollback of a remote offer after the application's $operation keeps the remote-created transceiver only when it has a track (as develop)",
    async ({ operation, kept }) => {
      // Arrange: b の video offer を a が適用し、remote offer が transceiver を作る。
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      try {
        b.addTransceiver("video", { direction: "sendrecv" });
        await b.setLocalDescription(await b.createOffer());
        const offer = b.localDescription!;
        await a.setRemoteDescription(offer);
        const [created] = a.getTransceivers();

        // Act: rollback の前に app がその transceiver を操作し、rollback する。
        if (operation === "stop") created.stop();
        if (operation === "direction") created.direction = "sendonly";
        if (operation === "setCodecPreferences") {
          created.setCodecPreferences([useVP8()]);
        }
        if (operation === "replaceTrack") {
          await created.sender.replaceTrack(
            new MediaStreamTrack({ kind: "video" }),
          );
        }
        if (operation === "addTrack") {
          a.addTrack(new MediaStreamTrack({ kind: "video" }));
        }
        await a.setRemoteDescription({ type: "rollback" });

        // Assert: track を持つものだけが m-line の関連付けを外して残り、停止途中の
        // transceiver は残らない。
        expect(
          a.getTransceivers().map((t) => ({
            mid: t.mid,
            stopping: t.stopping,
            stopped: t.stopped,
          })),
        ).toEqual(kept ? [{ mid: null, stopping: false, stopped: false }] : []);
        assertNegotiationInvariants(a);

        // Act: 同じ offer を再適用する。
        await a.setRemoteDescription(offer);
        // Assert: transceiver は重複せず 1 つだけで、offer の MID に関連付く。
        expect(a.getTransceivers().map((t) => t.mid)).toEqual([
          offer.sdp.match(/^a=mid:(\S+)/m)![1],
        ]);
        assertNegotiationInvariants(a);
        // Arrange: 片側だけの適用 (answer を返さない) なので継続確認の対象外にする。
        exemptFromContinuation([a, b], "the test applies only b's offer to a");
      } finally {
        await Promise.allSettled([a.close(), b.close()]);
      }
    },
  );

  test("a bundlePolicy disable renegotiation pranswer does not fail the connection and the final answer connects", async () => {
    // Arrange: bundlePolicy disable で audio と DataChannel が接続済み。
    const a = new RTCPeerConnection({ bundlePolicy: "disable" });
    const b = new RTCPeerConnection({ bundlePolicy: "disable" });
    try {
      const states: string[] = [];
      a.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
        direction: "sendrecv",
      });
      a.createDataChannel("disable");
      await a.setLocalDescription(await a.createOffer());
      await b.setRemoteDescription(a.localDescription!);
      await b.setLocalDescription(await b.createAnswer());
      await a.setRemoteDescription(b.localDescription!);
      await waitForPeersConnected(a, b);
      for (const [name, pc] of [
        ["a", a],
        ["b", b],
      ] as const) {
        pc.connectionStateChange.subscribe((state) =>
          states.push(`${name}:${state}`),
        );
      }
      const aVideo = new MediaStreamTrack({ kind: "video" });
      const aTransceiver = a.addTransceiver(aVideo, { direction: "sendrecv" });

      // Act: 新しい video (独自の transport) を足した re-offer に pranswer を返す。
      await a.setLocalDescription(await a.createOffer());
      await b.setRemoteDescription(a.localDescription!);
      const answer = (await b.createAnswer()).sdp;
      await b.setLocalDescription({ type: "pranswer", sdp: answer });
      await a.setRemoteDescription(b.localDescription!);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Assert: remote パラメータのない transport を開始しないので、pranswer 中に failed にならない。
      expect(states).not.toContain("a:failed");
      expect(states).not.toContain("b:failed");
      expect([a.connectionState, b.connectionState]).toEqual([
        "connected",
        "connected",
      ]);

      // Act: final answer で確定する。
      await b.setLocalDescription({ type: "answer", sdp: answer });
      await a.setRemoteDescription(b.localDescription!);
      await waitForPeersConnected(a, b);

      // Assert: 新しい video の RTP が届き、どちらも failed を通らない。
      const bVideo = b
        .getTransceivers()
        .find((t) => t.mid === aTransceiver.mid)!;
      await waitForDtlsConnected(aTransceiver.dtlsTransport);
      await waitForDtlsConnected(bVideo.dtlsTransport);
      await sendAndExpectRtp(aVideo, bVideo.receiver.track, "disable-video");
      expect(states.filter((state) => state.endsWith("failed"))).toEqual([]);
      assertNegotiationInvariants(a);
      assertNegotiationInvariants(b);
      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(a, b, "bundle-disable-pranswer");
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  }, 60000);

  test("a simulcast layer whose MID extension names no route is still routed by its RID (as develop)", async () => {
    // Arrange: simulcast (high / low) を受信する接続済み session。
    const { offerer, answerer, sendLayer, close } =
      await createSimulcastPeers();
    try {
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
      assertNegotiationInvariants(answerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "simulcast-rid");
    } finally {
      await close();
    }
  }, 60000);

  test("addIceCandidate does not wait for the gathering of a setLocalDescription before it (as develop)", async () => {
    // Arrange: 応答しない STUN server を持つ answerer。setLocalDescription は gather を待つ。
    const a = new RTCPeerConnection({
      iceServers: [{ urls: "stun:192.0.2.1:3478" }],
    });
    const b = new RTCPeerConnection();
    try {
      b.addTransceiver("audio");
      await b.setLocalDescription(await b.createOffer());
      // b の候補は trickle で続く (offer に end-of-candidates を載せない)。
      await a.setRemoteDescription({
        type: "offer",
        sdp: mutate(b.localDescription!.sdp, ["noEndOfCandidates"]),
      });
      const answer = await a.createAnswer();
      const start = Date.now();
      let settledLocal = false;

      // Act: answer の適用 (gather 待ち) の直後に remote 候補を追加する。
      const applying = a.setLocalDescription(answer).then(() => {
        settledLocal = true;
      });
      await a.addIceCandidate({
        candidate: "candidate:1 1 udp 2130706431 127.0.0.1 9 typ host",
        sdpMid: a.getTransceivers()[0].mid!,
      });

      // Assert: 候補の追加は gather の完了を待たずに終わり、remote description に記録される。
      expect(Date.now() - start).toBeLessThan(1000);
      expect(settledLocal).toBe(false);
      expect(a.remoteDescription!.sdp).toContain("127.0.0.1 9 typ host");

      // Act: 後続の description 操作は先の 2 つの完了を待つ。
      const rollbackless = a.createOffer();
      await applying;
      await rollbackless;
      // Assert: answer が確定し、invariant を満たす。
      expect(a.signalingState).toBe("stable");
      assertNegotiationInvariants(a);
      // Arrange: answer を b に返さないので継続確認の対象外にする。
      exemptFromContinuation([a, b], "the test applies only a's answer");
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  }, 20000);

  test("rollback of a replacement local offer takes back the MID it gave a transceiver added meanwhile (as after a single offer)", async () => {
    // Arrange: 接続済みの session で re-offer を保留する。
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      await offerer.setLocalDescription(await offerer.createOffer());
      const added = offerer.addTransceiver("video");

      // Act: 保留中に足した transceiver を含む置き換えの offer を適用し、rollback する。
      await offerer.setLocalDescription(await offerer.createOffer());
      expect(added.mid).not.toBeNull();
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: 交渉されていない transceiver は MID と m-line の関連付けを失う。
      expect(added.mid).toBeNull();
      expect(added.mLineIndex).toBeUndefined();
      assertNegotiationInvariants(offerer);
      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(
        offerer,
        answerer,
        "replacement-rollback-mid",
      );
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a replacement local offer keeps a new transceiver associated with its m-line", async () => {
    const session = await createDuplexSession();
    const { a, b } = session;
    try {
      // Arrange: a が audio を足した offer を適用し、b にも渡す。
      const out = new MediaStreamTrack({ kind: "audio" });
      const audio = a.pc.addTransceiver(out, { direction: "sendonly" });
      await a.pc.setLocalDescription(await a.pc.createOffer());
      await b.pc.setRemoteDescription(a.pc.localDescription!);
      const mid = audio.mid!;

      // Act: 同じ内容の replacement offer を適用する。
      await a.pc.setLocalDescription(await a.pc.createOffer());

      // Assert: pending 中も transceiver は自分の m-line (MID・index) に結び付いたまま。
      expect(audio.mid).toBe(mid);
      expect(sectionOf(a.pc.pendingLocalDescription!.sdp, mid)).toContain(
        "m=audio",
      );
      assertNegotiationInvariants(a.pc);

      // Act: replacement offer に answer を返す。
      await b.pc.setRemoteDescription(a.pc.localDescription!);
      await b.pc.setLocalDescription(await b.pc.createAnswer());
      await a.pc.setRemoteDescription(b.pc.localDescription!);

      // Assert: audio が届き、既存の video・DataChannel も継続する。
      const remote = b.pc.getTransceivers().find((t) => t.mid === mid)!;
      await sendAndExpectRtp(out, remote.receiver.track, "replacement-audio");
      await expectSessionAlive(session, "replacement-audio");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(a.pc, b.pc, "replacement-offer");
    } finally {
      await session.close();
    }
  }, 60000);

  test("an answer does not give a direction to a transceiver without an m-line", async () => {
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      // Arrange: re-offer を受けた後に answerer が audio transceiver を足す。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const late = answerer.addTransceiver("audio", { direction: "sendonly" });

      // Act: その transceiver の m-line を含まない answer を適用する。
      await answerer.setLocalDescription(await answerer.createAnswer());

      // Assert: 交渉されていない transceiver は current direction を持たない。
      expect(late.mid).toBeNull();
      expect(late.currentDirection).toBeFalsy();
      assertNegotiationInvariants(answerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "late-transceiver");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("MIDs from unapplied createOffer calls do not collide with a later remote offer", async () => {
    const session = await createDuplexSession();
    const { a, b } = session;
    try {
      // Arrange: b が audio を足し、適用しない createOffer を 2 回呼ぶ (MID・index が仮に振られる)。
      const own = b.pc.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
        direction: "sendonly",
      });
      await b.pc.createOffer();
      await b.pc.createOffer();

      // Act: a が同じ種類の m-line を足した offer で交渉する。
      a.pc.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
        direction: "sendonly",
      });
      await negotiate(session, a, b);

      // Assert: b の MID は重複せず、b 自身の transceiver は停止も除外もされない。
      const mids = b.pc
        .getTransceivers()
        .map((t) => t.mid)
        .filter(Boolean);
      expect(new Set(mids).size).toBe(mids.length);
      expect(b.pc.getTransceivers()).toContain(own);
      expect(own.stopped).toBe(false);
      assertNegotiationInvariants(a.pc);
      assertNegotiationInvariants(b.pc);
      await expectSessionAlive(session, "unapplied-offer-mids");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(a.pc, b.pc, "unapplied-mids");
    } finally {
      await session.close();
    }
  }, 60000);

  test("the final answer after an ICE restart pranswer reuses the pranswer credentials", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: ICE restart offer に pranswer を返す。
      const ufragOf = (sdp: string) => sdp.match(/^a=ice-ufrag:(.*?)\r?$/m)![1];
      await offerer.setLocalDescription(
        await offerer.createOffer({ iceRestart: true }),
      );
      await answerer.setRemoteDescription(offerer.localDescription!);
      const pranswer = await answerer.createAnswer();
      await answerer.setLocalDescription({
        type: "pranswer",
        sdp: pranswer.sdp,
      });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });

      // Act: 最終 answer を改めて作って適用する。
      const answer = await answerer.createAnswer();
      await answerer.setLocalDescription(answer);
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: pranswer で広告した資格情報のまま確定し、live と SDP が一致して RTP が届く。
      expect(ufragOf(answer.sdp)).toBe(ufragOf(pranswer.sdp));
      expect(answerer.iceTransports[0].connection.localUsername).toBe(
        ufragOf(pranswer.sdp),
      );
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      await Promise.all([
        waitForCommittedNomination(offerer),
        waitForCommittedNomination(answerer),
      ]);
      await sendAndExpectRtp(outgoing, incoming, "pranswer-credentials");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "restart-pranswer");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);
});

/** Findings of the pre-review self-review of pending writes to live state. */
describe("negotiation transaction live-state regressions", () => {
  enforceSessionContinuation();

  test("a remote pranswer that changes send parameters is fully undone by rollback", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeersWithRtx();
    try {
      // Arrange: offerer の送信パラメータ (RTX を含む) を控え、RTX を外した pranswer を作る。
      const sender = offerer.getTransceivers()[0].sender;
      const before = sender.snapshotSendParams();
      expect(before.rtxPayloadType).toBeDefined();
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = (await answerer.createAnswer()).sdp;
      const rtxPt = answer.match(/^a=rtpmap:(\d+) rtx\/90000/m)![1];
      const withoutRtx = answer
        .replace(
          /^(m=video \d+ [^ ]+)(.*)$/m,
          (_, head, pts) =>
            `${head}${pts
              .split(" ")
              .filter((pt: string) => pt !== rtxPt)
              .join(" ")}`,
        )
        .split(/\r?\n/)
        .filter(
          (line) =>
            !new RegExp(`^a=(rtpmap|fmtp|rtcp-fb):${rtxPt} `).test(line),
        )
        .join("\r\n");

      // Act: pranswer を適用して送信側が暫定値に変わった後、rollback する。
      await offerer.setRemoteDescription({ type: "pranswer", sdp: withoutRtx });
      expect(sender.snapshotSendParams().rtxPayloadType).toBeUndefined();
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: 送信パラメータは current のものへ完全に戻り、RTP も届く。
      expect(sender.snapshotSendParams()).toEqual(before);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "send-params-rollback");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "pranswer-rollback");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a re-offer that changes RTCP feedback of a current payload type is staged until commit", async () => {
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      // Arrange: current の VP8 は nack を持つ。nack を外した re-offer を作る。
      const receiver = answerer.getTransceivers()[0].receiver;
      const offer = (await offerer.createOffer()).sdp;
      const pt = Number(offer.match(/^a=rtpmap:(\d+) VP8\/90000/m)![1]);
      const feedback = () =>
        receiver
          .snapshotReceiveTables()
          .codecs[pt].rtcpFeedback.map((f) => `${f.type} ${f.parameter ?? ""}`);
      expect(feedback()).toContain("nack ");
      const withoutNack = offer.replace(
        new RegExp(`^a=rtcp-fb:${pt} nack\\r?\\n`, "m"),
        "",
      );

      // Act: remote offer として適用する (answer はまだ返さない)。
      await answerer.setRemoteDescription({ type: "offer", sdp: withoutNack });

      // Assert: pending 中は current の feedback (nack) のまま。
      expect(feedback()).toContain("nack ");
      assertNegotiationInvariants(answerer);

      // Act: answer で確定する。
      await answerer.setLocalDescription(await answerer.createAnswer());

      // Assert: 確定時に新しい feedback へ切り替わる。
      expect(feedback()).not.toContain("nack ");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "feedback-staged");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a pending re-offer that adds transport-cc does not start TWCC feedback for the current stream", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: current は transport-cc なし。transport-cc を足した re-offer を作る。
      const receiver = answerer.getTransceivers()[0].receiver;
      expect(receiver.receiverTWCC).toBeUndefined();
      const offer = (await offerer.createOffer()).sdp;
      const pt = offer.match(/^a=rtpmap:(\d+) VP8\/90000/m)![1];
      const withTwcc = offer.replace(
        new RegExp(`^(a=rtpmap:${pt} VP8/90000)`, "m"),
        `$1\r\na=rtcp-fb:${pt} transport-cc`,
      );

      // Act: remote offer を適用して current の RTP を受け、rollback する。
      await answerer.setRemoteDescription({ type: "offer", sdp: withTwcc });
      await sendAndExpectRtp(outgoing, incoming, "twcc-pending");
      const pending = receiver.receiverTWCC;
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: pending 中も rollback 後も current の stream に TWCC は始まらない。
      expect(pending).toBeUndefined();
      expect(receiver.receiverTWCC).toBeUndefined();
      assertNegotiationInvariants(answerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "twcc-pending");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a local answer that flips the DTLS setup of a connected association is rejected", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: re-offer を受け、a=setup を反転させた local answer を作る。
      const dtls = answerer.dtlsTransports[0];
      const role = dtls.role;
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = (await answerer.createAnswer()).sdp;
      const flipped = answer.replace(/^a=setup:(\w+)/gm, (_, setup) =>
        setup === "active" ? "a=setup:passive" : "a=setup:active",
      );

      // Act: role を反転させる local answer を適用する。
      await expect(
        answerer.setLocalDescription({ type: "answer", sdp: flipped }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: 状態と role は変わらず、元の answer で確定でき RTP が届く。
      expect(answerer.signalingState).toBe("have-remote-offer");
      expect(dtls.role).toBe(role);
      await answerer.setLocalDescription({ type: "answer", sdp: answer });
      await offerer.setRemoteDescription(answerer.localDescription!);
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "local-setup-rejected");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "setup-rejected");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a transceiver created for a remote offer does not make negotiation needed", async () => {
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      // Arrange: answerer の negotiationneeded を数える。
      let needed = 0;
      answerer.onNegotiationneeded.subscribe(() => needed++);

      // Act: audio m-line を足した offer を受けて answer を返す。
      offerer.addTransceiver("audio", { direction: "sendonly" });
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await new Promise((resolve) => setImmediate(resolve));

      // Assert: remote offer 由来の transceiver では再交渉は要求されない。
      expect(needed).toBe(0);
      expect(answerer.getTransceivers()).toHaveLength(2);
      assertNegotiationInvariants(answerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "no-negotiationneeded");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a final answer replaces the RTCP feedback a pranswer staged", async () => {
    const session = await createDuplexSession();
    const { a, b } = session;
    try {
      // Arrange: re-offer を b に渡し、VP8 の NACK を外した pranswer を用意する。
      await a.pc.setLocalDescription(await a.pc.createOffer());
      await b.pc.setRemoteDescription(a.pc.localDescription!);
      const answer = await b.pc.createAnswer();
      const pt = Number(answer.sdp.match(/^a=rtpmap:(\d+) VP8\/90000/m)![1]);
      const withoutNack = answer.sdp.replace(
        new RegExp(`^a=rtcp-fb:${pt} nack\\r?\\n`, "m"),
        "",
      );
      expect(withoutNack).not.toBe(answer.sdp);
      const hasNack = () =>
        a.video.receiver
          .snapshotReceiveTables()
          .codecs[pt].rtcpFeedback.some(
            (f) => f.type === "nack" && !f.parameter,
          );

      // Act: NACK なしの pranswer を受け、NACK を含む final answer で確定する。
      await b.pc.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await a.pc.setRemoteDescription({ type: "pranswer", sdp: withoutNack });
      // Assert: pranswer の feedback 変更は commit まで保留され、current の NACK を保つ。
      expect(hasNack()).toBe(true);
      await b.pc.setLocalDescription({ type: "answer", sdp: answer.sdp });
      await a.pc.setRemoteDescription(b.pc.localDescription!);

      // Assert: 確定 SDP と receiver の feedback が一致し (helper も検査する)、通信が続く。
      expect(a.pc.currentRemoteDescription!.sdp).toContain(
        `a=rtcp-fb:${pt} nack\r\n`,
      );
      expect(hasNack()).toBe(true);
      assertNegotiationInvariants(a.pc);
      await expectSessionAlive(session, "pranswer-feedback-replaced");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(a.pc, b.pc, "pranswer-feedback");
    } finally {
      await session.close();
    }
  }, 60000);

  test("adding video after an inactive audio m-line does not take the audio m-line", async () => {
    const { offerer, answerer, close } = createUnnegotiatedPeers();
    try {
      // Arrange: inactive な audio m-line を確定させる。
      const audio = offerer.addTransceiver("audio", { direction: "inactive" });
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      const audioMid = audio.mid;
      expect(audio.currentDirection).toBe("inactive");

      // Act: 別 kind の video を追加して、自身の offer を作って適用する。
      const video = offerer.addTransceiver("video");
      await offerer.setLocalDescription(await offerer.createOffer());

      // Assert: audio は MID と index を保ち、video は新しい m-line を末尾に持つ。
      expect(audio.mid).toBe(audioMid);
      expect(audio.mLineIndex).toBe(0);
      expect(video.mid).not.toBe(audioMid);
      expect(video.mLineIndex).toBe(1);
      expect(offerer.getTransceivers()).toEqual([audio, video]);
      assertNegotiationInvariants(offerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "inactive-audio");
    } finally {
      await close();
    }
  }, 60000);

  test("an answer whose codec was not in the offer is rejected before mutation", async () => {
    const { offerer, answerer, close } = createUnnegotiatedPeers();
    try {
      // Arrange: 設定は Opus/PCMU に対応するが、offer は Opus だけを提案する。
      const audio = offerer.addTransceiver("audio");
      audio.codecs = offerer.config.codecs.audio!.filter(
        (codec) => codec.name.toLowerCase() === "opus",
      );
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();
      const unoffered = answer.sdp.replace(/opus\/48000\/2/i, "PCMU/8000");
      expect(unoffered).not.toBe(answer.sdp);
      const pendingOffer = offerer.pendingLocalDescription!.sdp;

      // Act / Assert: offer にない PCMU に差し替えた answer は InvalidAccessError で拒否される。
      await expect(
        offerer.setRemoteDescription({ type: "answer", sdp: unoffered }),
      ).rejects.toMatchObject({ name: "InvalidAccessError" });

      // Assert: 状態は変わらず、offer と合意する正しい answer はそのまま適用できる。
      expect(offerer.signalingState).toBe("have-local-offer");
      expect(offerer.pendingLocalDescription!.sdp).toBe(pendingOffer);
      expect(offerer.currentRemoteDescription).toBeNull();
      await offerer.setRemoteDescription(answer);
      expect(offerer.signalingState).toBe("stable");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "unoffered-codec");
    } finally {
      await close();
    }
  }, 60000);

  test.each([
    ["a host candidate", "127.0.0.1"],
    ["an mDNS candidate", "peer.local"],
  ])(
    "%s after end-of-candidates of an ICE restart pranswer reaches neither the pending SDP nor the provisional checklist",
    async (_, host) => {
      const { offerer, answerer, outgoing, incoming, ufrag, mid } =
        await createIceRestartPranswer();
      const mdns = stubIceMdns(offerer);
      try {
        // Arrange: pranswer の restart generation に end-of-candidates を適用する。
        await offerer.addIceCandidate({
          candidate: "",
          sdpMid: mid,
          usernameFragment: ufrag,
        });
        const pendingSdp = offerer.pendingRemoteDescription!.sdp;
        const provisional = provisionalIce(offerer)!;
        const candidates = provisional.remoteCandidates.length;
        const pairs = provisional.pairs.length;

        // Act: 同じ ufrag の候補が end-of-candidates の後に届く。
        await offerer.addIceCandidate(
          trickleCandidate(50999, ufrag, mid, host),
        );

        // Assert: 完了済み generation の pending SDP と provisional checklist は変わらない。
        expect(offerer.pendingRemoteDescription!.sdp).toBe(pendingSdp);
        expect(offerer.pendingRemoteDescription!.sdp).toContain(
          "a=end-of-candidates",
        );
        expect(provisional.remoteCandidatesEnd).toBe(true);
        expect(provisional.remoteCandidates).toHaveLength(candidates);
        expect(provisional.pairs).toHaveLength(pairs);
        // Assert: mDNS 名の解決も始めない。
        expect(mdns.requested).toBe(0);
        assertNegotiationInvariants(offerer);
        await sendAndExpectRtp(outgoing, incoming, "late-candidate-ignored");

        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "late-candidate");
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    60000,
  );

  test("an mDNS candidate that is still resolving does not hold later candidates or description operations", async () => {
    // Arrange: current の remote generation が trickle 継続中の接続済み peer と、解決しない mDNS lookup
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers({}, { trickleOpen: true });
    const mdns = stubIceMdns(answerer);
    try {
      const { ufrag, mid } = currentRemoteGeneration(answerer);

      // Act: mDNS 候補、通常の候補、description 操作をこの順に行う
      const mdnsElapsed = await elapsedMs(() =>
        answerer.addIceCandidate(
          trickleCandidate(50991, ufrag, mid, "peer.local"),
        ),
      );
      const hostElapsed = await elapsedMs(() =>
        answerer.addIceCandidate(trickleCandidate(50992, ufrag, mid)),
      );
      const offerElapsed = await elapsedMs(() => answerer.createOffer());

      // Assert: どの操作も mDNS の解決 (最大 10 秒) を待たずに終わり、通常の候補はすぐ checklist に入る
      expect(mdns.requested).toBe(1);
      expect(Math.max(mdnsElapsed, hostElapsed, offerElapsed)).toBeLessThan(
        1000,
      );
      await waitForRemoteCandidatePort(answerer, 50992);
      await sendAndExpectRtp(outgoing, incoming, "while mDNS resolves");

      // Act: mDNS の解決を完了させる
      mdns.resolveAll("127.0.0.1");

      // Assert: 解決後に mDNS 候補も同じ generation の checklist に入る
      await waitForRemoteCandidatePort(answerer, 50991);
      assertNegotiationInvariants(answerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "mdns-resolving");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("an mDNS candidate trickled before end-of-candidates of an ICE restart pranswer is kept", async () => {
    const { offerer, answerer, ufrag, mid } = await createIceRestartPranswer();
    const mdns = stubIceMdns(offerer);
    try {
      // Arrange: provisional generation の mDNS 候補を解決中にし、続けて EOC を送る。
      const resolving = offerer.addIceCandidate(
        trickleCandidate(50998, ufrag, mid, "peer.local"),
      );
      const end = offerer.addIceCandidate({
        candidate: "",
        sdpMid: mid,
        usernameFragment: ufrag,
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(mdns.requested).toBe(1);

      // Act: mDNS 解決を完了させる。
      mdns.resolveAll("127.0.0.1");
      await Promise.all([resolving, end]);

      // Assert: EOC 前に届いた候補は pending SDP と provisional checklist に入り、その後に完了する。
      const provisional = provisionalIce(offerer)!;
      expect(provisional.remoteCandidates.some((c) => c.port === 50998)).toBe(
        true,
      );
      expect(provisional.remoteCandidatesEnd).toBe(true);
      const section = sectionOf(offerer.pendingRemoteDescription!.sdp, mid);
      expect(section).toContain(" 50998 typ host");
      expect(section).toContain("a=end-of-candidates");
      assertNegotiationInvariants(offerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "mdns-before-eoc");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a restartIce() request survives a rolled-back offer until an answer commits new credentials", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    const ufragOf = (sdp: string) => sdp.match(/^a=ice-ufrag:(\S+)/m)![1];
    try {
      // Arrange: 接続済み session の current ICE 資格情報を控える。
      const old = ufragOf(offerer.currentLocalDescription!.sdp);

      // Act: restartIce() の offer を適用し、rollback してから offer を作り直す。
      offerer.restartIce();
      const first = await offerer.createOffer();
      await offerer.setLocalDescription(first);
      await offerer.setLocalDescription({ type: "rollback" });
      const retry = await offerer.createOffer();

      // Assert: rollback で要求は失われず、作り直した offer も新しい資格情報を提示する。
      expect(ufragOf(first.sdp)).not.toBe(old);
      expect(ufragOf(retry.sdp)).not.toBe(old);

      // Act: 作り直した offer で交渉を確定する。
      await offerer.setLocalDescription(retry);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await waitForCommittedNomination(offerer);
      const committed = ufragOf(offerer.currentLocalDescription!.sdp);

      // Assert: 要求は満たされ、次の offer は確定した資格情報を再利用し、RTP も届く。
      expect(committed).toBe(ufragOf(retry.sdp));
      expect(ufragOf((await offerer.createOffer()).sdp)).toBe(committed);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "restart-after-rollback");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "restart-rollback");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a sender added during a rolled-back offer keeps receiving RTCP after renegotiation", async () => {
    const session = await createDuplexSession();
    const { a, b } = session;
    try {
      // Arrange: re-offer を適用した pending 中に、アプリが送信用 video を追加する。
      await a.pc.setLocalDescription(await a.pc.createOffer());
      const late = a.pc.addTransceiver(
        new MediaStreamTrack({ kind: "video" }),
        {
          direction: "sendonly",
        },
      );
      const onPli = vi.fn();
      late.sender.onPictureLossIndication.subscribe(onPli);

      // Act: pending offer を rollback し (追加した sender は残る)、改めて交渉する。
      await a.pc.setLocalDescription({ type: "rollback" });
      // Assert: rollback 後も追加した sender の SSRC 経路が残る (helper も検査する)。
      assertNegotiationInvariants(a.pc);
      await negotiate(session, a, b);
      const receiver = b.pc
        .getTransceivers()
        .find((t) => t.mid === late.mid)!.receiver;
      await receiver.sendRtcpPLI(late.sender.ssrc);

      // Assert: 相手の PLI が追加した sender に実際に届き、既存の通信も続く。
      await vi.waitFor(() => expect(onPli).toHaveBeenCalled(), {
        timeout: 2000,
      });
      await expectSessionAlive(session, "late-sender-rtcp");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(a.pc, b.pc, "late-sender");
    } finally {
      await session.close();
    }
  }, 60000);

  test("restartIce() while a restart offer is pending also replaces the pending credentials", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    const ufragOf = (sdp: string) => sdp.match(/^a=ice-ufrag:(\S+)/m)![1];
    try {
      // Arrange: restart 資格情報を持つ offer を pending にする。
      await offerer.setLocalDescription(
        await offerer.createOffer({ iceRestart: true }),
      );
      const pending = ufragOf(offerer.pendingLocalDescription!.sdp);

      // Act: pending 中に restartIce() を呼び、その前の offer の answer を確定する。
      offerer.restartIce();
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await waitForCommittedNomination(offerer);
      // Assert: 以前の offer の資格情報で確定し、session は整合したまま通信できる。
      expect(ufragOf(offerer.currentLocalDescription!.sdp)).toBe(pending);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "restart-while-pending");

      // Act: 次の offer を作る。
      const retry = await offerer.createOffer();

      // Assert: 呼出し時に pending だった資格情報も置き換え対象なので、要求は残り新しい資格情報を出す。
      expect(ufragOf(retry.sdp)).not.toBe(pending);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "restart-pending");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("PLI stops at the commit of a re-offer that removes NACK/PLI for the same SSRC", async () => {
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
      // Assert: pending 中は current の設定のまま PLI が届く。
      expect(await pliReaches(receiver, sender)).toBe(true);

      // Act: answer で確定する。
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: 確定した SDP は PLI を持たず、PLI は送られない。
      expect(answerer.currentLocalDescription!.sdp).not.toMatch(
        /^a=rtcp-fb:\d+ nack/m,
      );
      expect(await pliReaches(receiver, sender)).toBe(false);
      assertNegotiationInvariants(answerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "pli-removed");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("PLI starts only at the commit of a re-offer that adds NACK/PLI for the same SSRC", async () => {
    const { offerer, answerer } =
      await createConnectedVideoPeers(videoWithoutFeedback);
    const sender = offerer.getTransceivers()[0].sender;
    const receiver = answerer.getTransceivers()[0].receiver;
    const addFeedback = async () => {
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription({
        type: "offer",
        sdp: rewriteVideoFeedback(offerer.localDescription!.sdp, "add"),
      });
    };
    try {
      // Arrange: 初回交渉は PLI を持たず、送られない。
      expect(await pliReaches(receiver, sender)).toBe(false);

      // Act: 同じ VP8 / SSRC に NACK/PLI を足した re-offer を pending にしてから rollback する。
      await addFeedback();
      // Assert: pending 中は current の設定のまま PLI は送られない。
      expect(await pliReaches(receiver, sender)).toBe(false);
      await answerer.setRemoteDescription({ type: "rollback" });
      await offerer.setLocalDescription({ type: "rollback" });
      // Assert: rollback 後も current の設定に戻ったまま送られない。
      expect(await pliReaches(receiver, sender)).toBe(false);

      // Act: 同じ re-offer を適用し、answer で確定する。
      await addFeedback();
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: 確定後は PLI が相手 sender に実際に届く。
      expect(await pliReaches(receiver, sender)).toBe(true);
      assertNegotiationInvariants(answerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "pli-added");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("header extension IDs the answer did not accept stay free for a later offer", async () => {
    // Arrange: remote の audio offer は werift が受理しない extmap を空き ID すべてに載せる
    const config = {
      headerExtensions: {
        audio: [useSdesMid()],
        video: [useSdesMid(), useAbsSendTime()],
      },
    };
    const remote = new RTCPeerConnection(config);
    const local = new RTCPeerConnection(config);
    try {
      remote.addTransceiver("audio");
      await remote.setLocalDescription(await remote.createOffer());
      await local.setRemoteDescription({
        type: "offer",
        sdp: addUnsupportedExtmaps(remote.localDescription!.sdp, "audio"),
      });
      await local.setLocalDescription(await local.createAnswer());
      await remote.setRemoteDescription(local.localDescription!);

      // Act: werift が video を追加して re-offer し、その ID をそのまま返す answer を適用する
      local.addTransceiver("video");
      await local.setLocalDescription(await local.createOffer());
      await remote.setRemoteDescription(local.localDescription!);
      await remote.setLocalDescription(await remote.createAnswer());
      await local.setRemoteDescription(remote.localDescription!);

      // Assert: 受理されなかった ID は使用中ではないので、answer は拒否されず stable になる
      expect(local.signalingState).toBe("stable");
      assertNegotiationInvariants(local);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(remote, local, "extmap-ids");
    } finally {
      await Promise.allSettled([remote.close(), local.close()]);
    }
  }, 60000);

  test("a payload type the answer did not accept can carry another codec in a later remote offer", async () => {
    // Arrange: remote の audio offer に werift が受理しない codec を PT 110 で載せ、answer で確定する
    const remote = new RTCPeerConnection();
    const local = new RTCPeerConnection();
    try {
      remote.addTransceiver("audio");
      await remote.setLocalDescription(await remote.createOffer());
      await local.setRemoteDescription({
        type: "offer",
        sdp: addOfferedCodec(
          remote.localDescription!.sdp,
          "audio",
          110,
          "FOO/8000",
        ),
      });
      await local.setLocalDescription(await local.createAnswer());
      await remote.setRemoteDescription(local.localDescription!);
      expect(local.currentLocalDescription!.sdp).not.toContain("FOO/8000");

      // Act: remote の re-offer が PT 110 を別の codec に使う
      await remote.setLocalDescription(await remote.createOffer());
      await local.setRemoteDescription({
        type: "offer",
        sdp: addOfferedCodec(
          remote.localDescription!.sdp,
          "audio",
          110,
          "BAR/8000",
        ),
      });

      // Assert: PT 110 は使用中ではないので re-offer は拒否されない
      expect(local.signalingState).toBe("have-remote-offer");
      await local.setLocalDescription(await local.createAnswer());
      assertNegotiationInvariants(local);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(remote, local, "payload-type");
    } finally {
      await Promise.allSettled([remote.close(), local.close()]);
    }
  }, 60000);

  test("close() during a pending BUNDLE split stops the transports the proposal prepared", async () => {
    // Arrange: video と audio を BUNDLE で共有する接続済み peer で、audio を分割する offer を適用中にする
    const { offerer, answerer } = await createConnectedVideoPeers(
      {},
      { withAudio: true },
    );
    const audioMid = offerer
      .getTransceivers()
      .find((transceiver) => transceiver.kind === "audio")!.mid!;
    const liveBefore = offerer.dtlsTransports.length;
    await offerer.setLocalDescription({
      type: "offer",
      sdp: await createSplitOffer(offerer, audioMid),
    });
    const held = heldTransports(offerer);
    expect(held.size).toBeGreaterThan(liveBefore);

    // Arrange: close() が検証対象なので、両 peer は継続確認の対象外にする。
    exemptFromContinuation(
      [offerer, answerer],
      "close() is the operation under test",
    );

    // Act: pending のまま close する
    await offerer.close();
    await answerer.close();

    // Assert: 分割用に用意した transport も含め、すべての DTLS / ICE が閉じる
    assertTransportsClosed(held);
  }, 60000);

  test("close() after a provisional split connection stops both peers' pending transports", async () => {
    // Arrange: audio を分割する re-offer に pranswer を返し、分割先の transport で暫定接続する
    const { offerer, answerer } = await createConnectedVideoPeers(
      {},
      { withAudio: true },
    );
    const audioMid = offerer
      .getTransceivers()
      .find((transceiver) => transceiver.kind === "audio")!.mid!;
    await offerer.setLocalDescription({
      type: "offer",
      sdp: await createSplitOffer(offerer, audioMid),
    });
    await answerer.setRemoteDescription(offerer.localDescription!);
    const answer = await answerer.createAnswer();
    await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
    await offerer.setRemoteDescription({ type: "pranswer", sdp: answer.sdp });
    const held = [...heldTransports(offerer), ...heldTransports(answerer)];
    await Promise.all(held.map((transport) => waitForDtlsConnected(transport)));

    // Arrange: close() が検証対象なので、両 peer は継続確認の対象外にする。
    exemptFromContinuation(
      [offerer, answerer],
      "close() is the operation under test",
    );

    // Act: 両 peer を pending のまま close する
    await offerer.close();
    await answerer.close();

    // Assert: 暫定接続した transport も含め、ICE / DTLS が動き続けない
    assertTransportsClosed(held);
  }, 60000);

  test("an ICE restart commit does not wait for an unreachable STUN server", async () => {
    // Arrange: 到達できない STUN server を設定した接続済み peer (初回の gather は 1 秒で打ち切る)
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers({
        iceServers: [{ urls: "stun:192.0.2.1:3478" }],
        iceStunGatherTimeout: 1,
      });
    try {
      offerer.restartIce();
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);

      // Act: 双方で restart の answer を適用 (commit) する
      const answerElapsed = await elapsedMs(async () =>
        answerer.setLocalDescription(await answerer.createAnswer()),
      );
      const commitElapsed = await elapsedMs(() =>
        offerer.setRemoteDescription(answerer.localDescription!),
      );

      // Assert: commit は STUN の応答 (最大 1 秒) を待たずに終わり、新しい generation で RTP が届く
      expect(Math.max(answerElapsed, commitElapsed)).toBeLessThan(500);
      await waitForCommittedNomination(offerer);
      await sendAndExpectRtp(outgoing, incoming, "after restart commit");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "stun-unreachable");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("restartIce() beside a new m-line with bundlePolicy disable offers the new transport's gathered candidates", async () => {
    // Arrange: BUNDLE しない接続済み peer
    const offerer = new RTCPeerConnection({ bundlePolicy: "disable" });
    const answerer = new RTCPeerConnection({ bundlePolicy: "disable" });
    try {
      offerer.addTransceiver("audio");
      await negotiatePair(offerer, answerer);

      // Act: 新しい m-line の追加と ICE restart を 1 つの offer で行う
      const video = offerer.addTransceiver("video");
      offerer.restartIce();
      await offerer.setLocalDescription(await offerer.createOffer());

      // Assert: まだ generation を持たない新しい transport は restart を stage せず、集めた候補を offer する
      const section = sectionOf(offerer.localDescription!.sdp, video.mid!);
      expect(section).toMatch(/^a=candidate:/m);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await waitForDtlsConnected(video.dtlsTransport);
      assertNegotiationInvariants(offerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "bundle-disable");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a re-answer with a=setup:actpass keeps the DTLS role of the live association", async () => {
    // Arrange: 接続済みの peer (answerer は active で答え、offerer は server になる)
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    try {
      offerer.createDataChannel("role");
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      const [transport] = offerer.dtlsTransports;
      await waitForDtlsConnected(transport);
      const role = transport.role;

      // Act: re-offer に a=setup:actpass の answer が返る
      await offerer.setLocalDescription(await offerer.createOffer());
      await offerer.setRemoteDescription({
        type: "answer",
        sdp: answerer.localDescription!.sdp.replace(
          /a=setup:\w+/g,
          "a=setup:actpass",
        ),
      });

      // Assert: 拒否されず、確立済み association の role は変わらない
      expect(offerer.signalingState).toBe("stable");
      expect(transport.role).toBe(role);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "actpass");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("close() while an ICE restart answer commits keeps the state closed", async () => {
    // Arrange: ICE restart の answer を適用する直前まで交渉する
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      offerer.restartIce();
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());

      // Arrange: close() が検証対象なので、両 peer は継続確認の対象外にする。
      exemptFromContinuation(
        [offerer, answerer],
        "close() is the operation under test",
      );

      // Act: answer の適用 (restart の commit) の途中で close する
      const gather = holdNextGather(offerer);
      const applying = offerer.setRemoteDescription(answerer.localDescription!);
      await gather.reached;
      await offerer.close();
      gather.release();

      // Assert: close に追い越された操作は成功を報告せず、signalingState は closed のまま
      await expect(applying).rejects.toMatchObject({
        name: "InvalidStateError",
      });
      expect(offerer.signalingState).toBe("closed");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a remote re-offer committed by the local answer switches the receive tables and the remote track codec", async () => {
    // Arrange: current は VP8、offerer が H264 だけの re-offer を出し answerer が適用済み (preference の変更なし)
    const { offerer, answerer, outgoing, incoming, transceiver } =
      await createH264OnlyReoffer();
    try {
      // Act: answer を作って適用し、offerer も answer を適用する
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: 受信表は H264 だけになり、remote track の codec も H264 に切り替わる
      const codecs = Object.values(
        transceiver.receiver.snapshotReceiveTables().codecs,
      ).map((codec) => codec.name.toUpperCase());
      expect(codecs).toEqual(["H264"]);
      expect(incoming.codec?.mimeType.toLowerCase()).toBe("video/h264");
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "after H264 commit");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "h264-reoffer");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("codec preferences resolved by createAnswer apply to live receive tables only at the answer commit", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers({
        codecs: { video: [useVP8(), useH264()] },
      });
    try {
      // Arrange: current は VP8。answerer は re-offer を受けた後で H264 だけを優先する。
      const transceiver = answerer.getTransceivers()[0];
      const receiver = transceiver.receiver;
      const vp8Pt = Number(
        answerer.currentLocalDescription!.sdp.match(
          /^a=rtpmap:(\d+) VP8\/90000/im,
        )![1],
      );
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      transceiver.setCodecPreferences([useH264()]);

      // Act: preference を反映した answer を作る (まだ適用しない)。
      const answer = await answerer.createAnswer();

      // Assert: answer は H264 だけを提案するが、pending 中は current の VP8 で受信を続ける。
      expect(answer.sdp).toMatch(/^a=rtpmap:\d+ H264\/90000/im);
      expect(answer.sdp).not.toMatch(/^a=rtpmap:\d+ VP8\/90000/im);
      expect(receiver.snapshotReceiveTables().codecs[vp8Pt]?.name).toBe("VP8");
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "answer-codec-pending");

      // Act: answer を適用して transaction を commit する。
      await answerer.setLocalDescription(answer);
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: commit 後は確定した H264 だけが受信 table に残る。
      const codecs = Object.values(receiver.snapshotReceiveTables().codecs);
      expect(codecs.map((codec) => codec.name.toUpperCase())).toEqual(["H264"]);
      assertNegotiationInvariants(answerer);
      assertNegotiationInvariants(offerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "answer-preferences");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("an answer applied during the DTLS handshake keeps the connected ICE state", async () => {
    const { offerer, answerer, outgoing, incoming, close } =
      createUnnegotiatedVideoPeers();
    try {
      // Arrange: 初回交渉の answerer 側 DTLS 開始を止め、offerer の handshake を
      // ICE 接続済み・DTLS connecting の状態に留める。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      const held = holdDtlsStart(answerer);
      await offerer.setRemoteDescription(answerer.localDescription!);
      await waitForIce(offerer);
      await waitForDtlsHandshake(offerer.dtlsTransports[0]);

      // Act: handshake 中に次の offer/answer を交換し、answer を適用する。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: 接続済みの ICE は checking に戻らず、DTLS 完了前に connected を報告しない。
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(offerer.iceConnectionState).toBe("connected");
      expect(offerer.dtlsTransports[0].state).toBe("connecting");
      expect(offerer.connectionState).toBe("connecting");

      // Act: 止めていた handshake を進める。
      held.release();
      await waitForDtlsConnected(offerer.dtlsTransports[0]);
      await waitForConnection(offerer);

      // Assert: ICE は connected のまま、DTLS 完了後に connected になり、RTP も届く。
      expect(offerer.iceConnectionState).toBe("connected");
      expect(offerer.connectionState).toBe("connected");
      await sendAndExpectRtp(outgoing, await incoming(), "after handshake");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "dtls-handshake");
    } finally {
      await close();
    }
  }, 60000);

  test("an answer without an ICE restart leaves a failed ICE generation failed", async () => {
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      // Arrange: 確立済みの session で offerer の ICE generation を failed にする
      // (consent の期限切れ相当)。
      forceIceState(offerer, "failed");
      const iceStates = recordIceConnectionStates(offerer);

      // Act: ICE restart を含まない再交渉を answer まで行う。
      await negotiatePair(offerer, answerer);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Assert: failed の generation は接続確認をやり直さず (checking に戻らず)、
      // connectionState も connected に上書きされない。
      expect(iceStates).not.toContain("checking");
      expect(offerer.iceConnectionState).toBe("failed");
      expect(offerer.connectionState).not.toBe("connected");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "failed-generation");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("an ICE restart keeps the configured icePasswordPrefix", async () => {
    // Arrange: icePasswordPrefix を設定して接続済みの peer を用意する
    const prefix = "werift";
    const { offerer, answerer } = await createConnectedVideoPeers({
      icePasswordPrefix: prefix,
    });
    try {
      // Act: ICE restart の offer を作る
      offerer.restartIce();
      const offer = await offerer.createOffer();

      // Assert: 新しい generation の ICE password にも prefix が付く
      const password = offer.sdp.match(/^a=ice-pwd:(\S+)/m)![1];
      expect(password.startsWith(prefix)).toBe(true);
      expect(password).not.toBe(
        offerer.currentLocalDescription!.sdp.match(/^a=ice-pwd:(\S+)/m)![1],
      );

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "password-prefix");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("the local answer lists codecs in the answerer's preference order", async () => {
    // Arrange: offerer は H264 → VP8、answerer は VP8 → H264 の順で設定する。
    const offerer = new RTCPeerConnection({
      codecs: { video: [useH264(), useVP8()] },
    });
    const answerer = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    try {
      offerer.addTransceiver("video");
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);

      // Act: answer を作る。
      const answer = await answerer.createAnswer();

      // Assert: answer の codec 順は remote offer ではなく answerer の設定順になる。
      expect(offeredVideoCodecs(answer.sdp)).toEqual(["VP8", "H264"]);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "answer-order");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a codec the local answer dropped leaves the receive table even when the re-offer staged it", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers({
        codecs: { video: [useVP8(), useH264()] },
      });
    try {
      // Arrange: current の VP8 から RTCP feedback を外した re-offer を受け、
      // 同じ payload type の VP8 を staged 値にする。answerer は H264 だけを優先する。
      const transceiver = answerer.getTransceivers()[0];
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription({
        type: "offer",
        sdp: rewriteVideoFeedback(offerer.localDescription!.sdp, "remove"),
      });
      transceiver.setCodecPreferences([useH264()]);
      const answer = await answerer.createAnswer();
      expect(offeredVideoCodecs(answer.sdp)).toEqual(["H264"]);

      // Act: H264 だけの answer を適用して commit する。
      await answerer.setLocalDescription(answer);
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: answer で外した VP8 は staged 値からも戻らず、受信表は H264 だけになる。
      expect(Object.values(receiveCodecNames(transceiver.receiver))).toEqual([
        "H264",
      ]);
      expect(incoming.codec?.mimeType.toLowerCase()).toBe("video/h264");
      assertNegotiationInvariants(answerer);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "after H264-only answer");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "dropped-codec");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("end-of-candidates trickled on a non-tag BUNDLE m-line completes the restarted generation", async () => {
    const { offerer, answerer } = await createConnectedVideoPeers(
      {},
      { withAudio: true },
    );
    try {
      // Arrange: audio (BUNDLE の非 tag) を含む session で、EOC を含まない ICE restart の
      // re-offer を answerer に適用する。
      offerer.restartIce();
      await offerer.setLocalDescription(await offerer.createOffer());
      const offer = offerer.localDescription!.sdp;
      const ufrag = offer.match(/^a=ice-ufrag:(\S+)/m)![1];
      await answerer.setRemoteDescription({
        type: "offer",
        sdp: offer.replace(/^a=end-of-candidates\r?\n/gm, ""),
      });
      const audioMid = answerer
        .getTransceivers()
        .find((t) => t.kind === "audio")!.mid!;

      // Act: 非 tag m-line に新 generation の EOC を trickle してから answer で確定する。
      await answerer.addIceCandidate({
        candidate: "",
        sdpMid: audioMid,
        usernameFragment: ufrag,
      });
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: 確定した共有 transport の generation が EOC を記録し、
      // current の全 m-line の SDP も EOC を持つ。
      const connection = answerer.iceTransports[0].connection;
      expect(connection.remoteUsername).toBe(ufrag);
      expect(connection.remoteCandidatesEnd).toBe(true);
      const current = answerer.currentRemoteDescription!.sdp;
      expect(current.match(/^a=end-of-candidates/gm)).toHaveLength(
        current.match(/^m=/gm)!.length,
      );
      assertNegotiationInvariants(answerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "non-tag-eoc");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a final answer cannot reverse the DTLS role a first pranswer connected with", async () => {
    const { offerer, answerer, pranswer, close } =
      await createInitialPranswerConnection();
    try {
      // Arrange: 初回 pranswer で接続した offerer の DTLS role を控える。
      const transport = offerer.dtlsTransports[0];
      const role = transport.role;

      // Act / Assert: a=setup を反転した final answer は適用前に拒否され、状態は変わらない。
      await expect(
        offerer.setRemoteDescription({
          type: "answer",
          sdp: reverseSetupRole(pranswer),
        }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });
      expect(transport.role).toBe(role);
      expect(offerer.signalingState).toBe("have-remote-pranswer");

      // Act: pranswer と同じ role の final answer で確定し、通常の再交渉を行う。
      await answerer.setLocalDescription({ type: "answer", sdp: pranswer });
      await offerer.setRemoteDescription({ type: "answer", sdp: pranswer });
      await negotiatePair(offerer, answerer);

      // Assert: 再交渉も成功し、role は維持される。
      expect(offerer.signalingState).toBe("stable");
      expect(transport.role).toBe(role);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "pranswer-role");
    } finally {
      await close();
    }
  }, 60000);

  test("rolling back a first pranswer connection resets the public connection states", async () => {
    const { offerer, answerer, close } =
      await createInitialPranswerConnection();
    try {
      // Arrange: 初回 pranswer で両 peer が接続済みと報告している。
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);

      // Act: 両 peer で初回交渉を rollback する。
      await answerer.setRemoteDescription({ type: "rollback" });
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: current session がないので、接続状態は new に戻る。
      for (const pc of [offerer, answerer]) {
        expect(pc.currentRemoteDescription).toBeNull();
        expect(pc.connectionState).toBe("new");
        expect(pc.iceConnectionState).toBe("new");
      }

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "pranswer-rollback");
    } finally {
      await close();
    }
  }, 60000);

  test("a remote-created transceiver the application keeps returns to its created state on rollback", async () => {
    const { offerer, answerer, remoteCreated, close } =
      await createInitialPranswerConnection();
    try {
      // Arrange: pranswer で remote 起因の transceiver に direction が確定している。
      expect(remoteCreated.currentDirection).not.toBeNull();

      // Act: answerer で remote offer を rollback する。
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: app が使う transceiver は残るが、交渉した MID・direction は持たない。
      expect(answerer.getTransceivers()).toContain(remoteCreated);
      expect(remoteCreated.mid).toBeNull();
      expect(remoteCreated.currentDirection).toBeNull();

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "remote-created");
    } finally {
      await close();
    }
  }, 60000);

  test("a saved answer commits its own codecs after an unapplied createOffer() resolved others", async () => {
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
      // Arrange: VP8 の answer を作って保存し、その後 H264 を選んで offer を作る (適用しない)。
      answererTransceiver.setCodecPreferences([useVP8()]);
      const answer = await answerer.createAnswer();
      answererTransceiver.setCodecPreferences([useH264()]);
      await answerer.createOffer();

      // Act: 保存した VP8 の answer を両 peer に適用する。
      await answerer.setLocalDescription(answer);
      await offerer.setRemoteDescription(answerer.localDescription!);
      await waitForPeersConnected(offerer, answerer);

      // Assert: 送受信は適用した answer の VP8 で確定し、双方向に RTP が届く。
      expect(offeredVideoCodecs(answerer.currentLocalDescription!.sdp)).toEqual(
        ["VP8"],
      );
      expect(answererTransceiver.sender.codec?.mimeType.toLowerCase()).toBe(
        "video/vp8",
      );
      expect(
        Object.values(receiveCodecNames(answererTransceiver.receiver)),
      ).toEqual(["VP8"]);
      assertNegotiationInvariants(answerer);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(
        offererOut,
        answererTransceiver.receiver.track,
        "saved-answer a-to-b",
      );
      await sendAndExpectRtp(
        answererOut,
        offererTransceiver.receiver.track,
        "saved-answer b-to-a",
      );

      // Assert: 未適用の offer で選んだ H264 は次の offer で解決し直される。
      expect(offeredVideoCodecs((await answerer.createOffer()).sdp)).toEqual([
        "H264",
      ]);

      // Arrange: answerer の codec の選択を既定に戻す (H264 だけの選択は VP8 しか
      // 持たない offerer の次の offer と両立しない。develop と同じく sRD が失敗する)。
      answererTransceiver.setCodecPreferences([]);
      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "saved-answer");
    } finally {
      await close();
    }
  }, 60000);

  test("a first pranswer sends and receives with the codecs it answered", async () => {
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
      // Arrange: answerer は H264 だけを選んだ answer を作る。
      answererTransceiver.setCodecPreferences([useH264()]);
      const answer = await answerer.createAnswer();

      // Act: その answer を初回の pranswer として両 peer に適用する。
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      await waitForPeersConnected(offerer, answerer);

      // Assert: 暫定通信は pranswer の H264 で双方向に届く。
      expect(answererTransceiver.sender.codec?.mimeType.toLowerCase()).toBe(
        "video/h264",
      );
      await sendAndExpectRtp(
        offererOut,
        answererTransceiver.receiver.track,
        "pranswer a-to-b",
      );
      await sendAndExpectRtp(
        answererOut,
        offererTransceiver.receiver.track,
        "pranswer b-to-a",
      );

      // Act: 同じ内容の final answer で確定する。
      await answerer.setLocalDescription({ type: "answer", sdp: answer.sdp });
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: 確定後も H264 のまま、invariant を満たし双方向に届く。
      assertNegotiationInvariants(answerer);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(
        answererOut,
        offererTransceiver.receiver.track,
        "answer b-to-a",
      );

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "first-pranswer");
    } finally {
      await close();
    }
  }, 60000);

  test("an ICE restart answer saved before createAnswer() ran again can still be applied", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: ICE restart の remote offer を受け、answer を保存してからもう一度作る。
      offerer.restartIce();
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const saved = await answerer.createAnswer();
      const regenerated = await answerer.createAnswer();
      const ufragOf = (sdp: string) => sdp.match(/^a=ice-ufrag:(\S+)/m)![1];

      // Assert: 同じ remote offer への answer は同じ restart generation を持つ。
      expect(ufragOf(regenerated.sdp)).toBe(ufragOf(saved.sdp));

      // Act: 保存した answer を両 peer に適用する。
      await answerer.setLocalDescription(saved);
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForCommittedNomination(offerer),
        waitForCommittedNomination(answerer),
      ]);

      // Assert: 交渉は確定し、新しい generation で RTP が届く。
      expect(answerer.signalingState).toBe("stable");
      expect(answerer.iceTransports[0].connection.localUsername).toBe(
        ufragOf(saved.sdp),
      );
      assertNegotiationInvariants(answerer);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "saved restart answer");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "saved-restart-answer");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test.each([
    {
      label: "createOffer({ iceRestart: true })",
      createOffer: (pc: RTCPeerConnection) =>
        pc.createOffer({ iceRestart: true }),
    },
    {
      label: "restartIce() + createOffer()",
      createOffer: (pc: RTCPeerConnection) => {
        pc.restartIce();
        return pc.createOffer();
      },
    },
  ])(
    "an unapplied $label does not discard the restart generation of a saved answer",
    async ({ createOffer }) => {
      const { offerer, answerer, outgoing, incoming } =
        await createConnectedVideoPeers();
      try {
        // Arrange: ICE restart の remote offer を受け、answer を保存する。
        offerer.restartIce();
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);
        const saved = await answerer.createAnswer();
        const ufragOf = (sdp: string) => sdp.match(/^a=ice-ufrag:(\S+)/m)![1];

        // Act: restart を要求する offer を作るが適用せず、保存した answer を両 peer に適用する。
        await createOffer(answerer);
        await answerer.setLocalDescription(saved);
        await offerer.setRemoteDescription(answerer.localDescription!);
        await Promise.all([
          waitForCommittedNomination(offerer),
          waitForCommittedNomination(answerer),
        ]);

        // Assert: 保存した answer の generation で確定し、RTP が届く。
        expect(answerer.signalingState).toBe("stable");
        expect(answerer.iceTransports[0].connection.localUsername).toBe(
          ufragOf(saved.sdp),
        );
        assertNegotiationInvariants(answerer);
        assertNegotiationInvariants(offerer);
        await sendAndExpectRtp(outgoing, incoming, "saved answer after offer");

        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(
          offerer,
          answerer,
          "saved-answer-after-offer",
        );
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    60000,
  );

  test("an offer created while a remote offer is pending keeps the MIDs and m-line positions it associated", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: answerer に未交渉の audio を足し、offerer の re-offer を受ける。
      const audio = answerer.addTransceiver("audio");
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const video = answerer.getTransceivers()[0];
      const before = { mid: video.mid, index: video.mLineIndex };
      const saved = await answerer.createAnswer();

      // Act: 適用できない offer を作り、保存した answer を両 peer に適用する。
      await answerer.createOffer();
      await answerer.setLocalDescription(saved);
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: offer の生成で MID・m-line 位置は変わらず、未交渉の audio にも付かない。
      expect({ mid: video.mid, index: video.mLineIndex }).toEqual(before);
      expect(audio.mid).toBeNull();
      expect(audio.mLineIndex).toBeUndefined();
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "after unapplied offer");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "offer-while-pending");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("an offer created while a remote offer was pending can be applied after stable and negotiates its new audio", async () => {
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      // Arrange: answerer に新規 audio を足し、remote re-offer の保留中に
      // answer と offer を作って保存する。
      const audioOut = new MediaStreamTrack({ kind: "audio" });
      const audio = answerer.addTransceiver(audioOut, {
        direction: "sendonly",
      });
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const savedAnswer = await answerer.createAnswer();
      const savedOffer = await answerer.createOffer();
      await answerer.setLocalDescription(savedAnswer);
      await offerer.setRemoteDescription(answerer.localDescription!);
      expect(answerer.signalingState).toBe("stable");

      // Act: stable に戻った後で保存した offer を適用し、その answer を交換する。
      await answerer.setLocalDescription(savedOffer);
      await offerer.setRemoteDescription(answerer.localDescription!);
      await offerer.setLocalDescription(await offerer.createAnswer());
      await answerer.setRemoteDescription(offerer.localDescription!);

      // Assert: 新規 audio は offer の MID で交渉され、停止せずに RTP が届く。
      expect(audio.mid).not.toBeNull();
      expect(audio.currentDirection).toBe("sendonly");
      const received = offerer
        .getTransceivers()
        .find((t) => t.mid === audio.mid)!;
      assertNegotiationInvariants(answerer);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(
        audioOut,
        received.receiver.track,
        "audio from saved offer",
      );

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "saved-offer");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("re-applying the same offer after its rollback negotiates the new audio it carries", async () => {
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      // Arrange: 確立済みの session に audio を足して offer を作る。
      const audioOut = new MediaStreamTrack({ kind: "audio" });
      const audio = offerer.addTransceiver(audioOut, { direction: "sendonly" });
      const offer = await offerer.createOffer();

      // Act: offer を適用して rollback し、同じ offer を再適用して answer で確定する。
      await offerer.setLocalDescription(offer);
      await offerer.setLocalDescription({ type: "rollback" });
      expect(audio.mid).toBeNull();
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: audio は offer の MID で交渉され、停止せずに RTP が届く。
      expect(audio.stopped).toBe(false);
      expect(audio.currentDirection).toBe("sendonly");
      const received = answerer
        .getTransceivers()
        .find((t) => t.mid === audio.mid)!;
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(
        audioOut,
        received.receiver.track,
        "audio re-applied offer",
      );

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "reapplied-offer");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test.each([
    { label: "video only", withAudio: false },
    { label: "with a new audio", withAudio: true },
  ])(
    "a saved ICE restart offer re-applied after its rollback commits its generation ($label)",
    async ({ withAudio }) => {
      const { offerer, answerer, outgoing, incoming } =
        await createConnectedVideoPeers();
      try {
        // Arrange: (必要なら audio を足して) ICE restart の offer を作って保存する。
        const audioOut = new MediaStreamTrack({ kind: "audio" });
        const audio = withAudio
          ? offerer.addTransceiver(audioOut, { direction: "sendonly" })
          : undefined;
        const offer = await offerer.createOffer({ iceRestart: true });
        const ufrag = offer.sdp.match(/^a=ice-ufrag:(\S+)/m)![1];

        // Act: 適用 → rollback → 同じ offer を再適用し、answer で確定する。
        await offerer.setLocalDescription(offer);
        await offerer.setLocalDescription({ type: "rollback" });
        await offerer.setLocalDescription(offer);
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);
        await Promise.all([
          waitForCommittedNomination(offerer),
          waitForCommittedNomination(answerer),
        ]);

        // Assert: offer の restart generation で確定し、映像 (と audio) の RTP が届く。
        expect(offerer.iceTransports[0].connection.localUsername).toBe(ufrag);
        assertNegotiationInvariants(offerer);
        assertNegotiationInvariants(answerer);
        await sendAndExpectRtp(
          outgoing,
          incoming,
          "video after re-applied restart",
        );
        if (audio) {
          expect(audio.stopped).toBe(false);
          const received = answerer
            .getTransceivers()
            .find((t) => t.mid === audio.mid)!;
          await sendAndExpectRtp(
            audioOut,
            received.receiver.track,
            "audio after re-applied restart",
          );
        }

        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "reapplied-restart");
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    60000,
  );

  test("a saved restart offer re-applied after the peer committed another restart still restarts to its generation", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: audio を足した ICE restart offer を適用して rollback し、その後で
      // 相手からの ICE restart を確定して ICE generation を進める。
      const audioOut = new MediaStreamTrack({ kind: "audio" });
      const audio = offerer.addTransceiver(audioOut, { direction: "sendonly" });
      const offer = await offerer.createOffer({ iceRestart: true });
      const ufrag = offer.sdp.match(/^a=ice-ufrag:(\S+)/m)![1];
      await offerer.setLocalDescription(offer);
      await offerer.setLocalDescription({ type: "rollback" });
      answerer.restartIce();
      await negotiatePair(answerer, offerer);
      await Promise.all([
        waitForCommittedNomination(offerer),
        waitForCommittedNomination(answerer),
      ]);
      expect(offerer.iceTransports[0].connection.localUsername).not.toBe(ufrag);

      // Act: 保存した (最新の作成) offer を再適用し、answer で確定する。
      // develop も受理して通信できる (再利用契約 (b))。
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForCommittedNomination(offerer),
        waitForCommittedNomination(answerer),
      ]);

      // Assert: offer の restart generation の資格情報で確定し、SDP と ICE agent が一致する。
      expect(offerer.iceTransports[0].connection.localUsername).toBe(ufrag);
      expect(offerer.currentLocalDescription!.sdp).toContain(
        `a=ice-ufrag:${ufrag}`,
      );
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);

      // Assert: 映像と、offer が足した audio の RTP が届く。
      const received = answerer
        .getTransceivers()
        .find((t) => t.mid === audio.mid)!;
      await sendAndExpectRtp(
        outgoing,
        incoming,
        "video after re-applied offer",
      );
      await sendAndExpectRtp(
        audioOut,
        received.receiver.track,
        "audio after re-applied offer",
      );

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(
        offerer,
        answerer,
        "reapplied-after-peer-restart",
      );
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a re-applied restart offer that fails to parse leaves no staged credentials", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: audio を含む restart offer を適用して rollback し、相手の通常 offer で
      // 同じ m-line 位置に video を確定する。
      const audio = offerer.addTransceiver("audio", { direction: "sendonly" });
      const saved = await offerer.createOffer({ iceRestart: true });
      await offerer.setLocalDescription(saved);
      await offerer.setLocalDescription({ type: "rollback" });
      answerer.addTransceiver("video", { direction: "sendonly" });
      await negotiatePair(answerer, offerer);
      const iceTransport = offerer.iceTransports[0];
      const before = {
        signalingState: offerer.signalingState,
        current: offerer.currentLocalDescription!.sdp,
        ufrag: iceTransport.localParameters.usernameFragment,
        staged: iceTransport.hasStagedRestart,
        audio: { mid: audio.mid, index: audio.mLineIndex },
      };

      // Act / Assert: 保存した offer の再適用は m-line の不整合で拒否される。
      await expect(offerer.setLocalDescription(saved)).rejects.toThrow();

      // Assert: stage し直した資格情報や MID は残らず、失敗前と同じ状態になる。
      expect({
        signalingState: offerer.signalingState,
        current: offerer.currentLocalDescription!.sdp,
        ufrag: iceTransport.localParameters.usernameFragment,
        staged: iceTransport.hasStagedRestart,
        audio: { mid: audio.mid, index: audio.mLineIndex },
      }).toEqual(before);
      expect(before.staged).toBe(false);
      expect(before.current).toContain(`a=ice-ufrag:${before.ufrag}`);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "after rejected re-apply");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "rejected-reapply");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a remote answer that answers only the leading m-lines of the offer is accepted and rejects the rest", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 相手の前回の answer (m-line が少ない) を保存し、offerer は video を足した
      // offer を適用する。
      const staleAnswer = answerer.currentLocalDescription!;
      const added = offerer.addTransceiver("video", { direction: "sendonly" });
      await offerer.setLocalDescription(await offerer.createOffer());

      // Act: 先頭の m-line だけに答える前回の answer を適用する (develop も受理する)。
      await offerer.setRemoteDescription(staleAnswer);

      // Assert: 確定し、答えられなかった m-line は拒否として停止する。既存の映像は届く。
      expect(offerer.signalingState).toBe("stable");
      expect(added.stopped).toBe(true);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "after a shorter answer");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "shorter-answer");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a first offer with a DataChannel re-applied after its rollback opens the channel", async () => {
    const { offerer, answerer, close } = createUnnegotiatedPeers();
    try {
      // Arrange: DataChannel を持つ初回 offer を作り、適用して rollback する。
      const channel = offerer.createDataChannel("reapplied");
      const offer = await offerer.createOffer();
      await offerer.setLocalDescription(offer);
      await offerer.setLocalDescription({ type: "rollback" });
      const sctpTransport = offerer.sctpTransport!.dtlsTransport;

      // Act: 同じ offer を再適用し、answer で確定する。
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: SCTP の m-line は offer が作られた SCTP transport のまま交渉され
      // (余分な transport を作らない)、DataChannel が開いて届く。
      expect(offerer.sctpTransport!.dtlsTransport).toBe(sctpTransport);
      const received = await answerer.onDataChannel
        .asPromise(5000)
        .then(([c]) => c);
      if (channel.readyState !== "open") {
        await channel.stateChanged.watch((state) => state === "open", 5000);
      }
      const message = received.onMessage.watch(
        (data) => data.toString() === "hello",
        5000,
      );
      channel.send(Buffer.from("hello"));
      await message;
      assertNegotiationInvariants(offerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "reapplied-datachannel");
    } finally {
      await close();
    }
  }, 60000);

  test("an answer created again after an unapplied restart offer keeps the saved answer's generation", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: ICE restart の remote offer に answer を作って保存し、未適用の restart
      // offer を作ってから answer をもう一度作る。
      offerer.restartIce();
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const saved = await answerer.createAnswer();
      await answerer.createOffer({ iceRestart: true });
      const regenerated = await answerer.createAnswer();
      const ufragOf = (sdp: string) => sdp.match(/^a=ice-ufrag:(\S+)/m)![1];

      // Assert: 同じ remote offer への answer は、間に作った offer に関係なく同じ generation を持つ。
      expect(ufragOf(regenerated.sdp)).toBe(ufragOf(saved.sdp));

      // Act: 保存した answer を両 peer に適用する。
      await answerer.setLocalDescription(saved);
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForCommittedNomination(offerer),
        waitForCommittedNomination(answerer),
      ]);

      // Assert: 保存した answer の generation で確定し、RTP が届く。
      expect(answerer.iceTransports[0].connection.localUsername).toBe(
        ufragOf(saved.sdp),
      );
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(
        outgoing,
        incoming,
        "saved answer after offer and regeneration",
      );

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "regenerated-answer");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a max-compat first offer connects to a peer that answers without BUNDLE", async () => {
    // Arrange: 既定 (max-compat) の offerer と、BUNDLE を使わず m-line ごとに独立した
    // ICE 資格情報で答える answerer。
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection({ bundlePolicy: "disable" });
    const audioOut = new MediaStreamTrack({ kind: "audio" });
    const videoOut = new MediaStreamTrack({ kind: "video" });
    try {
      offerer.addTransceiver(audioOut, { direction: "sendonly" });
      offerer.addTransceiver(videoOut, { direction: "sendonly" });

      // Act: 初回交渉を行い、すべての transport の接続を待つ。
      await negotiatePair(offerer, answerer);
      await Promise.all(
        [offerer, answerer].flatMap((pc) =>
          pc.dtlsTransports.map((transport) => waitForDtlsConnected(transport)),
        ),
      );

      // Assert: BUNDLE なしの answer を受理し、m-line ごとの transport で接続して
      // audio・video とも届く。
      expect(offerer.signalingState).toBe("stable");
      expect(new Set(offerer.dtlsTransports).size).toBe(2);
      const received = (kind: string) =>
        answerer.getTransceivers().find((t) => t.kind === kind)!.receiver.track;
      await sendAndExpectRtp(audioOut, received("audio"), "non-bundle audio");
      await sendAndExpectRtp(videoOut, received("video"), "non-bundle video");
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "non-bundle-answerer");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("the latest restart offer, committed once, applies again after the peer committed another restart", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 保存した restart offer を一度確定し、続けて相手からの別の restart を確定する。
      const offer = await offerer.createOffer({ iceRestart: true });
      const ufrag = offer.sdp.match(/^a=ice-ufrag:(\S+)/m)![1];
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await waitForCommittedNomination(offerer);
      answerer.restartIce();
      await negotiatePair(answerer, offerer);
      await Promise.all([
        waitForCommittedNomination(offerer),
        waitForCommittedNomination(answerer),
      ]);
      expect(offerer.iceTransports[0].connection.localUsername).not.toBe(ufrag);

      // Act: createOffer をやり直さず、保存した (最新の作成) offer を再適用して確定する。
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForCommittedNomination(offerer),
        waitForCommittedNomination(answerer),
      ]);

      // Assert: offer の generation に restart して確定し、RTP が届く。
      expect(offerer.iceTransports[0].connection.localUsername).toBe(ufrag);
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "latest offer applied again");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "latest-offer-again");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("a candidate on the tag m-line after end-of-candidates on a non-tag member of a pending restart is ignored", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers({}, { withAudio: true });
    try {
      // Arrange: EOC を含まない ICE restart の re-offer を answerer に適用し、
      // 非 tag (audio) の m-line に新 generation の EOC を trickle する。
      offerer.restartIce();
      await offerer.setLocalDescription(await offerer.createOffer());
      const offer = offerer.localDescription!.sdp;
      const ufrag = offer.match(/^a=ice-ufrag:(\S+)/m)![1];
      await answerer.setRemoteDescription({
        type: "offer",
        sdp: offer.replace(/^a=end-of-candidates\r?\n/gm, ""),
      });
      const [video, audio] = ["video", "audio"].map(
        (kind) => answerer.getTransceivers().find((t) => t.kind === kind)!.mid!,
      );
      await answerer.addIceCandidate({
        candidate: "",
        sdpMid: audio,
        usernameFragment: ufrag,
      });

      // Act: 同じ BUNDLE の tag (video) m-line に、同じ generation の遅延候補を送り、answer で確定する。
      await answerer.addIceCandidate(trickleCandidate(49999, ufrag, video));
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForCommittedNomination(offerer),
        waitForCommittedNomination(answerer),
      ]);

      // Assert: 終端通知の後の候補は pending SDP にも確定後の ICE にも入らない (RFC 8838)。
      const connection = answerer.iceTransports[0].connection;
      expect(connection.remoteCandidatesEnd).toBe(true);
      expect(
        connection.remoteCandidates.some(
          (candidate) => candidate.port === 49999,
        ),
      ).toBe(false);
      expect(answerer.currentRemoteDescription!.sdp).not.toContain(" 49999 ");
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "after ignored candidate");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "ignored-candidate");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("close() while createAnswer() prepares the transports of a BUNDLE split leaves none running", async () => {
    const { offerer, answerer, close } =
      await createConnectedMultiVideoPeers(3);
    let hook: ReturnType<typeof closeDuringNextPreparedGather> | undefined;
    try {
      // Arrange: 3 m-line の BUNDLE から 2 つを外す (owner transport を 2 つ準備させる) re-offer を受ける。
      const [, second, third] = offerer.getTransceivers().map((t) => t.mid!);
      const split = await createRewrittenOffer(offerer, (sdp) =>
        sdp.replace(
          /^a=group:BUNDLE [^\r\n]+/m,
          `a=group:BUNDLE ${offerer.getTransceivers()[0].mid}`,
        ),
      );
      expect([second, third]).toHaveLength(2);
      await offerer.setLocalDescription(split);
      await answerer.setRemoteDescription(offerer.localDescription!);
      hook = closeDuringNextPreparedGather(answerer);

      // Arrange: close() が検証対象なので、両 peer は継続確認の対象外にする。
      exemptFromContinuation(
        [offerer, answerer],
        "close() is the operation under test",
      );

      // Act: createAnswer の transport 準備 (最初の gather) の途中で close する。
      await expect(answerer.createAnswer()).rejects.toMatchObject({
        name: "InvalidStateError",
      });
      await hook.closed();
      hook.restore();

      // Assert: 準備を始めた transport は止まり、close の後に新しい transport は作られない。
      expect(hook.gathered).toHaveLength(1);
      for (const transport of hook.gathered) {
        expect(transport.state).toBe("closed");
      }
      expect(answerer.connectionState).toBe("closed");
    } finally {
      hook?.restore();
      await close();
    }
  }, 60000);

  test("end-of-candidates on a pending restart reaches its BUNDLE group but not an m-line the offer splits off", async () => {
    const { offerer, answerer } = await createConnectedVideoPeers(
      {},
      { withAudio: true },
    );
    try {
      // Arrange: ICE restart と BUNDLE 解除 (audio を group から外す) を行い、両 MID が
      // 同じ ufrag/pwd を持つ remote offer を、transport 準備 (createAnswer) の前まで適用する。
      offerer.restartIce();
      const [video, audio] = ["video", "audio"].map(
        (kind) => offerer.getTransceivers().find((t) => t.kind === kind)!.mid!,
      );
      const offer = await createRewrittenOffer(offerer, (sdp) => {
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
      });
      const ufrag = sectionOf(offer.sdp, video).match(
        /^a=ice-ufrag:(\S+)/m,
      )![1];
      await answerer.setRemoteDescription(offer);

      // Act: video (tag) にだけ end-of-candidates を通知し、分割される audio に候補を送る。
      await answerer.addIceCandidate({
        candidate: "",
        sdpMid: video,
        usernameFragment: ufrag,
      });
      await answerer.addIceCandidate(trickleCandidate(49998, ufrag, audio));

      // Assert: 終端は video の BUNDLE group だけが完了扱いになり、独立する audio は
      // 完了せず候補を受け入れる。
      const pending = answerer.pendingRemoteDescription!.sdp;
      expect(sectionOf(pending, video)).toContain("a=end-of-candidates");
      expect(sectionOf(pending, audio)).not.toContain("a=end-of-candidates");
      expect(sectionOf(pending, audio)).toContain(" 49998 typ host");

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "split-eoc");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);
});

/** Findings of the peer-diversity SDP mutations (negotiationTransactionMutation). */
describe("negotiation transaction mutation regressions", () => {
  enforceSessionContinuation();

  test("an answer declining BUNDLE onto the same transport keeps the ended generation complete", async () => {
    // Arrange: 確立済み session (EOC 済み) で re-offer を両側に置く。
    const session = await createMutationSession("renegotiation");
    const { a, b } = session;
    try {
      await a.pc.setLocalDescription(await a.pc.createOffer());
      await b.pc.setRemoteDescription(a.pc.localDescription!);
      const answer = (await b.pc.createAnswer()).sdp;
      await b.pc.setLocalDescription({ type: "answer", sdp: answer });

      // Act: BUNDLE も end-of-candidates も持たない answer を適用する。
      await a.pc.setRemoteDescription({
        type: "answer",
        sdp: mutate(answer, ["noBundle", "noEndOfCandidates"]),
      });

      // Assert: 同じ transport・ufrag の m-line はどれも終端済みとして記録される。
      const current = a.pc.currentRemoteDescription!.sdp;
      expect(sectionOf(current, "0")).toContain("a=end-of-candidates");
      expect(sectionOf(current, "1")).toContain("a=end-of-candidates");
      assertNegotiationInvariants(a.pc);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(a.pc, b.pc, "declined-bundle");
    } finally {
      await session.close();
    }
  }, 60000);

  test("new remote credentials next to an inactive m-line keep only the new remote generation's candidates", async () => {
    // Arrange: 確立済み session で re-offer を両側に置く。
    const session = await createMutationSession("renegotiation");
    const { a, b } = session;
    try {
      await a.pc.setLocalDescription(await a.pc.createOffer());
      await b.pc.setRemoteDescription(a.pc.localDescription!);
      const answer = (await b.pc.createAnswer()).sdp;
      await b.pc.setLocalDescription({ type: "answer", sdp: answer });
      // Arrange: answer は実際の b と異なる資格情報を名乗るので、継続確認の対象外にする。
      exemptFromContinuation(
        [a.pc, b.pc],
        "the answer misdescribes b's ICE credentials",
      );

      // Act: tag の video を inactive にし、別の資格情報を持たせた answer を適用する
      // (develop から既存の renomination 経路: inactive の m-line と資格情報の変更)。
      await a.pc.setRemoteDescription({
        type: "answer",
        sdp: mutate(answer, ["videoInactive", "videoSeparateCredentials"]),
      });

      // Assert: live の remote generation は新しい資格情報で、前の generation の
      // ufrag を名乗る候補は checklist に残らない。
      const connection = a.video.dtlsTransport.iceTransport.connection;
      expect(connection.remoteUsername).toBe("mutv");
      expect(
        connection.remoteCandidates.filter(
          (candidate) => candidate.ufrag && candidate.ufrag !== "mutv",
        ),
      ).toEqual([]);
      assertNegotiationInvariants(a.pc);
    } finally {
      await session.close();
    }
  }, 60000);

  test("new remote credentials in an answer keep the local credentials the offer described", async () => {
    // Arrange: 確立済み session で re-offer を両側に置く。
    const session = await createMutationSession("renegotiation");
    const { a, b } = session;
    try {
      await a.pc.setLocalDescription(await a.pc.createOffer());
      const offered = sectionOf(a.pc.localDescription!.sdp, "1").match(
        /^a=ice-ufrag:(\S+)/m,
      )![1];
      await b.pc.setRemoteDescription(a.pc.localDescription!);
      const answer = (await b.pc.createAnswer()).sdp;
      await b.pc.setLocalDescription({ type: "answer", sdp: answer });

      // Act: tag の video を拒否し、新しい tag の application が別の資格情報を持つ answer を適用する。
      await a.pc.setRemoteDescription({
        type: "answer",
        sdp: mutate(answer, ["separateCredentials", "videoRejected"]),
      });

      // Assert: remote は新しい資格情報で checks をやり直し、local の資格情報は
      // offer で伝えたまま (どの SDP にも無い資格情報を作らない)。
      const connection =
        a.pc.sctpTransport!.dtlsTransport.iceTransport.connection;
      expect(connection.remoteUsername).toBe("mutd");
      expect(connection.localUsername).toBe(offered);
      assertNegotiationInvariants(a.pc);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(a.pc, b.pc, "new-credentials");
    } finally {
      await session.close();
    }
  }, 60000);

  test("a rejected m-line does not turn a credential change into a renomination", async () => {
    // Arrange: video を拒否し application に新しい資格情報を持たせた offer を b に届ける。
    const session = await createMutationSession("renegotiation");
    const { a, b } = session;
    try {
      await a.pc.setLocalDescription(await a.pc.createOffer());
      await b.pc.setRemoteDescription({
        type: "offer",
        sdp: mutate(a.pc.localDescription!.sdp, [
          "separateCredentials",
          "videoRejected",
        ]),
      });
      const oldUfrag =
        b.pc.sctpTransport!.dtlsTransport.iceTransport.connection.localUsername;
      await b.pc.setLocalDescription(await b.pc.createAnswer());

      // Act: b が新しい資格情報で答えた answer を a に適用する。
      await a.pc.setRemoteDescription(b.pc.localDescription!);

      // Assert: a の checklist に b の旧 generation の候補は残らない。
      const connection =
        a.pc.sctpTransport!.dtlsTransport.iceTransport.connection;
      expect(connection.remoteUsername).not.toBe(oldUfrag);
      for (const candidate of connection.remoteCandidates) {
        expect(candidate.ufrag ?? connection.remoteUsername).toBe(
          connection.remoteUsername,
        );
      }
      assertNegotiationInvariants(a.pc);

      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(a.pc, b.pc, "rejected-mline");
    } finally {
      await session.close();
    }
  }, 60000);
});
