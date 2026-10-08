import type { Connection } from "../../../ice/src";
import { StunOverTurnProtocol } from "../../../ice/src/turn/protocol";
import { turnAllocations } from "../../../ice/tests/utils";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  useH264,
  useVP8,
} from "../../src";
import { negotiate } from "../issue/705.helpers";
import {
  assertNegotiationInvariants,
  createConnectedMediaAndDataPeers,
  createConnectedVideoPeers,
  createH264OnlyReoffer,
  createHeldTurnRestartPeers,
  createLocalTurnIceServer,
  offeredVideoCodecs,
  recordIceCandidates,
  sendAndExpectData,
  sendAndExpectRtp,
  waitForCommittedNomination,
  waitForEndOfCandidates,
} from "./negotiationTransactionUtils";

/**
 * Regressions for develop features merged into the negotiation transaction
 * (ticket section 2.6): TURN settings across a staged ICE restart, SCTP MTU,
 * and app-driven codec state during a pending negotiation.
 */
describe("develop features inside the negotiation transaction", () => {
  describe("TURN settings and ICE restart (#688 / #731)", () => {
    test("a TURN server set before a restart offer is gathered at the commit and trickled", async () => {
      // Arrange: TURN なしで接続済みの peer と、後から設定するローカル TURN server を用意する
      const { offerer, answerer, channel, received } =
        await createConnectedMediaAndDataPeers();
      const turn = await createLocalTurnIceServer();
      const events = recordIceCandidates(offerer);
      try {
        // Act: TURN を設定してから ICE restart の offer を適用する
        offerer.setConfiguration({ iceServers: turn.iceServers });
        offerer.restartIce();
        await offerer.setLocalDescription(await offerer.createOffer());

        // Assert: 新しい server で集め直す generation なので、offer は relay も EOC もまだ含まない
        const offerSdp = offerer.localDescription!.sdp;
        expect(offerSdp).not.toContain("a=end-of-candidates");
        expect(offerSdp).not.toContain("typ relay");

        // Act: answer を確定させ、commit 後に出る候補を answerer へ trickle する
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        const committedFrom = events.length;
        await offerer.setRemoteDescription(answerer.localDescription!);
        await waitForEndOfCandidates(events);
        const committed = events.slice(committedFrom);
        for (const candidate of committed) {
          await answerer.addIceCandidate(candidate?.toJSON() ?? null);
        }

        // Assert: commit 後に新しい TURN server の relay 候補が trickle され、answerer が受け付ける
        const relay = committed.find((c) => c?.candidate.includes("typ relay"));
        expect(relay).toBeDefined();
        expect(committed.at(-1)).toBeUndefined();
        expect(
          answerer.iceTransports[0]
            .getRemoteCandidates()
            .some((c) => c.candidate.includes("typ relay")),
        ).toBe(true);

        // Assert: 新しい generation が nominate され、DataChannel が通信できる
        await waitForCommittedNomination(offerer);
        await sendAndExpectData(channel, received, "after TURN restart");
      } finally {
        await offerer.close();
        await answerer.close();
        await turn.server.close();
      }
    });

    test("an ICE restart with TURN trickles a fresh relay candidate after the commit", async () => {
      // Arrange: TURN 付きで接続済みの peer と、offerer の候補を answerer へ転送する経路
      const turn = await createLocalTurnIceServer();
      const offerer = new RTCPeerConnection({ iceServers: turn.iceServers });
      const answerer = new RTCPeerConnection();
      try {
        const channel = offerer.createDataChannel("turn");
        const received = answerer.onDataChannel.asPromise().then(([c]) => c);
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);
        const relayBefore = offerer.iceTransports[0]
          .getLocalCandidates()
          .filter((c) => c.candidate.includes("typ relay"));
        expect(relayBefore).toHaveLength(1);
        const events = recordIceCandidates(offerer);

        // Act: 設定を変えずに ICE restart を交渉し、commit 後の候補を answerer へ trickle する
        offerer.restartIce();
        await offerer.setLocalDescription(await offerer.createOffer());
        const offerSdp = offerer.localDescription!.sdp;
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        const committedFrom = events.length;
        await offerer.setRemoteDescription(answerer.localDescription!);
        await waitForEndOfCandidates(events);
        const committed = events.slice(committedFrom);
        for (const candidate of committed) {
          await answerer.addIceCandidate(candidate?.toJSON() ?? null);
        }

        // Assert: offer は古い relay 候補も EOC も含まず、commit 後に新しい allocation の relay 候補と EOC が届く
        expect(offerSdp).not.toContain("typ relay");
        expect(offerSdp).not.toContain("a=end-of-candidates");
        const relayAfter = committed.filter((c) =>
          c?.candidate.includes("typ relay"),
        );
        expect(relayAfter).toHaveLength(1);
        expect(relayAfter[0]!.candidate).not.toBe(relayBefore[0].candidate);
        expect(committed.at(-1)).toBeUndefined();

        // Assert: 新しい generation で DataChannel が通信できる
        await waitForCommittedNomination(offerer);
        await sendAndExpectData(channel, await received, "after restart");
      } finally {
        await offerer.close();
        await answerer.close();
        await turn.server.close();
      }
    });
  });

  describe("background gathering of consecutive ICE restarts", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });
    const relayAllocations = (pc: RTCPeerConnection) =>
      turnAllocations(pc.iceTransports[0].connection as Connection);

    test("end-of-candidates is signalled once, when the latest generation completes", async () => {
      // Arrange: 2 回続けた restart の TURN allocation をそれぞれ proxy で保留する
      const peers = await createHeldTurnRestartPeers(2);
      const closed = vi.spyOn(StunOverTurnProtocol.prototype, "close");
      try {
        await peers.restartThrough(0);
        await peers.restartThrough(1);
        const events = recordIceCandidates(peers.offerer);

        // Act: 置き換えられた 1 回目の restart の allocation を完了させる
        peers.proxies[0].release();
        await vi.waitFor(() =>
          expect(new Set(closed.mock.contexts).size).toBe(2),
        );

        // Assert: 新 generation はまだ gathering で、end-of-candidates も relay 候補も出ない
        expect(events).not.toContain(undefined);
        expect(events.some((c) => c?.candidate.includes("typ relay"))).toBe(
          false,
        );
        expect(peers.offerer.iceGatheringState).toBe("gathering");

        // Act: 新 generation の allocation を完了させる
        peers.proxies[1].release();
        await waitForEndOfCandidates(events);

        // Assert: end-of-candidates は新 generation の relay 候補の後に一度だけ出る
        expect(events.filter((c) => c === undefined)).toHaveLength(1);
        expect(events.at(-1)).toBeUndefined();
        expect(
          events.filter((c) => c?.candidate.includes("typ relay")),
        ).toHaveLength(1);
        expect(peers.offerer.iceGatheringState).toBe("complete");
      } finally {
        await peers.close();
      }
    });

    test("only the latest generation keeps a TURN allocation", async () => {
      // Arrange: 2 回続けた restart の TURN allocation をそれぞれ proxy で保留する
      const peers = await createHeldTurnRestartPeers(2);
      const closed = vi.spyOn(StunOverTurnProtocol.prototype, "close");
      try {
        await peers.restartThrough(0);
        await peers.restartThrough(1);

        // Act: 新 generation、置き換えられた generation の順に allocation を完了させる
        peers.proxies[1].release();
        await waitForEndOfCandidates(recordIceCandidates(peers.offerer));
        peers.proxies[0].release();
        await vi.waitFor(() =>
          expect(new Set(closed.mock.contexts).size).toBe(2),
        );

        // Assert: 新 generation の allocation 1 つだけが残り、遅れて完了した旧 allocation は閉じる
        const allocations = relayAllocations(peers.offerer);
        expect(allocations).toHaveLength(1);
        expect(closed.mock.contexts).not.toContain(allocations[0]);
        const relay = peers.offerer.iceTransports[0]
          .getLocalCandidates()
          .filter((c) => c.candidate.includes("typ relay"));
        expect(relay).toHaveLength(1);
      } finally {
        await peers.close();
      }
    });

    test("close() during a restart's background TURN gathering leaves no allocation", async () => {
      // Arrange: restart の TURN allocation を proxy で保留する
      const peers = await createHeldTurnRestartPeers(1);
      const closed = vi.spyOn(StunOverTurnProtocol.prototype, "close");
      try {
        await peers.restartThrough(0);

        // Act: gathering 中に close し、その後で allocation を完了させる
        await peers.offerer.close();
        peers.proxies[0].release();

        // Assert: close 後にできた allocation も閉じ (refresh timer も止まり)、transport に残らない
        await vi.waitFor(() =>
          expect(new Set(closed.mock.contexts).size).toBe(2),
        );
        expect(relayAllocations(peers.offerer)).toHaveLength(0);
      } finally {
        await peers.close();
      }
    });
  });

  describe("one-to-one codec matching (#729)", () => {
    test("an offer with several H264 variants is answered with only the configured one", async () => {
      // Arrange: offerer は 3 種類の H264、answerer は既定の H264 (packetization-mode=1) だけを持つ
      const offerer = new RTCPeerConnection({
        codecs: {
          video: [
            useH264(),
            useH264({
              parameters:
                "profile-level-id=42e01f;packetization-mode=0;level-asymmetry-allowed=1",
            }),
            useH264({
              parameters:
                "profile-level-id=640032;packetization-mode=1;level-asymmetry-allowed=1",
            }),
          ],
        },
      });
      const answerer = new RTCPeerConnection({
        codecs: { video: [useH264()] },
      });
      try {
        offerer.addTransceiver("video");
        await offerer.setLocalDescription(await offerer.createOffer());
        expect(offeredVideoCodecs(offerer.localDescription!.sdp)).toEqual([
          "H264",
          "H264",
          "H264",
        ]);

        // Act: offer に answer する
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());

        // Assert: answer は設定した 1 つの variant だけを受理する
        expect(offeredVideoCodecs(answerer.localDescription!.sdp)).toEqual([
          "H264",
        ]);
        await offerer.setRemoteDescription(answerer.localDescription!);
        assertNegotiationInvariants(answerer);
        assertNegotiationInvariants(offerer);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });
  });

  describe("app codec changes during a pending negotiation (#729)", () => {
    test("setCodecPreferences between createAnswer and setLocalDescription commits the answer's codec", async () => {
      // Arrange: current は VP8、offerer が H264 だけの re-offer を出し、answerer が answer を作成済み
      const { offerer, answerer, outgoing, incoming, transceiver } =
        await createH264OnlyReoffer();
      try {
        const answer = await answerer.createAnswer();

        // Act: answer の適用前に preference を変え、その answer を適用する
        transceiver.setCodecPreferences([useVP8(), useH264()]);
        await answerer.setLocalDescription(answer);
        await offerer.setRemoteDescription(answerer.localDescription!);

        // Assert: 受信 table は answer の H264 を持ち、RTP が届く
        const codecs = Object.values(
          transceiver.receiver.snapshotReceiveTables().codecs,
        ).map((codec) => codec.name.toUpperCase());
        expect(codecs).toContain("H264");
        assertNegotiationInvariants(answerer);
        await sendAndExpectRtp(outgoing, incoming, "late-preferences");

        // Assert: 新しい preference は次の offer で再解決される
        const next = await answerer.createOffer();
        expect(offeredVideoCodecs(next.sdp)[0]).toBe("VP8");
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test("addTrack between createAnswer and setLocalDescription sends with the answer's codec", async () => {
      // Arrange: current は VP8、H264 だけの re-offer への answer を作成済み
      const { offerer, answerer, transceiver } = await createH264OnlyReoffer();
      try {
        const answer = await answerer.createAnswer();

        // Act: answer の適用前に既存 transceiver へ track を追加し、answer を適用する
        answerer.addTrack(new MediaStreamTrack({ kind: "video" }));
        await answerer.setLocalDescription(answer);
        await offerer.setRemoteDescription(answerer.localDescription!);

        // Assert: sender は answer の H264 で送り、transceiver の codec も空にならない
        expect(transceiver.sender.codec?.name.toUpperCase()).toBe("H264");
        expect(transceiver.codecs.length).toBeGreaterThan(0);
        assertNegotiationInvariants(answerer);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test("setCodecPreferences during a pending offer survives its rollback", async () => {
      // Arrange: VP8 + H264 の接続済み session で、offerer の re-offer を適用中にする
      const { offerer, answerer } = await createConnectedVideoPeers({
        codecs: { video: [useVP8(), useH264()] },
      });
      try {
        const [transceiver] = offerer.getTransceivers();
        await offerer.setLocalDescription(await offerer.createOffer());

        // Act: pending 中に H264 だけを優先し、その offer を rollback する
        transceiver.setCodecPreferences([useH264()]);
        await offerer.setLocalDescription({ type: "rollback" });

        // Assert: アプリの選択は残り、次の offer は H264 だけを提案する
        const next = await offerer.createOffer();
        expect(offeredVideoCodecs(next.sdp)).toEqual(["H264"]);
        assertNegotiationInvariants(offerer);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test("replaceTrack during a pending re-offer rejects a track the answer's codec cannot carry", async () => {
      // Arrange: current は VP8、H264 だけの re-offer を適用中の answerer
      const { offerer, answerer, transceiver } = await createH264OnlyReoffer();
      try {
        const vp8Source = new MediaStreamTrack({
          kind: "video",
          codec: useVP8(),
        });

        // Act / Assert: commit 後に H264 で送ることになる VP8 source の track は受け付けない
        await expect(
          transceiver.sender.replaceTrack(vp8Source),
        ).rejects.toMatchObject({ name: "InvalidModificationError" });

        // Assert: 交渉はそのまま完了できる
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);
        assertNegotiationInvariants(answerer);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test("a track attached during a rolled-back pranswer gets the restored codec", async () => {
      // Arrange: current は VP8、offerer は H264 だけの re-offer を適用中で、送信 track を差し替える
      const { offerer, answerer } = await createH264OnlyReoffer();
      try {
        const [sender] = offerer.getSenders();
        const replacement = new MediaStreamTrack({ kind: "video" });
        await sender.replaceTrack(replacement);
        const answer = await answerer.createAnswer();

        // Act: H264 の remote pranswer を暫定適用してから rollback する
        await offerer.setRemoteDescription({
          type: "pranswer",
          sdp: answer.sdp,
        });
        expect(replacement.codec?.name.toUpperCase()).toBe("H264");
        await offerer.setLocalDescription({ type: "rollback" });

        // Assert: 差し替えた track の codec も current の VP8 に戻る
        expect(replacement.codec?.name.toUpperCase()).toBe("VP8");
        assertNegotiationInvariants(offerer);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });
  });

  describe("m-line reuse during a pending negotiation (#721 / issue 705)", () => {
    test("a local offer reuses a stopped m-line only for a transceiver of the same kind", async () => {
      // Arrange: video を停止して port 0 まで交渉済みの session (index 0 が停止済み video)
      const { offerer, answerer } = await createConnectedVideoPeers();
      try {
        const [video] = offerer.getTransceivers();
        video.stop();
        await negotiate(offerer, answerer);

        // Act: audio を追加して offer を作る
        const audio = offerer.addTransceiver("audio");
        await offerer.setLocalDescription(await offerer.createOffer());

        // Assert: 停止済み video の位置は audio に使わず、audio は新しい m-line に入る
        const kinds = offerer
          .localDescription!.sdp.split("\r\n")
          .filter((line) => line.startsWith("m="))
          .map((line) => line.split(" ")[0]);
        expect(kinds[0]).toBe("m=video");
        expect(audio.mLineIndex).not.toBe(0);
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);
        assertNegotiationInvariants(offerer);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test("a transceiver added during a rolled-back offer does not keep the stopped m-line index", async () => {
      // Arrange: audio を停止して port 0 まで交渉済みの session
      const { offerer, answerer } = await createConnectedVideoPeers(
        {},
        { withAudio: true },
      );
      try {
        const audio = offerer
          .getTransceivers()
          .find((transceiver) => transceiver.kind === "audio")!;
        audio.stop();
        await negotiate(offerer, answerer);
        await offerer.setLocalDescription(await offerer.createOffer());

        // Act: pending 中に audio を追加し (停止済みの位置を引き継ぐ)、offer を rollback する
        const added = offerer.addTransceiver("audio");
        await offerer.setLocalDescription({ type: "rollback" });

        // Assert: 追加した transceiver は停止済み m-line の位置を持たず、再交渉で追加される
        expect(added.mLineIndex).not.toBe(audio.mLineIndex);
        await negotiate(offerer, answerer);
        expect(added.mid).toBeTruthy();
        assertNegotiationInvariants(offerer);
        assertNegotiationInvariants(answerer);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });
  });

  describe("SCTP MTU (#716)", () => {
    test("an SCTP transport a remote offer creates uses the configured MTU", async () => {
      // Arrange: MTU を設定した answerer と DataChannel を持つ offerer
      const offerer = new RTCPeerConnection();
      const answerer = new RTCPeerConnection({ sctp: { mtu: 1052 } });
      try {
        offerer.createDataChannel("mtu");
        await offerer.setLocalDescription(await offerer.createOffer());

        // Act: remote offer を適用して SCTP transport を作らせる
        await answerer.setRemoteDescription(offerer.localDescription!);

        // Assert: pending 中に作った SCTP transport も設定の MTU を使う
        expect(answerer.sctpTransport!.sctp.mtu).toBe(1052);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });

    test("the MTU is fixed while a remote offer's SCTP transport is pending and free again after rollback", async () => {
      // Arrange: DataChannel を含む remote offer を適用中の answerer
      const offerer = new RTCPeerConnection();
      const answerer = new RTCPeerConnection();
      try {
        offerer.createDataChannel("mtu");
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);

        // Act / Assert: pending の SCTP transport があるので MTU は変えられない
        expect(() =>
          answerer.setConfiguration({ sctp: { mtu: 1052 } }),
        ).toThrow("sctp.mtu cannot be changed after SCTP transport creation");

        // Act: remote offer を rollback する
        await answerer.setRemoteDescription({ type: "rollback" });

        // Assert: 提案が作った SCTP transport は消え、MTU を変更できる
        expect(answerer.sctpTransport).toBeUndefined();
        expect(() =>
          answerer.setConfiguration({ sctp: { mtu: 1052 } }),
        ).not.toThrow();
        expect(answerer.getConfiguration().sctp.mtu).toBe(1052);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    });
  });
});
