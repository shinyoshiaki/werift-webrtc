import { vi } from "vitest";
import { MediaStreamTrack, useH264, useVP8 } from "../../src";
import {
  assertNegotiationInvariants,
  createConnectedVideoPeers,
  createConnectedVideoPeersWithRtx,
  createDuplexSession,
  createIceRestartPranswer,
  createUnnegotiatedPeers,
  expectSessionAlive,
  negotiate,
  pliReaches,
  provisionalIce,
  rewriteVideoFeedback,
  sectionOf,
  sendAndExpectRtp,
  stubIceMdns,
  trickleCandidate,
  videoWithoutFeedback,
  waitForCommittedNomination,
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
});
