import { vi } from "vitest";

import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from "../../src";
import { RTCIceTransport } from "../../src/transport/ice";
import {
  addNegotiatedAudio,
  assertNegotiationInvariants,
  createConnectedMediaAndDataPeers,
  createConnectedVideoPeers,
  createConnectedVideoPeersWithRtx,
  createDuplexSession,
  createRewrittenOffer,
  createSimulcastPeers,
  createSplitOffer,
  createUnnegotiatedVideoPeers,
  expectSessionAlive,
  keepOnlyRtx,
  negotiate,
  negotiateAndExpectChannel,
  negotiationInternals,
  sendAndExpectData,
  sendAndExpectRtp,
  waitForCommittedNomination,
  waitForConnection,
  waitForDtlsConnected,
  waitForIce,
  waitForProvisionalNomination,
} from "./negotiationTransactionUtils";

describe("negotiation transaction", () => {
  test("rollback preserves application stop and a new trackless transceiver", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 接続済み transceiver の identity と現在の SDP を控える。
      const existing = answerer.getTransceivers()[0];
      const currentRemote = answerer.currentRemoteDescription!.sdp;
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);

      // Act: pending 中にアプリが停止と track のない transceiver 追加を行う。
      existing.stop();
      const added = answerer.addTransceiver("audio", { direction: "recvonly" });
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: SDP 由来の状態だけが戻り、アプリ操作と旧実通信が残る。
      expect(answerer.getTransceivers()).toContain(existing);
      expect(existing.stopping).toBe(true);
      expect(answerer.getTransceivers()).toContain(added);
      expect(added.sender.track).toBeNull();
      expect(added.mid).toBeNull();
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
      await sendAndExpectRtp(outgoing, incoming, "app-operations-rollback");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test.each([
    [
      "answer MID with a suffix",
      (sdp: string) => sdp.replace("a=mid:0", "a=mid:0_extra"),
    ],
    [
      "BUNDLE member with a suffix",
      (sdp: string) =>
        sdp.replace(/^a=group:BUNDLE 0\b/m, "a=group:BUNDLE 0_extra"),
    ],
  ])("an %s is rejected before any state changes", async (_, munge) => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: re-offer を commit 前まで進め、offerer の状態を控える。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      const answer = answerer.localDescription!.sdp;
      const current = offerer.currentRemoteDescription!.sdp;
      const transceivers = offerer.getTransceivers();
      const mids = transceivers.map((t) => t.mid);
      const invalid = munge(answer);
      expect(invalid).not.toBe(answer);

      // Act: offer と完全一致しない MID を含む answer を適用する。
      const result = offerer.setRemoteDescription({
        type: "answer",
        sdp: invalid,
      });

      // Assert: 拒否され、signaling・current・transceiver と MID は変わらない。
      await expect(result).rejects.toMatchObject({
        name: expect.stringMatching(/InvalidModificationError|OperationError/),
      });
      expect(offerer.signalingState).toBe("have-local-offer");
      expect(offerer.currentRemoteDescription!.sdp).toBe(current);
      expect(offerer.getTransceivers()).toEqual(transceivers);
      expect(offerer.getTransceivers().map((t) => t.mid)).toEqual(mids);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "exact-mid-rejected");

      // Act: offer と一致する answer はそのまま commit できる。
      await offerer.setRemoteDescription({ type: "answer", sdp: answer });

      // Assert: stable に戻り旧 RTP 経路も続く。
      expect(offerer.signalingState).toBe("stable");
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "exact-mid-committed");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("a remote offer whose BUNDLE member is not an exact MID creates nothing", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const onRemoteTransceiver = vi.fn();
    answerer.onRemoteTransceiverAdded.subscribe(onRemoteTransceiver);
    try {
      // Arrange: BUNDLE group の MID に suffix を付けた初回 offer を作る。
      offerer.addTransceiver("audio");
      const offer = await offerer.createOffer();
      const invalid = offer.sdp.replace(
        /^a=group:BUNDLE 0\b/m,
        "a=group:BUNDLE 0_extra",
      );

      // Act: その offer を remote description として適用する。
      const result = answerer.setRemoteDescription({
        type: "offer",
        sdp: invalid,
      });

      // Assert: 拒否され、transceiver も通知も作られず stable のまま。
      await expect(result).rejects.toMatchObject({ name: "OperationError" });
      expect(answerer.signalingState).toBe("stable");
      expect(answerer.remoteDescription).toBeFalsy();
      expect(answerer.getTransceivers()).toHaveLength(0);
      expect(onRemoteTransceiver).not.toHaveBeenCalled();
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("a replacement local offer whose transport preparation fails keeps the earlier pending offer", async () => {
    const session = await createDuplexSession();
    const { a, b } = session;
    try {
      // Arrange: audio を追加して交渉し、audio を BUNDLE から外す offer を
      // pending にする (分割用の新 transport が準備される)。
      const audio = await addNegotiatedAudio(session, a, b);
      await a.pc.setLocalDescription({
        type: "offer",
        sdp: await createSplitOffer(a.pc, audio.mid),
      });
      const pending = a.pc.pendingLocalDescription!.sdp;
      const internal = a.pc as unknown as {
        negotiation: {
          transportByMid: Map<string, RTCPeerConnection["dtlsTransports"][0]>;
        };
      };
      const preparedAudio = internal.negotiation.transportByMid.get(audio.mid)!;
      expect(a.pc.dtlsTransports).not.toContain(preparedAudio);
      const replacement = await createSplitOffer(a.pc, audio.mid);
      const gather = vi
        .spyOn(RTCIceTransport.prototype, "gather")
        .mockRejectedValueOnce(new Error("gather failed"));

      // Act: 新 transport の ICE gathering が失敗する replacement offer を適用する。
      const result = a.pc.setLocalDescription({
        type: "offer",
        sdp: replacement,
      });

      // Assert: 失敗し、先行 pending offer・準備済み transport・signaling state が残る。
      await expect(result).rejects.toThrow("gather failed");
      gather.mockRestore();
      expect(a.pc.signalingState).toBe("have-local-offer");
      expect(a.pc.pendingLocalDescription!.sdp).toBe(pending);
      expect(internal.negotiation.transportByMid.get(audio.mid)).toBe(
        preparedAudio,
      );
      expect(preparedAudio.iceTransport.state).not.toBe("closed");
      assertNegotiationInvariants(a.pc);
      await expectSessionAlive(session, "failed-replacement");

      // Act: 残った先行 offer に answer して commit する。
      await b.pc.setRemoteDescription(a.pc.localDescription!);
      await b.pc.setLocalDescription(await b.pc.createAnswer());
      await a.pc.setRemoteDescription(b.pc.localDescription!);
      await Promise.all([
        waitForDtlsConnected(audio.transceiver.dtlsTransport),
        waitForDtlsConnected(audio.remote().dtlsTransport),
      ]);

      // Assert: 先行 offer の分割 transport で audio が届き、既存経路も続く。
      expect(audio.transceiver.dtlsTransport).toBe(preparedAudio);
      assertNegotiationInvariants(a.pc);
      assertNegotiationInvariants(b.pc);
      await sendAndExpectRtp(
        audio.out,
        audio.remote().receiver.track,
        "split-after-failed-replacement",
      );
      await expectSessionAlive(session, "after-failed-replacement");
    } finally {
      vi.restoreAllMocks();
      await session.close();
    }
  });

  test.each([
    ["during a pending re-offer", false],
    ["after an unapplied createOffer in stable", true],
  ])(
    "rollback keeps simulcast SSRCs learned %s",
    async (_, createOfferFirst) => {
      const { offerer, answerer, sendLayer, close } =
        await createSimulcastPeers();
      try {
        // Arrange: RID 付き packet で high/low の SSRC を受信側に学習させる。
        await sendLayer("low", 2222, "low-learned", { withRid: true });
        if (createOfferFirst) {
          // Arrange: 受信側が offer を作るだけで適用しない (transaction は開かない)。
          await answerer.createOffer();
          assertNegotiationInvariants(answerer);
        }
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);

        // Act: pending 中に RID 付き packet で別 SSRC を学習し、両側で rollback する。
        await sendLayer("high", 1111, "high-learned", { withRid: true });
        await offerer.setLocalDescription({ type: "rollback" });
        await answerer.setRemoteDescription({ type: "rollback" });

        // Assert: RID なし (SSRC のみ) の packet が学習済みの各層へ届き続ける。
        await sendLayer("high", 1111, "high-after-rollback", {
          withRid: false,
        });
        await sendLayer("low", 2222, "low-after-rollback", { withRid: false });
        expect(answerer.signalingState).toBe("stable");
        assertNegotiationInvariants(answerer);
        assertNegotiationInvariants(offerer);
      } finally {
        await close();
      }
    },
  );

  test.each([
    ["in have-local-offer", "local-offer"],
    ["in have-remote-offer", "remote-offer"],
    ["between createOffer and setting that older offer", "stale-offer"],
  ] as const)(
    "rollback keeps a DataChannel created %s and the next negotiation opens it",
    async (_, when) => {
      const { offerer, answerer, outgoing, incoming, close } =
        createUnnegotiatedVideoPeers();
      try {
        // Arrange: m=application を含まない初回 offer で transaction を開く。
        let channel;
        let creator = offerer;
        let peer = answerer;
        if (when === "stale-offer") {
          const staleOffer = await offerer.createOffer();
          channel = offerer.createDataChannel(when);
          await offerer.setLocalDescription(staleOffer);
        } else {
          await offerer.setLocalDescription(await offerer.createOffer());
          if (when === "remote-offer") {
            await answerer.setRemoteDescription(offerer.localDescription!);
            creator = answerer;
            peer = offerer;
          }
          channel = creator.createDataChannel(when);
        }

        // Act: application の createDataChannel を挟んだ transaction を rollback する。
        await offerer.setLocalDescription({ type: "rollback" });
        if (answerer.signalingState === "have-remote-offer") {
          await answerer.setRemoteDescription({ type: "rollback" });
        }

        // Assert: SCTP transport は止まらず、未交渉 (MID/remote port なし) で残る。
        expect(creator.signalingState).toBe("stable");
        expect(creator.sctpTransport).toBe(channel.sctp);
        expect(channel.readyState).toBe("connecting");
        assertNegotiationInvariants(offerer);
        assertNegotiationInvariants(answerer);

        // Act: 作成側から改めて交渉する。
        if (creator === answerer) creator.addTransceiver("video");
        const received = await negotiateAndExpectChannel(
          creator,
          peer,
          channel,
        );

        // Assert: channel が開いて両方向に届き、交渉済みの RTP も届く。
        await sendAndExpectData(received, channel, `${when}-reply`);
        if (creator === offerer) {
          await sendAndExpectRtp(outgoing, await incoming(), `${when}-rtp`);
        }
        assertNegotiationInvariants(offerer);
        assertNegotiationInvariants(answerer);
      } finally {
        await close();
      }
    },
  );

  test("an answer whose RTX has no associated codec is rejected before mutation", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeersWithRtx();
    try {
      // Arrange: re-offer に対し、VP8 を落として RTX だけを残した answer を作る。
      await offerer.setLocalDescription(await offerer.createOffer());
      const pendingOffer = offerer.pendingLocalDescription!.sdp;
      const current = offerer.currentRemoteDescription!.sdp;
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      const answer = answerer.localDescription!.sdp;

      // Act: apt の指す codec がない answer を適用する。
      await expect(
        offerer.setRemoteDescription({
          type: "answer",
          sdp: keepOnlyRtx(answer),
        }),
      ).rejects.toMatchObject({ name: "OperationError" });

      // Assert: 事前検証で拒否され、pending offer・current・RTP は変わらない。
      expect(offerer.signalingState).toBe("have-local-offer");
      expect(offerer.pendingLocalDescription!.sdp).toBe(pendingOffer);
      expect(offerer.currentRemoteDescription!.sdp).toBe(current);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "rtx-only-rejected");

      // Act: 正しい answer を適用する。
      await offerer.setRemoteDescription({ type: "answer", sdp: answer });

      // Assert: 交渉が完了し RTP も継続する。
      expect(offerer.signalingState).toBe("stable");
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "rtx-only-recovered");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("a remote offer that fails while applying leaves no partial state", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 音声を足す re-offer を作り、受信側の RTP 適用を一度だけ失敗させる。
      offerer.addTransceiver("audio", { direction: "sendonly" });
      await offerer.setLocalDescription(await offerer.createOffer());
      const current = answerer.currentRemoteDescription!.sdp;
      const transceivers = answerer.getTransceivers().length;
      const internals = negotiationInternals(answerer);
      const spy = vi
        .spyOn(internals.transceiverManager, "setRemoteRTP")
        .mockImplementationOnce(() => {
          throw new Error("injected apply failure");
        });

      // Act: 事前検証を通った後の適用中に例外が起きる。
      await expect(
        answerer.setRemoteDescription(offerer.localDescription!),
      ).rejects.toThrow("injected apply failure");
      spy.mockRestore();

      // Assert: stable に戻り、作りかけの transceiver も transaction も残らない。
      expect(answerer.signalingState).toBe("stable");
      expect(answerer.pendingRemoteDescription).toBeNull();
      expect(answerer.currentRemoteDescription!.sdp).toBe(current);
      expect(answerer.getTransceivers()).toHaveLength(transceivers);
      expect(internals.negotiation.inspect().phase).toBe("idle");
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "offer-apply-failed");

      // Act: 同じ offer を改めて適用し交渉を完了する。
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: 両側 stable で音声 m-line が加わり、既存 RTP も届く。
      expect(answerer.getTransceivers()).toHaveLength(transceivers + 1);
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "offer-apply-recovered");
    } finally {
      vi.restoreAllMocks();
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("an answer that fails while applying returns to its pending offer", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: re-offer と answer を用意し、offer 側の RTP 適用を一度だけ失敗させる。
      await offerer.setLocalDescription(await offerer.createOffer());
      const pendingOffer = offerer.pendingLocalDescription!.sdp;
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      const spy = vi
        .spyOn(negotiationInternals(offerer).transceiverManager, "setRemoteRTP")
        .mockImplementationOnce(() => {
          throw new Error("injected apply failure");
        });

      // Act: answer の適用中に例外が起きる。
      await expect(
        offerer.setRemoteDescription(answerer.localDescription!),
      ).rejects.toThrow("injected apply failure");
      spy.mockRestore();

      // Assert: pending offer のまま残り、transaction も pending に戻り、binding と current RTP は壊れない。
      expect(offerer.signalingState).toBe("have-local-offer");
      expect(offerer.pendingLocalDescription!.sdp).toBe(pendingOffer);
      expect(negotiationInternals(offerer).negotiation.inspect().phase).toBe(
        "pending",
      );
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "answer-apply-failed");

      // Act: 同じ answer を改めて適用する。
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: 交渉が完了し RTP も継続する。
      expect(offerer.signalingState).toBe("stable");
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "answer-apply-recovered");
    } finally {
      vi.restoreAllMocks();
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("an ICE restart answer that fails while applying keeps the committed generation and pair", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 現在の ICE generation と選択済み pair を控え、ICE restart offer/answer を用意する。
      const transport = offerer.iceTransports[0];
      const liveUfrag = () => transport.connection.localUsername;
      const ufrag = liveUfrag();
      const pair = transport.getSelectedCandidatePair();
      const generation = offerer.iceGeneration;
      await offerer.setLocalDescription(
        await offerer.createOffer({ iceRestart: true }),
      );
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      const answer = answerer.localDescription!;
      const spy = vi
        .spyOn(negotiationInternals(offerer).transceiverManager, "setRemoteRTP")
        .mockImplementationOnce(() => {
          throw new Error("injected apply failure");
        });

      // Act: restart answer の適用中に例外が起きる。
      await expect(offerer.setRemoteDescription(answer)).rejects.toThrow(
        "injected apply failure",
      );
      spy.mockRestore();

      // Assert: restart は確定せず、generation・ufrag・選択済み pair が残り、RTP が届く。
      expect(offerer.signalingState).toBe("have-local-offer");
      expect(offerer.iceGeneration).toBe(generation);
      expect(liveUfrag()).toBe(ufrag);
      expect(transport.getSelectedCandidatePair()).toEqual(pair);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "restart-answer-failed");

      // Act: 同じ answer を改めて適用する。
      await offerer.setRemoteDescription(answer);
      await waitForCommittedNomination(offerer);

      // Assert: 新しい generation に切り替わり、RTP も継続する。
      expect(offerer.signalingState).toBe("stable");
      expect(offerer.iceGeneration).toBe(generation + 1);
      expect(liveUfrag()).not.toBe(ufrag);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "restart-answer-recovered");
    } finally {
      vi.restoreAllMocks();
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("a queued candidate that the answer cannot place rejects the answer before commit", async () => {
    const { offerer, answerer, outgoing, incoming, close } =
      createUnnegotiatedVideoPeers();
    try {
      // Arrange: 初回 offer/answer を作り、offerer に remote description より先に候補を積む。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      const answer = answerer.localDescription!;
      const line = answer.sdp.match(/^a=(candidate:.*?)\r?$/m)![1];
      await offerer.addIceCandidate({
        candidate: line,
        sdpMid: "missing-mid",
      });
      const pendingOffer = offerer.pendingLocalDescription!.sdp;

      // Act: 置き場所のない候補が queue にある状態で answer を適用する。
      await expect(offerer.setRemoteDescription(answer)).rejects.toMatchObject({
        name: "OperationError",
      });

      // Assert: answer は commit されず、pending offer と transaction が残り、answer の ICE 資格情報も入らない。
      expect(offerer.signalingState).toBe("have-local-offer");
      expect(offerer.remoteDescription).toBeNull();
      expect(offerer.currentRemoteDescription).toBeNull();
      expect(offerer.pendingLocalDescription!.sdp).toBe(pendingOffer);
      expect(negotiationInternals(offerer).negotiation.inspect().phase).toBe(
        "pending",
      );
      const answerUfrag = answer.sdp.match(/^a=ice-ufrag:(.*?)\r?$/m)![1];
      expect(offerer.iceTransports[0].connection.remoteUsername).not.toBe(
        answerUfrag,
      );
      assertNegotiationInvariants(offerer);

      // Act: 同じ answer を改めて適用する (拒否した候補は queue から外れている)。
      await offerer.setRemoteDescription(answer);

      // Assert: 交渉が完了し、RTP が届く。
      expect(offerer.signalingState).toBe("stable");
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, await incoming(), "queued-candidate");
    } finally {
      await close();
    }
  });

  test.each(["pranswer", "answer"] as const)(
    "a %s that flips the DTLS setup of a connected association is rejected and the role survives rollback",
    async (type) => {
      const { offerer, answerer, outgoing, incoming } =
        await createConnectedVideoPeers();
      try {
        // Arrange: 現在の DTLS role を控え、setup を反転させた再交渉の応答を作る。
        const dtls = offerer.dtlsTransports[0];
        const role = dtls.role;
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        const answer = answerer.localDescription!.sdp;
        const flipped = answer.replace(/^a=setup:(\w+)/gm, (_, setup) =>
          setup === "active" ? "a=setup:passive" : "a=setup:active",
        );
        expect(flipped).not.toBe(answer);

        // Act: role を反転させる応答を適用する。
        await expect(
          offerer.setRemoteDescription({ type, sdp: flipped }),
        ).rejects.toMatchObject({ name: "InvalidModificationError" });

        // Assert: 提案は受理されず、稼働中 association の role と RTP は変わらない。
        expect(offerer.signalingState).toBe("have-local-offer");
        expect(dtls.role).toBe(role);
        assertNegotiationInvariants(offerer);
        await sendAndExpectRtp(outgoing, incoming, `${type}-role-rejected`);

        // Act: 両側を rollback する。
        await offerer.setLocalDescription({ type: "rollback" });

        // Assert: rollback 後も role は変わらず、RTP が届く。
        expect(offerer.signalingState).toBe("stable");
        expect(dtls.role).toBe(role);
        assertNegotiationInvariants(offerer);
        await sendAndExpectRtp(outgoing, incoming, `${type}-role-rollback`);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
  );

  test("a trickle candidate of the unchanged ICE generation reaches the live checklist during a re-offer", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers({}, { trickleOpen: true });
    try {
      // Arrange: EOC 前の世代のまま ICE restart なしの re-offer を pending にし、同じ ufrag の新しい候補を作る。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription({
        type: "offer",
        sdp: offerer.localDescription!.sdp.replace(
          /^a=end-of-candidates\r?\n/gm,
          "",
        ),
      });
      const offer = offerer.localDescription!.sdp;
      const ufrag = offer.match(/^a=ice-ufrag:(.*?)\r?$/m)![1];
      const mid = offer.match(/^a=mid:(.*?)\r?$/m)![1];
      const [, foundation, component, protocol, priority, ip] = offer.match(
        /^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) \d+ typ host/m,
      )!;
      const port = 40999;
      const candidate = `candidate:${foundation}9 ${component} ${protocol} ${priority} ${ip} ${port} typ host`;
      const connection = answerer.iceTransports[0].connection;
      const livePorts = () =>
        connection.remoteCandidates.filter(
          (c) => c.host === ip && c.port === port,
        ).length;
      expect(livePorts()).toBe(0);

      // Act: 同じ候補を 2 回 trickle する。
      for (let i = 0; i < 2; i++) {
        await answerer.addIceCandidate({
          candidate,
          sdpMid: mid,
          usernameFragment: ufrag,
        });
      }

      // Assert: pending と current の両 SDP に記録され、稼働中 checklist には 1 回だけ届く。
      expect(answerer.pendingRemoteDescription!.sdp).toContain(
        ` ${port} typ host`,
      );
      expect(answerer.currentRemoteDescription!.sdp).toContain(
        ` ${port} typ host`,
      );
      expect(livePorts()).toBe(1);
      assertNegotiationInvariants(answerer);

      // Act: re-offer を両側で rollback する。
      await answerer.setRemoteDescription({ type: "rollback" });
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: 同じ世代の候補は current に残り、既存 RTP も届く。
      expect(answerer.currentRemoteDescription!.sdp).toContain(
        ` ${port} typ host`,
      );
      expect(livePorts()).toBe(1);
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "same-generation-trickle");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("an answer leaves the MID of a rejected m-line out of its BUNDLE group", async () => {
    const session = await createDuplexSession();
    try {
      // Arrange: 音声を追加で交渉し、answer 側がその transceiver を stop する。
      const audio = await addNegotiatedAudio(session, session.a, session.b);
      audio.remote().stop();

      // Act: a から再交渉し、b は stop 済みの m-line を拒否した answer を返す。
      await negotiate(session, session.a, session.b);

      // Assert: answer の音声 m-line は port 0 で BUNDLE group に含まれない。
      const answer = session.b.pc.currentLocalDescription!;
      const section = answer.sdp
        .split(/(?=^m=)/m)
        .find((part) =>
          new RegExp(`^a=mid:${audio.mid}\\r?$`, "m").test(part),
        )!;
      expect(section).toMatch(/^m=audio 0 /);
      const group = answer.sdp
        .match(/^a=group:BUNDLE (.*)$/m)![1]
        .trim()
        .split(" ");
      expect(group).not.toContain(audio.mid);
      expect(group).toContain(session.a.video.mid);

      // Assert: BUNDLE に残る映像と DataChannel は両方向で通信を続ける。
      await expectSessionAlive(session, "rejected-mid-out-of-bundle");
    } finally {
      await session.close();
    }
  });

  test("rollback and close drop the transaction's references to closed or unused objects", async () => {
    const { offerer, answerer, close } = createUnnegotiatedVideoPeers();
    const internals = negotiationInternals(offerer);
    try {
      // Arrange: 初回 offer を適用し、DataChannel 用の transport も作らせる。
      await offerer.setLocalDescription(await offerer.createOffer());
      offerer.createDataChannel("references");
      await offerer.createOffer();

      // Act: rollback する。
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: 停止した transport への参照は残らない。
      const afterRollback = internals.negotiation.inspect();
      expect(afterRollback.phase).toBe("idle");
      expect(
        afterRollback.createdTransports.filter((t) => t.state === "closed"),
      ).toEqual([]);

      // Act: offer を作ったまま close する。
      await offerer.createOffer();
      await offerer.close();

      // Assert: transport と offer snapshot の参照をすべて手放す。
      const afterClose = internals.negotiation.inspect();
      expect(afterClose.createdTransports).toEqual([]);
      expect(afterClose.hasOfferSnapshot).toBe(false);
    } finally {
      await close();
    }
  });

  test("a pending payload type leaves the receiver codec table by rollback", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 受信側の codec/RTX 対応表を控え、新しい PT 120 を足した
      // re-offer を用意する (既存 PT の割当ては変えない)。
      const receiver = answerer.getTransceivers()[0].receiver;
      const baseline = receiver.snapshotReceiveTables();
      const committedPt = Number(
        Object.entries(baseline.codecs).find(
          ([, codec]) => codec.mimeType === "video/VP8",
        )![0],
      );
      await offerer.setLocalDescription(await offerer.createOffer());
      const withNewPt = offerer
        .localDescription!.sdp.replace(/^(m=video [^\r\n]+)/m, "$1 120")
        .replace(
          /^(a=rtpmap:\d+ VP8\/90000\r?\n)/m,
          "$1a=rtpmap:120 VP8/90000\r\n",
        );

      // Act: 新 PT を含む remote offer を pending として適用する。
      await answerer.setRemoteDescription({ type: "offer", sdp: withNewPt });

      // Assert: pending 中は新 PT が加わるが既存 PT の解釈は変わらず、旧 RTP が届く。
      const pending = receiver.snapshotReceiveTables();
      expect(pending.codecs[120]?.mimeType).toBe("video/VP8");
      expect(pending.codecs[committedPt]).toEqual(baseline.codecs[committedPt]);
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "new-pt-pending");

      // Act: 双方の pending description を rollback する。
      await offerer.setLocalDescription({ type: "rollback" });
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: codec/RTX 対応表は baseline と完全に一致し、旧 RTP が届く。
      expect(receiver.snapshotReceiveTables()).toEqual(baseline);
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "new-pt-rollback");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("a re-offer that remaps a current payload type is rejected before mutation", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 受信側の対応表を控え、VP8 の PT を H264 に再割当てした offer を作る。
      const receiver = answerer.getTransceivers()[0].receiver;
      const baseline = receiver.snapshotReceiveTables();
      const current = answerer.currentRemoteDescription!.sdp;
      await offerer.setLocalDescription(await offerer.createOffer());
      const remapped = offerer.localDescription!.sdp.replace(
        /a=rtpmap:(\d+) VP8\/90000/,
        "a=rtpmap:$1 H264/90000",
      );

      // Act: PT を再割当てする remote offer を適用する (RFC 3264 8.3.2 違反)。
      await expect(
        answerer.setRemoteDescription({ type: "offer", sdp: remapped }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: signaling・current SDP・受信対応表は変わらず、旧 RTP が届く。
      expect(answerer.signalingState).toBe("stable");
      expect(answerer.currentRemoteDescription!.sdp).toBe(current);
      expect(receiver.snapshotReceiveTables()).toEqual(baseline);
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "remap-rejected");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("ICE restart pranswer connects a pending generation and rollback keeps current RTP", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 現行 pair と ICE generation を記録する。
      const oldOffererTransport = offerer.iceTransports[0];
      const oldAnswererTransport = answerer.iceTransports[0];
      const oldPair = oldOffererTransport.getSelectedCandidatePair();
      const oldDtls = offerer.dtlsTransports[0];
      const currentRemote = answerer.currentRemoteDescription!.sdp;

      // Act: restart offer と pranswer で新しい ICE generation の checks を進める。
      await offerer.setLocalDescription(
        await offerer.createOffer({ iceRestart: true }),
      );
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      await Promise.all([
        waitForProvisionalNomination(offerer),
        waitForProvisionalNomination(answerer),
      ]);

      // Assert: ICE restart は DTLS association を作り直さず、旧 pair で RTP が続く。
      expect(offerer.dtlsTransports).toEqual([oldDtls]);
      expect(oldOffererTransport.getSelectedCandidatePair()).toEqual(oldPair);
      await sendAndExpectRtp(
        outgoing,
        incoming,
        "pending-restart-before-rollback",
      );

      // Act: 双方の pending description を破棄する。
      await offerer.setLocalDescription({ type: "rollback" });
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: 旧 pair と SDP に戻り、RTP が実際に届く。
      expect(offerer.iceTransports[0]).toBe(oldOffererTransport);
      expect(answerer.iceTransports[0]).toBe(oldAnswererTransport);
      expect(oldOffererTransport.getSelectedCandidatePair()).toEqual(oldPair);
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
      await sendAndExpectRtp(
        outgoing,
        incoming,
        "pending-restart-after-rollback",
      );
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 10000);

  test.each(["answer", "rollback"] as const)(
    "ICE restart pranswer over a connected SCTP association checks the new generation, then %s",
    async (outcome) => {
      const { offerer, answerer, outgoing, incoming, channel, received } =
        await createConnectedMediaAndDataPeers();
      try {
        // Arrange: 現行 generation の selected pair と SCTP transport を控える。
        const offererIce = offerer.iceTransports[0];
        const answererIce = answerer.iceTransports[0];
        const offererPair = offererIce.connection.nominated;
        const answererPair = answererIce.connection.nominated;
        const sctpTransport = answerer.sctpTransport!.dtlsTransport;
        const currentRemote = answerer.currentRemoteDescription!.sdp;

        // Act: 確立済み SCTP を保つ restart offer に pranswer を返す。
        await offerer.setLocalDescription(
          await offerer.createOffer({ iceRestart: true }),
        );
        await answerer.setRemoteDescription(offerer.localDescription!);
        const answer = await answerer.createAnswer();
        await answerer.setLocalDescription({
          type: "pranswer",
          sdp: answer.sdp,
        });
        await offerer.setRemoteDescription({
          type: "pranswer",
          sdp: answerer.localDescription!.sdp,
        });
        const [offererConnection] = await waitForProvisionalNomination(offerer);
        const [answererConnection] =
          await waitForProvisionalNomination(answerer);

        // Assert: pending generation は pranswer の資格情報で nominate され、
        // current の pair・SDP・association はそのまま通信を続ける。
        const offerUfrag =
          offerer.localDescription!.sdp.match(/a=ice-ufrag:(\S+)/)![1];
        const answerUfrag =
          answerer.localDescription!.sdp.match(/a=ice-ufrag:(\S+)/)![1];
        expect(offererConnection.provisionalNominated).toBeDefined();
        expect(offererIce.connection.nominated).toBe(offererPair);
        expect(answererIce.connection.nominated).toBe(answererPair);
        expect(offererIce.connection.remoteUsername).not.toBe(answerUfrag);
        expect(answererIce.connection.remoteUsername).not.toBe(offerUfrag);
        expect(answererConnection.provisionalNominated).toBeDefined();
        expect(answerer.sctpTransport!.dtlsTransport).toBe(sctpTransport);
        expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
        await sendAndExpectRtp(
          outgoing,
          incoming,
          `sctp-restart-pranswer-${outcome}`,
        );
        await sendAndExpectData(channel, received, `dc-pranswer-${outcome}`);

        if (outcome === "answer") {
          // Act: final answer で pending generation を commit する。
          await answerer.setLocalDescription({
            type: "answer",
            sdp: answer.sdp,
          });
          await offerer.setRemoteDescription(answerer.localDescription!);
          await Promise.all([waitForIce(offerer), waitForIce(answerer)]);

          // Assert: 双方の live generation が SDP と一致し、SCTP は移動しない。
          expect(offererIce.getRemoteParameters()?.usernameFragment).toBe(
            answerUfrag,
          );
          expect(answererIce.getRemoteParameters()?.usernameFragment).toBe(
            offerUfrag,
          );
          expect(answererIce.localParameters.usernameFragment).toBe(
            answerUfrag,
          );
        } else {
          // Act: 双方の pending description を rollback する。
          await offerer.setLocalDescription({ type: "rollback" });
          await answerer.setRemoteDescription({ type: "rollback" });

          // Assert: provisional generation は破棄され、current pair が残る。
          expect(offererIce.connection.provisionalNominated).toBeUndefined();
          expect(answererIce.connection.provisionalNominated).toBeUndefined();
          expect(offererIce.connection.nominated).toBe(offererPair);
          expect(answererIce.connection.nominated).toBe(answererPair);
          expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
        }

        // Assert: commit/rollback 後も同じ association で RTP と DataChannel が届く。
        expect(answerer.sctpTransport!.dtlsTransport).toBe(sctpTransport);
        await sendAndExpectRtp(
          outgoing,
          incoming,
          `sctp-restart-after-${outcome}`,
        );
        await sendAndExpectData(channel, received, `dc-after-${outcome}`);
        await sendAndExpectData(received, channel, `dc-reverse-${outcome}`);
        assertNegotiationInvariants(offerer);
        assertNegotiationInvariants(answerer);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    15000,
  );

  test("a replacement offer that would move SCTP is rejected before retiring the pending offer", async () => {
    const { offerer, answerer, channel, received } =
      await createConnectedMediaAndDataPeers();
    try {
      // Arrange: 有効な re-offer を pending に置き、SCTP を BUNDLE から外す
      // replacement offer を用意する。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const pendingOffer = answerer.pendingRemoteDescription!.sdp;
      const sctpTransport = answerer.sctpTransport!.dtlsTransport;
      const replacement = offerer.localDescription!.sdp.replace(
        /a=group:BUNDLE [^\r\n]+\r\n/,
        "",
      );

      // Act: SCTP を別 DTLS transport に移す replacement offer を適用する。
      await expect(
        answerer.setRemoteDescription({ type: "offer", sdp: replacement }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: 先行 pending と SCTP binding は置換前のまま残る。
      expect(answerer.signalingState).toBe("have-remote-offer");
      expect(answerer.pendingRemoteDescription!.sdp).toBe(pendingOffer);
      expect(answerer.sctpTransport!.dtlsTransport).toBe(sctpTransport);

      // Act: 残った先行 pending をそのまま answer で commit する。
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: stable へ進み、既存 association で双方向に通信できる。
      expect(answerer.signalingState).toBe("stable");
      expect(answerer.currentRemoteDescription!.sdp).toBe(pendingOffer);
      await sendAndExpectData(channel, received, "after-rejected-replacement");
      await sendAndExpectData(received, channel, "reverse-after-replacement");
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("rollback removes remote-only objects and a repeated offer does not duplicate events", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const onTrack = vi.fn();
    const onRemoteTransceiver = vi.fn();
    answerer.onTrack.subscribe(onTrack);
    answerer.onRemoteTransceiverAdded.subscribe(onRemoteTransceiver);

    try {
      // Arrange: remote offer が初回の transceiver を生成する。
      offerer.addTransceiver("audio");
      const offer = await offerer.createOffer();

      // Act: 同じ offer を再適用してから rollback する。
      await answerer.setRemoteDescription(offer);
      assertNegotiationInvariants(answerer);
      await answerer.setRemoteDescription(offer);

      // Assert: 同じ receiver と transceiver への通知は一度だけ。
      expect(onRemoteTransceiver).toHaveBeenCalledTimes(1);
      expect(onTrack).toHaveBeenCalledTimes(1);
      const oldTransceiver = answerer.getTransceivers()[0];
      await answerer.setRemoteDescription({ type: "rollback" });
      assertNegotiationInvariants(answerer);
      expect(answerer.getTransceivers()).toHaveLength(0);
      expect(oldTransceiver.stopped).toBe(true);

      // Act: rollback 後の新しい offer は新しい object を作る。
      await answerer.setRemoteDescription(offer);

      // Assert: 新しい receiver 遷移に対する通知だけが追加される。
      expect(onRemoteTransceiver).toHaveBeenCalledTimes(2);
      expect(onTrack).toHaveBeenCalledTimes(2);
      expect(answerer.getTransceivers()[0]).not.toBe(oldTransceiver);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("rollback keeps a remote-created transceiver that received a local track", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const localTrack = new MediaStreamTrack({ kind: "audio" });
    try {
      // Arrange: remote offer で作成された transceiver に application が送信 track を付ける。
      offerer.addTransceiver("audio", { direction: "sendonly" });
      await answerer.setRemoteDescription(await offerer.createOffer());
      const transceiver = answerer.getTransceivers()[0];
      answerer.addTrack(localTrack);

      // Act: remote offer を取り消す。
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: application 所有の sender/track は残り、旧 m-line との関連だけ外れる。
      assertNegotiationInvariants(answerer);
      expect(answerer.getTransceivers()).toContain(transceiver);
      expect(transceiver.sender.track).toBe(localTrack);
      expect(transceiver.mid).toBeNull();
      expect(transceiver.mLineIndex).toBeUndefined();
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("rollback removes provisional receiver SSRC mappings on an existing track", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 既存 m-line に別 SSRC を提案する re-offer を作る。
      const receiver = answerer.getTransceivers()[0].receiver;
      const originalTracks = [...receiver.tracks];
      const originalSsrc = offerer.getTransceivers()[0].sender.ssrc;
      const provisionalSsrc = originalSsrc + 1;
      const offer = await offerer.createOffer();
      const changedSsrcOffer = {
        type: "offer" as const,
        sdp: offer.sdp.replaceAll(
          originalSsrc.toString(),
          provisionalSsrc.toString(),
        ),
      };

      // Act: 追加 SSRC を一時登録してから offer を取り消す。
      await answerer.setRemoteDescription(changedSsrcOffer);
      expect(receiver.trackBySSRC[provisionalSsrc]).toBeDefined();
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: receiver の object は維持し、追加 track と SSRC 経路を除去する。
      assertNegotiationInvariants(answerer);
      expect(receiver.tracks).toEqual(originalTracks);
      expect(receiver.trackBySSRC[provisionalSsrc]).toBeUndefined();
      await sendAndExpectRtp(outgoing, incoming, "old-ssrc-after-rollback");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("remote ICE restart offer and pending trickle leave the current RTP path alive through rollback", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: committed ICE credentials と候補 pair を記録する。
      const transport = answerer.iceTransports[0];
      const oldUfrag = transport.getRemoteParameters()!.usernameFragment;
      const oldPair = transport.getSelectedCandidatePair();
      const currentRemote = answerer.currentRemoteDescription!.sdp;
      await sendAndExpectRtp(outgoing, incoming, "before-pending");
      const offer = await offerer.createOffer();
      const newUfrag = "newgeneration123";
      const newPassword = "newgenerationpassword123456";
      const restartOffer = {
        type: "offer" as const,
        sdp: offer.sdp
          .replaceAll(`a=ice-ufrag:${oldUfrag}`, `a=ice-ufrag:${newUfrag}`)
          .replace(/a=ice-pwd:[^\r\n]+/g, `a=ice-pwd:${newPassword}`),
      };

      // Act: restart proposal とその generation の trickle を pending に置く。
      await answerer.setRemoteDescription(restartOffer);
      assertNegotiationInvariants(answerer);
      await answerer.addIceCandidate({
        candidate:
          "candidate:pending 1 udp 2113937151 192.0.2.10 12345 typ host",
        sdpMid:
          answerer.pendingRemoteDescription!.sdp.match(/a=mid:([^\r\n]+)/)![1],
        usernameFragment: newUfrag,
      });
      await sendAndExpectRtp(outgoing, incoming, "during-pending");

      // Assert: current ICE pair と RTP は pending 中も保持される。
      expect(transport.getRemoteParameters()!.usernameFragment).toBe(oldUfrag);
      expect(transport.getSelectedCandidatePair()).toEqual(oldPair);
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);

      // Act: pranswer を一時適用しても旧 pair を使い、restart proposal を取り消す。
      const provisional = await answerer.createAnswer();
      await answerer.setLocalDescription({
        type: "pranswer",
        sdp: provisional.sdp,
      });
      expect(transport.getSelectedCandidatePair()).toEqual(oldPair);
      await sendAndExpectRtp(outgoing, incoming, "restart-pranswer-rollback");
      await answerer.setRemoteDescription({ type: "rollback" });
      await sendAndExpectRtp(outgoing, incoming, "after-rollback");

      // Assert: pending の候補は current SDP に移らず、旧 pair が続く。
      assertNegotiationInvariants(answerer);
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
      expect(transport.getSelectedCandidatePair()).toEqual(oldPair);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("validation failure leaves the current descriptions and SCTP association unchanged", async () => {
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      // Arrange: current descriptions と transport identity を控える。
      const remote = answerer.currentRemoteDescription!.sdp;
      const transport = answerer.dtlsTransports[0];
      const offer = await offerer.createOffer();
      const invalid = offer.sdp
        .replace(/a=mid:([^\r\n]+)/, "a=mid:wrong")
        .replace(/a=group:BUNDLE [^\r\n]+/, "a=group:BUNDLE wrong");

      // Act: 既存 m-line の MID を変えた offer を適用する。
      await expect(
        answerer.setRemoteDescription({ type: "offer", sdp: invalid }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: SDP、transport、signaling は最後の stable のまま。
      assertNegotiationInvariants(answerer);
      expect(answerer.currentRemoteDescription!.sdp).toBe(remote);
      expect(answerer.dtlsTransports[0]).toBe(transport);
      expect(answerer.signalingState).toBe("stable");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("setLocalDescription accepts only the last created offer", async () => {
    const peer = new RTCPeerConnection();
    try {
      // Arrange: offer を 2 回作り、1 回目の offer と書き換えた最新 offer を用意する。
      peer.addTransceiver("audio");
      const older = await peer.createOffer();
      const latest = await peer.createOffer();
      const rejected = [
        older,
        {
          type: "offer" as const,
          sdp: latest.sdp.replace("a=sendrecv", "a=recvonly"),
        },
        {
          type: "offer" as const,
          sdp: latest.sdp.replace(
            /a=ice-ufrag:[^\r\n]+/,
            "a=ice-ufrag:wronggeneration",
          ),
        },
      ];
      expect(older.sdp).not.toBe(latest.sdp);

      for (const offer of rejected) {
        // Act: 最新ではない / 書き換えた local offer を適用する。
        const result = peer.setLocalDescription(offer);

        // Assert: W3C どおり InvalidModificationError で拒否し、状態は変えない。
        await expect(result).rejects.toMatchObject({
          name: "InvalidModificationError",
        });
        expect(peer.signalingState).toBe("stable");
        expect(peer.pendingLocalDescription).toBeNull();
        assertNegotiationInvariants(peer);
      }

      // Act: 最新の offer を適用する。
      await peer.setLocalDescription(latest);

      // Assert: 最新 offer だけが pending になる。
      expect(peer.signalingState).toBe("have-local-offer");
      expect(peer.pendingLocalDescription!.sdp).toContain("a=sendrecv");
    } finally {
      await peer.close();
    }
  });

  test.each([
    ["a peer that never created an offer", false],
    ["a connected peer whose own offers were already applied", true],
  ])(
    "an offer created by another peer is rejected by %s",
    async (_, connected) => {
      const peers = connected
        ? await createConnectedVideoPeers()
        : createUnnegotiatedVideoPeers();
      const { offerer, answerer } = peers;
      try {
        // Arrange: offer を作る側と、それを自分の offer として渡される側を用意する。
        if (connected) {
          // Arrange: answerer 自身も一度 offer を作って適用し、交渉を完了させておく。
          await answerer.setLocalDescription(await answerer.createOffer());
          await offerer.setRemoteDescription(answerer.localDescription!);
          await offerer.setLocalDescription(await offerer.createAnswer());
          await answerer.setRemoteDescription(offerer.localDescription!);
        }
        const foreignOffer = await offerer.createOffer();
        const state = answerer.signalingState;
        const current = answerer.currentLocalDescription?.sdp;
        const phase =
          negotiationInternals(answerer).negotiation.inspect().phase;

        // Act: 他の peer が作った offer を setLocalDescription に渡す。
        await expect(
          answerer.setLocalDescription(foreignOffer),
        ).rejects.toMatchObject({ name: "InvalidModificationError" });

        // Assert: signaling state・pending/current description・transaction は変わらない。
        expect(answerer.signalingState).toBe(state);
        expect(answerer.pendingLocalDescription).toBeNull();
        expect(answerer.currentLocalDescription?.sdp).toBe(current);
        expect(negotiationInternals(answerer).negotiation.inspect().phase).toBe(
          phase,
        );
        assertNegotiationInvariants(answerer);

        // Act: 自分で作った offer なら適用できる。
        await answerer.setLocalDescription(await answerer.createOffer());

        // Assert: 自身の offer で have-local-offer に進む。
        expect(answerer.signalingState).toBe("have-local-offer");
        assertNegotiationInvariants(answerer);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
  );

  test("an unsupported offered codec rejects only its m-line", async () => {
    const offerer = new RTCPeerConnection({
      codecs: {
        audio: [
          new RTCRtpCodecParameters({
            mimeType: "audio/PCMU",
            clockRate: 8000,
            channels: 1,
          }),
        ],
      },
    });
    const answerer = new RTCPeerConnection({
      codecs: {
        audio: [
          new RTCRtpCodecParameters({
            mimeType: "audio/opus",
            clockRate: 48000,
            channels: 2,
          }),
        ],
      },
    });
    const onTrack = vi.fn();
    answerer.onTrack.subscribe(onTrack);
    try {
      // Arrange: codec の共通集合がない audio offer を作る。
      offerer.addTransceiver("audio");
      await offerer.setLocalDescription(await offerer.createOffer());

      // Act: remote offer を受け、answer を適用する。
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();
      await answerer.setLocalDescription(answer);

      // Assert: m-line 単位で拒否し、track event を送らない。
      expect(answerer.currentLocalDescription!.sdp).toMatch(/m=audio 0 /);
      expect(onTrack).not.toHaveBeenCalled();
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("replacement offer discards earlier pending trickle while keeping the baseline", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: stable の remote SDP と candidate 数を控える。
      const current = answerer.currentRemoteDescription!.sdp;
      const offerA = await offerer.createOffer();
      const ufragA = offerA.sdp.match(/a=ice-ufrag:([^\r\n]+)/)![1];
      const mid = offerA.sdp.match(/a=mid:([^\r\n]+)/)![1];
      const offerB = {
        type: "offer" as const,
        sdp: offerA.sdp.replaceAll(
          `a=ice-ufrag:${ufragA}`,
          "a=ice-ufrag:replacement123",
        ),
      };

      // Act: A に candidate を積み、B で置換する。
      await answerer.setRemoteDescription(offerA);
      await answerer.addIceCandidate({
        candidate:
          "candidate:oldpending 1 udp 2113937151 192.0.2.12 12347 typ host",
        sdpMid: mid,
        usernameFragment: ufragA,
      });
      await answerer.setRemoteDescription(offerB);
      await sendAndExpectRtp(outgoing, incoming, "replacement");

      // Assert: 古い pending candidate と revision は current に漏れない。
      expect(answerer.pendingRemoteDescription!.sdp).not.toContain(
        "oldpending",
      );
      expect(answerer.currentRemoteDescription!.sdp).toBe(current);
      assertNegotiationInvariants(answerer);
      await answerer.setRemoteDescription({ type: "rollback" });
      assertNegotiationInvariants(answerer);
      expect(answerer.currentRemoteDescription!.sdp).toBe(current);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("initial pranswer starts provisional DataChannel traffic and rollback closes it", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const localChannel = offerer.createDataChannel("provisional");
    let remoteChannel: typeof localChannel | undefined;
    answerer.onDataChannel.subscribe((channel) => {
      remoteChannel = channel;
    });
    try {
      // Arrange: application m-line を持つ初回 offer を適用する。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();

      // Act: final answer を待たずに pranswer で接続する。
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      if (localChannel.readyState !== "open") {
        await localChannel.stateChanged.watch((state) => state === "open");
      }

      // Assert: stable/current は空のままで provisional channel が公開される。
      expect(localChannel.readyState).toBe("open");
      expect(remoteChannel?.label).toBe("provisional");
      expect(offerer.currentRemoteDescription).toBeNull();
      expect(answerer.currentLocalDescription).toBeNull();

      // Act: provisional negotiation を rollback する。
      await offerer.setLocalDescription({ type: "rollback" });
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: current は空で pending-only association の channel は閉じる。
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      expect(localChannel.readyState).toBe("closed");
      expect(offerer.currentLocalDescription).toBeNull();
      const answerUfrag = answer.sdp.match(/^a=ice-ufrag:(.*?)\r?$/m)![1];
      expect(offerer.iceTransports[0].connection.remoteUsername).not.toBe(
        answerUfrag,
      );
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("initial pranswer carries provisional RTP before final commit", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const outgoing = new MediaStreamTrack({ kind: "video" });
    let incoming: MediaStreamTrack | undefined;
    answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
      transceiver.onTrack.subscribe((track) => {
        incoming = track;
      });
    });
    try {
      // Arrange: video の初回 offer を受け、receiver を pending に生成する。
      offerer.addTransceiver(outgoing, { direction: "sendonly" });
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();

      // Act: 双方の pranswer だけで ICE/DTLS と RTP を開始する。
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      expect(incoming).toBeDefined();
      await sendAndExpectRtp(outgoing, incoming!, "provisional-rtp");

      // Act / Assert: 接続済み provisional DTLS の証明書差替えは拒否する。
      await expect(
        offerer.setRemoteDescription({
          type: "answer",
          sdp: answer.sdp.replace(
            /a=fingerprint:sha-256 [^\r\n]+/,
            `a=fingerprint:sha-256 ${Array(32).fill("00").join(":")}`,
          ),
        }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: current description は空のまま通信し、rollback で仮 transceiver を除外する。
      expect(answerer.currentRemoteDescription).toBeNull();
      expect(offerer.currentLocalDescription).toBeNull();
      await offerer.setLocalDescription({ type: "rollback" });
      await answerer.setRemoteDescription({ type: "rollback" });
      assertNegotiationInvariants(answerer);
      expect(answerer.getTransceivers()).toHaveLength(0);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("re-offer pranswer carries new RTP alongside the committed stream", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    const provisionalAudio = new MediaStreamTrack({ kind: "audio" });
    let receivedAudio: MediaStreamTrack | undefined;
    answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
      if (transceiver.kind === "audio") {
        transceiver.onTrack.subscribe((track) => {
          receivedAudio = track;
        });
      }
    });
    try {
      // Arrange: 接続済み video に新しい audio m-line を加える。
      const currentRemote = answerer.currentRemoteDescription!.sdp;
      const selectedPair = answerer.iceTransports[0].getSelectedCandidatePair();
      offerer.addTransceiver(provisionalAudio, { direction: "sendonly" });
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();

      // Act: pranswer 中に新 audio と旧 video の RTP を両方送る。
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      expect(receivedAudio).toBeDefined();
      await sendAndExpectRtp(provisionalAudio, receivedAudio!, "pending-audio");
      await sendAndExpectRtp(outgoing, incoming, "current-video");

      // Assert: current の SDP と ICE pair は pranswer では入れ替わらない。
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
      expect(answerer.iceTransports[0].getSelectedCandidatePair()).toEqual(
        selectedPair,
      );

      // Act: rollback で新 audio を外し、旧 video は送り続ける。
      await offerer.setLocalDescription({ type: "rollback" });
      await answerer.setRemoteDescription({ type: "rollback" });
      await sendAndExpectRtp(outgoing, incoming, "post-pranswer-video");

      // Assert: 接続中の current 経路と description が維持される。
      assertNegotiationInvariants(answerer);
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
      expect(answerer.iceTransports[0].getSelectedCandidatePair()).toEqual(
        selectedPair,
      );
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("a final answer can replace provisional SCTP limits without another channel event", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const channel = offerer.createDataChannel("limits");
    const onDataChannel = vi.fn();
    answerer.onDataChannel.subscribe(onDataChannel);
    try {
      // Arrange: application offer と provisional answer を作る。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();
      const provisionalSdp = answer.sdp.replace(
        /a=max-message-size:[^\r\n]+/,
        "a=max-message-size:4096",
      );
      await answerer.setLocalDescription({
        type: "pranswer",
        sdp: provisionalSdp,
      });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      if (channel.readyState !== "open") {
        await channel.stateChanged.watch((state) => state === "open");
      }

      // Act: provisional answer を置換しても既存 channel object を再通知しない。
      const replacementSdp = answer.sdp.replace(
        /a=max-message-size:[^\r\n]+/,
        "a=max-message-size:3072",
      );
      await answerer.setLocalDescription({
        type: "pranswer",
        sdp: replacementSdp,
      });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      expect(offerer.currentRemoteDescription).toBeNull();
      expect(channel.readyState).toBe("open");

      // Act: 最終 answer では別の max-message-size を採用する。
      const finalSdp = answer.sdp.replace(
        /a=max-message-size:[^\r\n]+/,
        "a=max-message-size:2048",
      );
      await answerer.setLocalDescription({ type: "answer", sdp: finalSdp });
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: final SDP と association の上限が一致し、channel は再通知されない。
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      expect(offerer.sctpTransport!.remoteMaxMessageSize).toBe(2048);
      expect(channel.readyState).toBe("open");
      expect(onDataChannel).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("duplicate trickle candidate and EOC are idempotent within one generation", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    try {
      // Arrange: gathered candidate と EOC を含む offer を適用する。
      offerer.addTransceiver("audio");
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const sdp = answerer.remoteDescription!.sdp;
      const candidate = sdp.match(/a=(candidate:[^\r\n]+)/)![1];
      const mid = sdp.match(/a=mid:([^\r\n]+)/)![1];
      const ufrag = sdp.match(/a=ice-ufrag:([^\r\n]+)/)![1];
      const beforeCount =
        answerer.iceTransports[0].getRemoteCandidates().length;

      // Act: 同じ candidate と EOC を二度ずつ trickle する。
      await answerer.addIceCandidate({
        candidate,
        sdpMid: mid,
        usernameFragment: ufrag,
      });
      await answerer.addIceCandidate({
        candidate,
        sdpMid: mid,
        usernameFragment: ufrag,
      });
      await answerer.addIceCandidate({
        candidate: "",
        sdpMid: mid,
        usernameFragment: ufrag,
      });
      await answerer.addIceCandidate({
        candidate: "",
        sdpMid: mid,
        usernameFragment: ufrag,
      });

      // Assert: description と ICE checklist に重複しない。
      expect(answerer.remoteDescription!.sdp).toBe(sdp);
      expect(answerer.iceTransports[0].getRemoteCandidates()).toHaveLength(
        beforeCount,
      );
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("both peers commit matching local and remote ICE restart generations", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: current nomination と generation を控える。
      const oldGeneration = offerer.iceGeneration;
      const oldPair = offerer.iceTransports[0].getSelectedCandidatePair();
      const oldDtls = offerer.dtlsTransports[0];

      // Act: local restart offer は pending に置き、旧 nomination を維持する。
      const offer = await offerer.createOffer({ iceRestart: true });
      const offeredUfrag = offer.sdp.match(/a=ice-ufrag:([^\r\n]+)/)![1];
      expect(offerer.iceGeneration).toBe(oldGeneration);
      await offerer.setLocalDescription(offer);
      expect(offerer.iceTransports[0].getSelectedCandidatePair()).toEqual(
        oldPair,
      );
      await sendAndExpectRtp(outgoing, incoming, "restart-pending");

      // Act: remote peer も新 generation を answer し、双方で確定する。
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();
      const answeredUfrag = answer.sdp.match(/a=ice-ufrag:([^\r\n]+)/)![1];
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      // Assert: pranswer だけで新しい ICE generation が provisional に nominate される。
      await Promise.all([
        waitForProvisionalNomination(offerer),
        waitForProvisionalNomination(answerer),
      ]);

      // Assert: pranswer 中は旧 nomination で RTP が続き、current は旧 SDP のまま。
      expect(offerer.iceTransports[0].getSelectedCandidatePair()).toEqual(
        oldPair,
      );
      expect(offerer.iceGeneration).toBe(oldGeneration);
      await sendAndExpectRtp(outgoing, incoming, "restart-pranswer");

      // Act: 最終 answer で新 generation へ切り替える。
      await answerer.setLocalDescription({ type: "answer", sdp: answer.sdp });
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForIce(offerer),
        waitForIce(answerer),
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);

      // Assert: answer SDP、transport credentials と新 nomination が一致し、
      // DTLS association は restart 前のものを使い続ける。
      expect(offerer.dtlsTransports).toEqual([oldDtls]);
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      expect(offerer.iceGeneration).toBeGreaterThan(oldGeneration);
      expect(offerer.iceTransports[0].localParameters.usernameFragment).toBe(
        offeredUfrag,
      );
      expect(answerer.iceTransports[0].localParameters.usernameFragment).toBe(
        answeredUfrag,
      );
      expect(
        offerer.iceTransports[0].getSelectedCandidatePair(),
      ).not.toBeNull();
      await sendAndExpectRtp(outgoing, incoming, "restart-committed");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("local ICE restart rollback retains the committed selected pair", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: live ICE generation と選択済み pair を控える。
      const transport = offerer.iceTransports[0];
      const ufrag = transport.localParameters.usernameFragment;
      const pair = transport.getSelectedCandidatePair();
      const generation = offerer.iceGeneration;
      const candidateEvents: Array<string | undefined> = [];
      offerer.onIceCandidate.subscribe((candidate) => {
        candidateEvents.push(candidate?.toJSON().usernameFragment);
      });

      // Act: restart offer を pending にしてから rollback する。
      const restartOffer = await offerer.createOffer({ iceRestart: true });
      await offerer.setLocalDescription(restartOffer);
      const emitted = candidateEvents.length;
      await offerer.setLocalDescription(restartOffer);
      await sendAndExpectRtp(outgoing, incoming, "local-restart-pending");
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: current generation と実通信経路が変わらない。
      assertNegotiationInvariants(offerer);
      expect(emitted).toBeGreaterThan(1);
      expect(candidateEvents).toHaveLength(emitted);
      expect(candidateEvents.at(-1)).toBeUndefined();
      expect(transport.localParameters.usernameFragment).toBe(ufrag);
      expect(transport.getSelectedCandidatePair()).toEqual(pair);
      expect(offerer.iceGeneration).toBe(generation);
      await sendAndExpectRtp(outgoing, incoming, "local-restart-rollback");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("partial BUNDLE keeps an unbundled media transport independent", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const video = new MediaStreamTrack({ kind: "video" });
    let receivedVideo: MediaStreamTrack | undefined;
    answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
      if (transceiver.kind === "video") {
        transceiver.onTrack.subscribe((track) => {
          receivedVideo = track;
        });
      }
    });
    try {
      // Arrange: audio/application は BUNDLE、video は独立する offer を作る。
      offerer.addTransceiver("audio");
      offerer.addTransceiver(video, { direction: "sendonly" });
      offerer.createDataChannel("bundle");
      await offerer.setLocalDescription(await offerer.createOffer());
      const mids = [
        ...offerer.localDescription!.sdp.matchAll(/a=mid:([^\r\n]+)/g),
      ].map((match) => match[1]);
      const partialOffer = {
        type: "offer" as const,
        sdp: offerer.localDescription!.sdp.replace(
          /a=group:BUNDLE [^\r\n]+/,
          `a=group:BUNDLE ${mids[0]} ${mids[2]}`,
        ),
      };

      // Act: 部分 BUNDLE offer を適用して answer を作る。
      await answerer.setRemoteDescription(partialOffer);
      const answer = await answerer.createAnswer();

      // Assert: BUNDLE owner と独立 media の ICE/DTLS transport が分かれる。
      const [audio, remoteVideo] = answerer.getTransceivers();
      expect(answer.sdp).toContain(`a=group:BUNDLE ${mids[0]} ${mids[2]}`);
      expect(audio.dtlsTransport).toBe(answerer.sctpTransport!.dtlsTransport);
      expect(remoteVideo.dtlsTransport).not.toBe(audio.dtlsTransport);

      // Act: final answer 後に video RTP を独立 transport で送る。
      await answerer.setLocalDescription(answer);
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForIce(offerer),
        waitForIce(answerer),
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      expect(receivedVideo).toBeDefined();
      await sendAndExpectRtp(video, receivedVideo!, "unbundled-video");

      // Act / Assert: 接続済み SCTP を別 DTLS owner へ移す answer / offer は適用前に拒否する。
      await offerer.setLocalDescription(
        await createRewrittenOffer(offerer, (sdp) =>
          sdp.replace(
            /a=group:BUNDLE [^\r\n]+/,
            `a=group:BUNDLE ${mids[1]} ${mids[0]} ${mids[2]}`,
          ),
        ),
      );
      const incompatibleAnswer = offerer.currentRemoteDescription!.sdp.replace(
        /a=group:BUNDLE [^\r\n]+/,
        `a=group:BUNDLE ${mids[1]} ${mids[0]} ${mids[2]}`,
      );
      await expect(
        offerer.setRemoteDescription({
          type: "answer",
          sdp: incompatibleAnswer,
        }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });
      // 受信側は offer の validate で拒否し、stable の current を保つ。
      await expect(
        answerer.setRemoteDescription(offerer.localDescription!),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });
      expect(answerer.signalingState).toBe("stable");
      await offerer.setLocalDescription({ type: "rollback" });
      await sendAndExpectRtp(video, receivedVideo!, "tag-change-rejected");

      // Act: 次の offer で全 m-line を BUNDLE に戻す。
      const oldVideoTransport = remoteVideo.dtlsTransport;
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const mergedAnswer = await answerer.createAnswer();
      expect(remoteVideo.dtlsTransport).toBe(oldVideoTransport);
      await sendAndExpectRtp(video, receivedVideo!, "merge-pending-video");
      await answerer.setLocalDescription(mergedAnswer);
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: 旧 video owner は解放され、共有 transport で RTP が届く。
      assertNegotiationInvariants(answerer);
      expect(remoteVideo.dtlsTransport).toBe(audio.dtlsTransport);
      expect(oldVideoTransport.state).toBe("closed");
      await sendAndExpectRtp(video, receivedVideo!, "merged-video");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("re-offer BUNDLE split stages a new owner and rollback discards it", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 接続中の video に audio を追加し、audio を BUNDLE 外にする。
      const currentTransport = answerer.getTransceivers()[0].dtlsTransport;
      const currentRemote = answerer.currentRemoteDescription!.sdp;
      offerer.addTransceiver("audio", { direction: "sendonly" });
      const offer = await offerer.createOffer();
      const mids = [...offer.sdp.matchAll(/a=mid:([^\r\n]+)/g)].map(
        (match) => match[1],
      );
      const splitOffer = {
        type: "offer" as const,
        sdp: offer.sdp.replace(
          /a=group:BUNDLE [^\r\n]+/,
          `a=group:BUNDLE ${mids[0]}`,
        ),
      };

      // Act: 新 owner の候補を answer に準備し、現在の video を使い続ける。
      await answerer.setRemoteDescription(splitOffer);
      const firstAnswer = await answerer.createAnswer();
      const pendingTransportCount = answerer.dtlsTransports.length;
      await sendAndExpectRtp(outgoing, incoming, "split-pending");

      // Assert: pending transport は live binding にまだ現れず、SDP だけが別 ICE generation を持つ。
      expect(pendingTransportCount).toBe(1);
      expect(answerer.getTransceivers()[1].dtlsTransport).toBe(
        currentTransport,
      );
      expect(
        [...firstAnswer.sdp.matchAll(/a=ice-ufrag:([^\r\n]+)/g)].map(
          (match) => match[1],
        ),
      ).toHaveLength(2);
      expect(
        new Set(
          [...firstAnswer.sdp.matchAll(/a=ice-ufrag:([^\r\n]+)/g)].map(
            (match) => match[1],
          ),
        ).size,
      ).toBe(2);

      // Act: rollback で pending owner を破棄し、同じ proposal を再交渉して確定する。
      await answerer.setRemoteDescription({ type: "rollback" });
      expect(answerer.dtlsTransports).toHaveLength(1);
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
      await sendAndExpectRtp(outgoing, incoming, "split-rollback");
      await answerer.setRemoteDescription(splitOffer);
      const answer = await answerer.createAnswer();
      const candidateEvents: Array<
        Parameters<Parameters<typeof answerer.onIceCandidate.subscribe>[0]>[0]
      > = [];
      answerer.onIceCandidate.subscribe((candidate) => {
        candidateEvents.push(candidate);
      });
      await answerer.setLocalDescription(answer);

      // Assert: video の経路を保ち、audio owner の candidate/EOC を一度通知する。
      assertNegotiationInvariants(answerer);
      expect(answerer.getTransceivers()[0].dtlsTransport).toBe(
        currentTransport,
      );
      expect(answerer.getTransceivers()[1].dtlsTransport).not.toBe(
        currentTransport,
      );
      expect(
        candidateEvents.some((candidate) => candidate?.sdpMid === mids[1]),
      ).toBe(true);
      expect(candidateEvents.at(-1)).toBeUndefined();
      await sendAndExpectRtp(outgoing, incoming, "split-committed");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("a local BUNDLE split prepares independent ICE and carries both RTP streams", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    const audio = new MediaStreamTrack({ kind: "audio" });
    let receivedAudio: MediaStreamTrack | undefined;
    answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
      if (transceiver.kind === "audio") {
        transceiver.onTrack.subscribe((track) => {
          receivedAudio = track;
        });
      }
    });
    try {
      // Arrange: 接続済み BUNDLE transport に audio を追加し、group を分割する。
      const currentLocal = offerer.currentLocalDescription!.sdp;
      const selectedPair = offerer.iceTransports[0].getSelectedCandidatePair();
      offerer.addTransceiver(audio, { direction: "sendonly" });
      let videoMid = "";
      const { sdp: splitSdp } = await createRewrittenOffer(offerer, (sdp) => {
        videoMid = sdp.match(/a=mid:([^\r\n]+)/)![1];
        return sdp.replace(
          /a=group:BUNDLE [^\r\n]+/,
          `a=group:BUNDLE ${videoMid}`,
        );
      });

      // Act: 新 audio の ICE transport を pending に準備し、旧 video は継続する。
      await offerer.setLocalDescription({ type: "offer", sdp: splitSdp });
      expect(offerer.currentLocalDescription!.sdp).toBe(currentLocal);
      expect(offerer.iceTransports[0].getSelectedCandidatePair()).toEqual(
        selectedPair,
      );
      expect(offerer.dtlsTransports).toHaveLength(1);
      await sendAndExpectRtp(outgoing, incoming, "local-split-pending");

      // Act: remote answer で新 transport へ audio を結び付ける。
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      const audioTransport = offerer.getTransceivers()[1].dtlsTransport;
      if (audioTransport.state !== "connected") {
        await Promise.race([
          audioTransport.onStateChange.watch((state) => state === "connected"),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("split audio transport did not connect")),
              3000,
            ),
          ),
        ]);
      }

      // Assert: video の旧 pair を維持し、独立 audio と video の RTP が届く。
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      expect(audioTransport).not.toBe(
        offerer.getTransceivers()[0].dtlsTransport,
      );
      expect(receivedAudio).toBeDefined();
      await sendAndExpectRtp(audio, receivedAudio!, "split-audio");
      await sendAndExpectRtp(outgoing, incoming, "split-video");

      // Act: 次の offer で audio を新 BUNDLE tag にして video を合流させる。
      const oldVideoTransport = offerer.getTransceivers()[0].dtlsTransport;
      const audioMid = offerer.getTransceivers()[1].mid;
      await offerer.setLocalDescription(
        await createRewrittenOffer(offerer, (sdp) =>
          sdp.replace(
            /a=group:BUNDLE [^\r\n]+/,
            `a=group:BUNDLE ${audioMid} ${videoMid}`,
          ),
        ),
      );
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: tag 変更後は audio owner を共有し、両方の RTP が届く。
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      expect(offerer.getTransceivers()[0].dtlsTransport).toBe(audioTransport);
      expect(oldVideoTransport.state).toBe("closed");
      await sendAndExpectRtp(audio, receivedAudio!, "tagged-audio");
      await sendAndExpectRtp(outgoing, incoming, "tagged-video");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("rollback of a local BUNDLE split keeps the old RTP owner", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 新 audio を非 BUNDLE にした local re-offer を作る。
      const oldTransport = offerer.getTransceivers()[0].dtlsTransport;
      const oldPair = oldTransport.iceTransport.getSelectedCandidatePair();
      const audio = new MediaStreamTrack({ kind: "audio" });
      const localAudio = offerer.addTransceiver(audio, {
        direction: "sendonly",
      });
      let videoMid = "";
      const splitOffer = await createRewrittenOffer(offerer, (sdp) => {
        videoMid = sdp.match(/a=mid:([^\r\n]+)/)![1];
        return sdp.replace(
          /a=group:BUNDLE [^\r\n]+/,
          `a=group:BUNDLE ${videoMid}`,
        );
      });

      // Act: pending owner を用意してから rollback する。
      await offerer.setLocalDescription(splitOffer);
      expect(offerer.pendingLocalDescription!.sdp).toContain(
        `a=group:BUNDLE ${videoMid}`,
      );
      await sendAndExpectRtp(outgoing, incoming, "local-split-before-rollback");
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: pending transport は消え、application の audio object と旧 pair は残る。
      assertNegotiationInvariants(offerer);
      expect(offerer.dtlsTransports).toHaveLength(1);
      expect(offerer.getTransceivers()).toContain(localAudio);
      expect(localAudio.sender.track).toBe(audio);
      expect(oldTransport.iceTransport.getSelectedCandidatePair()).toEqual(
        oldPair,
      );
      await sendAndExpectRtp(outgoing, incoming, "local-split-after-rollback");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("a connected DTLS fingerprint change fails before touching current RTP", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: re-offer の fingerprint だけを別証明書の値に変える。
      const current = answerer.currentRemoteDescription!.sdp;
      const pair = answerer.iceTransports[0].getSelectedCandidatePair();
      const offer = await offerer.createOffer();
      const altered = offer.sdp.replace(
        /a=fingerprint:sha-256 [^\r\n]+/,
        `a=fingerprint:sha-256 ${Array(32).fill("00").join(":")}`,
      );

      // Act: 接続済み DTLS の fingerprint 変更を適用しようとする。
      await expect(
        answerer.setRemoteDescription({ type: "offer", sdp: altered }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: current SDP、ICE pair と RTP は維持される。
      assertNegotiationInvariants(answerer);
      expect(answerer.currentRemoteDescription!.sdp).toBe(current);
      expect(answerer.iceTransports[0].getSelectedCandidatePair()).toEqual(
        pair,
      );
      await sendAndExpectRtp(outgoing, incoming, "fingerprint-rejected");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("an existing SCTP port change is rejected before mutating the association", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const channel = offerer.createDataChannel("port-check");
    let remoteChannel: typeof channel | undefined;
    answerer.onDataChannel.subscribe((received) => {
      remoteChannel = received;
    });
    try {
      // Arrange: DataChannel が開いた stable session を作る。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      if (channel.readyState !== "open") {
        await channel.stateChanged.watch((state) => state === "open");
      }
      const oldPort = answerer.sctpRemotePort;
      const current = answerer.currentRemoteDescription!.sdp;
      const offer = await offerer.createOffer();

      // Act: 同じ association の remote SCTP port を変更する re-offer を拒否する。
      await expect(
        answerer.setRemoteDescription({
          type: "offer",
          sdp: offer.sdp.replace("a=sctp-port:5000", "a=sctp-port:5001"),
        }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: SDP と port は current のままで DataChannel 通信も続く。
      expect(answerer.currentRemoteDescription!.sdp).toBe(current);
      expect(answerer.sctpRemotePort).toBe(oldPort);
      expect(remoteChannel).toBeDefined();
      const message = remoteChannel!.onMessage.watch(
        (data) => data.toString() === "after-reject",
      );
      channel.send(Buffer.from("after-reject"));
      await message;
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("replacement offers implicitly roll back either pranswer direction", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    try {
      // Arrange: 初回 offer と pranswer を双方の pending に置く。
      offerer.addTransceiver("audio");
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const provisional = await answerer.createAnswer();
      await answerer.setLocalDescription({
        type: "pranswer",
        sdp: provisional.sdp,
      });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });

      // Act: offerer は remote pranswer を、answerer は local pranswer を
      // implicit rollback して replacement offer を受ける。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);

      // Assert: 最後の stable baseline は空で、新しい offer だけが pending。
      expect(offerer.signalingState).toBe("have-local-offer");
      expect(answerer.signalingState).toBe("have-remote-offer");
      expect(offerer.currentLocalDescription).toBeNull();
      expect(answerer.currentRemoteDescription).toBeNull();
      expect(offerer.pendingRemoteDescription).toBeNull();
      expect(answerer.pendingLocalDescription).toBeNull();
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("description and trickle operations serialize, and a rolled-back ufrag cannot be buffered", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    try {
      // Arrange: 同じ tick に渡す remote offer と candidate を用意する。
      offerer.addTransceiver("audio");
      await offerer.setLocalDescription(await offerer.createOffer());
      const offer = offerer.localDescription!;
      const mid = offer.sdp.match(/a=mid:([^\r\n]+)/)![1];
      const ufrag = offer.sdp.match(/a=ice-ufrag:([^\r\n]+)/)![1];
      const candidate = {
        candidate:
          "candidate:serial 1 udp 2113937151 192.0.2.13 12348 typ host",
        sdpMid: mid,
        usernameFragment: ufrag,
      };

      // Act: SRD と trickle を待たずに連続で開始する。
      const applied = answerer.setRemoteDescription(offer);
      const trickled = answerer.addIceCandidate(candidate);
      await Promise.all([applied, trickled]);

      // Assert: candidate は新しい pending description にだけ付く。
      expect(answerer.pendingRemoteDescription!.sdp).toContain("serial");
      await answerer.setRemoteDescription({ type: "rollback" });
      assertNegotiationInvariants(answerer);

      // Act / Assert: 破棄済み generation の遅延 candidate は次回用キューに入らない。
      await expect(answerer.addIceCandidate(candidate)).rejects.toMatchObject({
        name: "OperationError",
      });
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });
});
