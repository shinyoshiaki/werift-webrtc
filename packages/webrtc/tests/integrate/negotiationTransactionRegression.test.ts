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
  createConnectedVideoPeers,
  createConnectedVideoPeersWithRtx,
  createDuplexSession,
  createH264OnlyReoffer,
  createIceRestartPranswer,
  createInitialPranswerConnection,
  createSplitOffer,
  createUnnegotiatedPeers,
  createUnnegotiatedVideoPeers,
  currentRemoteGeneration,
  elapsedMs,
  expectSessionAlive,
  forceIceState,
  heldTransports,
  holdDtlsStart,
  holdNextGather,
  negotiate,
  offeredVideoCodecs,
  pliReaches,
  provisionalIce,
  receiveCodecNames,
  recordIceConnectionStates,
  reverseSetupRole,
  rewriteVideoFeedback,
  sectionOf,
  sendAndExpectRtp,
  stubIceMdns,
  trickleCandidate,
  videoWithoutFeedback,
  waitForCommittedNomination,
  waitForConnection,
  waitForDtlsConnected,
  waitForDtlsHandshake,
  waitForIce,
  waitForRemoteCandidatePort,
} from "./negotiationTransactionUtils";

/**
 * Deterministic regressions for what the negotiation property test found
 * (see negotiationTransactionProperty.test.ts for the seeds).
 */
describe("negotiation transaction regressions", () => {
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
    } finally {
      await session.close();
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await session.close();
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });
});

/** Findings of the pre-review self-review of pending writes to live state. */
describe("negotiation transaction live-state regressions", () => {
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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await session.close();
    }
  });

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
    } finally {
      await close();
    }
  });

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
    } finally {
      await close();
    }
  });

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
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await session.close();
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([remote.close(), local.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([remote.close(), local.close()]);
    }
  });

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

    // Act: pending のまま close する
    await offerer.close();
    await answerer.close();

    // Assert: 分割用に用意した transport も含め、すべての DTLS / ICE が閉じる
    assertTransportsClosed(held);
  });

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

    // Act: 両 peer を pending のまま close する
    await offerer.close();
    await answerer.close();

    // Assert: 暫定接続した transport も含め、ICE / DTLS が動き続けない
    assertTransportsClosed(held);
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("close() while an ICE restart answer commits keeps the state closed", async () => {
    // Arrange: ICE restart の answer を適用する直前まで交渉する
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      offerer.restartIce();
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());

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
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await close();
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

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
    } finally {
      await close();
    }
  });

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
    } finally {
      await close();
    }
  });

  test("a remote-created transceiver the application keeps returns to its created state on rollback", async () => {
    const { answerer, remoteCreated, close } =
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
    } finally {
      await close();
    }
  });
});
