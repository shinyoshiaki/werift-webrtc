import type { Connection } from "../../../../ice/src";
import {
  StunOverTurnProtocol,
  TurnProtocol,
} from "../../../../ice/src/turn/protocol";
import { turnAllocations } from "../../../../ice/tests/utils";
import type { RTCIceCandidate, RTCPeerConnection } from "../../../src";
import { MediaStreamTrack, useH264, useVP8 } from "../../../src";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  createConnectedMediaAndDataPeersWithTurnServer,
  createConnectedVideoPeers,
  createH264OnlyReoffer,
  createHeldTurnRestartPeers,
  createPeerPair,
  offeredVideoCodecs,
  recordIceCandidates,
  waitForCommittedNomination,
  waitForEndOfCandidates,
} from "../harness/negotiationTransactionUtils";

/** Helpers of the TURN cases. */
const turnFns = {
  StunOverTurnProtocol,
  /** Act: `addIceCandidate` each recorded event on `pc` in order (`undefined` is end-of-candidates). */
  trickleAll: async (
    pc: RTCPeerConnection,
    events: (RTCIceCandidate | undefined)[],
  ) => {
    for (const candidate of events) {
      await pc.addIceCandidate(candidate?.toJSON() ?? null);
    }
  },
  relayAllocations: (pc: RTCPeerConnection) =>
    turnAllocations(pc.iceTransports[0].connection as Connection),
};

/**
 * Regressions for develop features merged into the negotiation transaction
 * (ticket section 2.6): TURN settings across a staged ICE restart, SCTP MTU,
 * and app-driven codec state during a pending negotiation.
 */
describe("develop features inside the negotiation transaction", () => {
  describeCases("TURN settings and ICE restart (#688 / #731)", () => {
    const { trickleAll } = turnFns;

    negotiationCase(
      "a TURN server set before a restart offer is gathered at the commit and trickled",
      { ref: "2.6-T3b 2.8-6; origin: develop #688 / #731" },
      async (c) => {
        // Arrange: TURN なしで接続済みの peer と、後から設定するローカル TURN server を用意する。
        const { a, b, channel, received, turn } = await c.given(
          createConnectedMediaAndDataPeersWithTurnServer(),
        );
        const events = recordIceCandidates(a);

        // Act: TURN を設定してから ICE restart の offer を適用する。
        a.setConfiguration({ iceServers: turn.iceServers });
        a.restartIce();
        await c.offer(a, { hold: true });

        // Assert: 新しい server で集め直す generation なので、offer は relay も EOC もまだ含まない。
        expect(a.localDescription!.sdp).not.toContain("a=end-of-candidates");
        expect(a.localDescription!.sdp).not.toContain("typ relay");

        // Act: answer を確定させ、commit 後に出る候補を answerer へ trickle する。
        await c.setRemote(b, a.localDescription);
        await c.answer(b, { hold: true });
        const committedFrom = events.length;
        await c.setRemote(a, b.localDescription);
        await waitForEndOfCandidates(events);
        const committed = events.slice(committedFrom);
        await trickleAll(b, committed);

        // Assert: commit 後に新しい TURN server の relay 候補が trickle され、answerer が受け付ける。
        expect(
          committed.find((candidate) =>
            candidate?.candidate.includes("typ relay"),
          ),
        ).not.toBe(undefined);
        expect(committed.at(-1)).toBe(undefined);
        expect(
          b.iceTransports[0]
            .getRemoteCandidates()
            .some((candidate) => candidate.candidate.includes("typ relay")),
        ).toBe(true);

        // Assert: 新しい generation が nominate され、DataChannel が通信できる。
        await waitForCommittedNomination(a);
        await c.data(channel, received);
      },
    );

    negotiationCase(
      "an ICE restart with TURN trickles a fresh relay candidate after the commit",
      { ref: "2.3-9 2.6-T3c 2.8-6; origin: develop #688 / #731" },
      async (c) => {
        // Arrange: TURN 付きで接続済みの peer (TURN は offerer だけ) と、offerer の候補を answerer へ転送する経路。
        const { a, b, channel, received } = await c.given(
          createHeldTurnRestartPeers(0),
        );
        const relayBefore = a.iceTransports[0]
          .getLocalCandidates()
          .filter((candidate) => candidate.candidate.includes("typ relay"));
        expect(relayBefore.length).toEqual(1);
        const events = recordIceCandidates(a);

        // Act: 設定を変えずに ICE restart を交渉し、commit 後の候補を answerer へ trickle する。
        a.restartIce();
        await c.offer(a, { hold: true });
        const offerSdp = a.localDescription!.sdp;
        await c.setRemote(b, a.localDescription);
        await c.answer(b, { hold: true });
        const committedFrom = events.length;
        await c.setRemote(a, b.localDescription);
        await waitForEndOfCandidates(events);
        const committed = events.slice(committedFrom);
        await trickleAll(b, committed);

        // Assert: offer は古い relay 候補も EOC も含まず、commit 後に新しい allocation の relay 候補と EOC が届く。
        expect(offerSdp).not.toContain("typ relay");
        expect(offerSdp).not.toContain("a=end-of-candidates");
        const relayAfter = committed.filter((candidate) =>
          candidate?.candidate.includes("typ relay"),
        );
        expect(relayAfter.length).toEqual(1);
        expect(relayAfter[0]!.candidate).not.toBe(relayBefore[0].candidate);
        expect(committed.at(-1)).toBe(undefined);

        // Assert: 新しい generation で DataChannel が通信できる。
        await waitForCommittedNomination(a);
        await c.data(channel, await received);
      },
    );
  });

  describeCases("background gathering of consecutive ICE restarts", () => {
    const { StunOverTurnProtocol, relayAllocations } = turnFns;

    negotiationCase(
      "end-of-candidates is signalled once, when the latest generation completes",
      { ref: "2.3-10 2.3-11 2.3-12 2.8-8 2.8-9; origin: develop #688 / #731" },
      async (c) => {
        // Arrange: 2 回続けた restart の TURN allocation をそれぞれ proxy で保留する。
        const { a, channel, proxies, restartThrough } = await c.given(
          createHeldTurnRestartPeers(2),
        );
        const closed = vi.spyOn(StunOverTurnProtocol.prototype, "close");
        await restartThrough(0);
        await restartThrough(1);
        const events = recordIceCandidates(a);

        // Act: 置き換えられた 1 回目の restart の allocation を完了させる。
        proxies[0].release();
        await c.waitFor(() => new Set(closed.mock.contexts).size === 2, 1000);

        // Assert: 新 generation はまだ gathering で、end-of-candidates も relay 候補も出ない。
        expect(events).not.toContain(undefined);
        expect(
          events.some((candidate) =>
            candidate?.candidate.includes("typ relay"),
          ),
        ).toBe(false);
        expect(a.iceGatheringState).toEqual("gathering");

        // Act: 新 generation の allocation を完了させる。
        proxies[1].release();
        await waitForEndOfCandidates(events);

        // Assert: end-of-candidates は新 generation の relay 候補の後に一度だけ出る。
        expect(
          events.filter((candidate) => candidate === undefined).length,
        ).toEqual(1);
        expect(events.at(-1)).toBe(undefined);
        expect(
          events.filter((candidate) =>
            candidate?.candidate.includes("typ relay"),
          ).length,
        ).toEqual(1);
        expect(a.iceGatheringState).toEqual("complete");

        // Assert: 継続の前提として、初回接続の DataChannel が開く (接続途中の再交渉で SCTP が COOKIE_WAIT に残る既知の疑いを避ける)。
        await c.waitFor(() => channel.readyState === "open", 10000);
      },
    );

    negotiationCase(
      "only the latest generation keeps a TURN allocation",
      { ref: "2.6-T3c 2.8-9; origin: develop #688 / #731" },
      async (c) => {
        // Arrange: 2 回続けた restart の TURN allocation をそれぞれ proxy で保留する。
        const { a, channel, proxies, restartThrough } = await c.given(
          createHeldTurnRestartPeers(2),
        );
        const closed = vi.spyOn(StunOverTurnProtocol.prototype, "close");
        await restartThrough(0);
        await restartThrough(1);

        // Act: 新 generation、置き換えられた generation の順に allocation を完了させる。
        const events = recordIceCandidates(a);
        proxies[1].release();
        await waitForEndOfCandidates(events);
        proxies[0].release();
        await c.waitFor(() => new Set(closed.mock.contexts).size === 2, 1000);

        // Assert: 新 generation の allocation 1 つだけが残り、遅れて完了した旧 allocation は閉じる。
        const allocations = relayAllocations(a);
        expect(allocations.length).toEqual(1);
        expect(closed.mock.contexts).not.toContain(allocations[0]);
        expect(
          a.iceTransports[0]
            .getLocalCandidates()
            .filter((candidate) => candidate.candidate.includes("typ relay"))
            .length,
        ).toEqual(1);

        // Assert: 継続の前提として、初回接続の DataChannel が開く (接続途中の再交渉で SCTP が COOKIE_WAIT に残る既知の疑いを避ける)。
        await c.waitFor(() => channel.readyState === "open", 10000);
      },
    );

    negotiationCase(
      "an unapplied restart offer does not change the applied description the gathering refreshes",
      { ref: "2.8-13; origin: develop #688 / #731" },
      async (c) => {
        // Arrange: restart を確定し、その TURN allocation を proxy で保留する。
        const { a, channel, proxies, restartThrough } = await c.given(
          createHeldTurnRestartPeers(1),
        );
        await restartThrough(0);
        const ufragOf = (sdp: string) => sdp.match(/^a=ice-ufrag:(\S+)/m)![1];
        const committed = ufragOf(a.currentLocalDescription!.sdp);
        const iceTransport = a.iceTransports[0];

        // Act: 次の restart offer を作るが適用せず、確定済み generation の gather を完了させる。
        a.restartIce();
        const unapplied = await a.createOffer();
        const future = ufragOf(unapplied.sdp);
        proxies[0].release();
        await c.waitFor(() => iceTransport.gatheringState === "complete", 1000);

        // Assert: current description は適用した generation の資格情報・relay 候補・EOC を保ち、live ICE と一致する。未適用 offer の generation は入らない。
        expect(future).not.toBe(committed);
        const current = a.currentLocalDescription!.sdp;
        expect(ufragOf(current)).toBe(committed);
        expect(iceTransport.connection.localUsername).toBe(committed);
        expect(current).toContain("typ relay");
        expect(current).toContain("a=end-of-candidates");
        expect(a.signalingState).toEqual("stable");

        // Assert: 継続の前提として、初回接続の DataChannel が開く (接続途中の再交渉で SCTP が COOKIE_WAIT に残る既知の疑いを避ける)。
        await c.waitFor(() => channel.readyState === "open", 10000);
      },
    );

    negotiationCase(
      "close() during a restart's background TURN gathering leaves no allocation",
      {
        ref: "2.3-12 2.3-24 2.8-8; origin: develop #688 / #731",
        exempt: "the offerer's close() is the operation under test",
      },
      async (c) => {
        // Arrange: restart の TURN allocation を proxy で保留する。
        const { a, proxies, restartThrough } = await c.given(
          createHeldTurnRestartPeers(1),
        );
        const closed = vi.spyOn(TurnProtocol.prototype, "close");
        await restartThrough(0);

        // Act: gathering 中に close し、その後で allocation を完了させる。
        await a.close();
        proxies[0].release();

        // Assert: 保留中の allocation も (完了を待たずに) client ごと閉じ (再送・refresh の
        // timer も止まり)、transport に残らない。
        await c.waitFor(() => new Set(closed.mock.contexts).size === 2, 1000);
        expect(relayAllocations(a).length).toEqual(0);
      },
    );
  });

  describeCases("one-to-one codec matching (#729)", () => {
    negotiationCase(
      "an offer with several H264 variants is answered with only the configured one",
      { ref: "2.6-T4f; origin: develop #729" },
      async (c) => {
        // Arrange: offerer は 3 種類の H264、answerer は既定の H264 (packetization-mode=1) だけを持つ。
        const { a, b } = await c.given(
          createPeerPair(
            {
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
            },
            { codecs: { video: [useH264()] } },
          ),
        );
        a.addTransceiver("video");
        await c.offer(a, { hold: true });
        expect(offeredVideoCodecs(a.localDescription!.sdp)).toEqual([
          "H264",
          "H264",
          "H264",
        ]);

        await c.setRemote(b, a.localDescription);
        await c.answer(b, { hold: true });

        // Assert: answer は設定した 1 つの variant だけを受理する。
        expect(offeredVideoCodecs(b.localDescription!.sdp)).toEqual(["H264"]);
        await c.setRemote(a, b.localDescription);
      },
    );
  });

  describeCases("app codec changes during a pending negotiation (#729)", () => {
    negotiationCase(
      "setCodecPreferences during a pending offer survives its rollback",
      { ref: "2.5-17 2.6-T4b; origin: develop #729" },
      async (c) => {
        // Arrange: VP8 + H264 の接続済み session で、offerer の re-offer を適用中にする。
        const { a } = await c.given(
          createConnectedVideoPeers({
            codecs: { video: [useVP8(), useH264()] },
          }),
        );
        const transceiver = a.getTransceivers()[0];
        await c.offer(a, { hold: true });

        // Act: pending 中に H264 だけを優先し、その offer を rollback する。
        transceiver.setCodecPreferences([useH264()]);
        await c.setLocal(a, "rollback");

        // Assert: アプリの選択は残り、次の offer は H264 だけを提案する。
        const next = await a.createOffer();
        expect(offeredVideoCodecs(next.sdp)).toEqual(["H264"]);
        c.invariants(a);
      },
    );

    negotiationCase(
      "replaceTrack during a pending re-offer rejects a track the answer's codec cannot carry",
      { ref: "2.6-T4d; origin: develop #729" },
      async (c) => {
        // Arrange: current は VP8、H264 だけの re-offer を適用中の answerer。
        const { b, transceiver } = await c.given(createH264OnlyReoffer());
        const vp8Source = new MediaStreamTrack({
          kind: "video",
          codec: useVP8(),
        });

        // Act / Assert: commit 後に H264 で送ることになる VP8 source の track は受け付けない。
        await c.rejects(
          () => transceiver.sender.replaceTrack(vp8Source),
          "InvalidModificationError",
        );

        // Assert: 交渉はそのまま完了できる。
        await c.answer(b);
      },
    );

    negotiationCase(
      "a track attached during a rolled-back pranswer gets the restored codec",
      { ref: "2.5-17; origin: develop #729" },
      async (c) => {
        // Arrange: current は VP8、offerer は H264 だけの re-offer を適用中で、送信 track を差し替える。
        const { a, b } = await c.given(createH264OnlyReoffer());
        const replacement = new MediaStreamTrack({ kind: "video" });
        await a.getSenders()[0].replaceTrack(replacement);
        const answer = await b.createAnswer();

        // Act: H264 の remote pranswer を暫定適用してから rollback する。
        await c.setRemote(a, answer, { type: "pranswer" });
        expect(replacement.codec?.name.toUpperCase()).toEqual("H264");
        await c.setLocal(a, "rollback");

        // Assert: 差し替えた track の codec も current の VP8 に戻る。
        expect(replacement.codec?.name.toUpperCase()).toEqual("VP8");
      },
    );
  });

  describeCases(
    "m-line reuse during a pending negotiation (#721 / issue 705)",
    () => {
      negotiationCase(
        "a local offer reuses a stopped m-line only for a transceiver of the same kind",
        { ref: "2.5-6 2.8-46; origin: develop #721 / issue 705" },
        async (c) => {
          // Arrange: video を停止して port 0 まで交渉済みの session (index 0 が停止済み video)。
          const { a, b } = await c.given(createConnectedVideoPeers());
          a.getTransceivers()[0].stop();
          await c.negotiate(a);

          // Act: audio を追加して offer を作る。
          const audio = a.addTransceiver("audio");
          await c.offer(a, { hold: true });

          // Assert: 停止済み video の位置は audio に使わず、audio は新しい m-line に入る。
          const kinds = a
            .localDescription!.sdp.split("\r\n")
            .filter((line) => line.startsWith("m="))
            .map((line) => line.split(" ")[0]);
          expect(kinds[0]).toEqual("m=video");
          expect(audio.mLineIndex).not.toBe(0);
          await c.setRemote(b, a.localDescription);
          await c.answer(b);
        },
      );

      negotiationCase(
        "a transceiver added during a rolled-back offer does not keep the stopped m-line index",
        { ref: "2.1-T10 2.6-T2; origin: develop #721 / issue 705" },
        async (c) => {
          // Arrange: audio を停止して port 0 まで交渉済みの session。
          const { a } = await c.given(
            createConnectedVideoPeers({}, { withAudio: true }),
          );
          const audio = a
            .getTransceivers()
            .find((transceiver) => transceiver.kind === "audio");
          audio!.stop();
          await c.negotiate(a);
          await c.offer(a, { hold: true });

          // Act: pending 中に audio を追加し (停止済みの位置を引き継ぐ)、offer を rollback する。
          const added = a.addTransceiver("audio");
          await c.setLocal(a, "rollback");

          // Assert: 追加した transceiver は停止済み m-line の位置を持たず、再交渉で追加される。
          expect(added.mLineIndex).not.toBe(audio!.mLineIndex);
          await c.negotiate(a);
          expect(Boolean(added.mid)).toBe(true);
        },
      );
    },
  );

  describeCases("SCTP MTU (#716)", () => {
    negotiationCase(
      "an SCTP transport a remote offer creates uses the configured MTU",
      { ref: "2.6-T1a; origin: develop #716" },
      async (c) => {
        // Arrange: MTU を設定した answerer と DataChannel を持つ offerer。
        const { a, b } = await c.given(
          createPeerPair({}, { sctp: { mtu: 1052 } }),
        );
        a.createDataChannel("mtu");
        await c.offer(a, { hold: true });

        // Act: remote offer を適用して SCTP transport を作らせる。
        await c.setRemote(b, a.localDescription);

        // Assert: pending 中に作った SCTP transport も設定の MTU を使う。
        expect(b.sctpTransport!.sctp.mtu).toEqual(1052);
      },
    );

    negotiationCase(
      "the MTU is fixed while a remote offer's SCTP transport is pending and free again after rollback",
      { ref: "2.6-T1c; origin: develop #716" },
      async (c) => {
        // Arrange: DataChannel を含む remote offer を適用中の answerer。
        const { a, b } = await c.given(createPeerPair());
        a.createDataChannel("mtu");
        await c.offer(a);

        // Act / Assert: pending の SCTP transport があるので MTU は変えられない。
        await c.rejects(
          () => b.setConfiguration({ sctp: { mtu: 1052 } }),
          "sctp.mtu cannot be changed after SCTP transport creation",
        );

        await c.setRemote(b, "rollback");

        // Assert: 提案が作った SCTP transport は消え、MTU を変更できる。
        expect(b.sctpTransport).toEqual(undefined);
        b.setConfiguration({ sctp: { mtu: 1052 } });
        expect(b.getConfiguration().sctp.mtu).toEqual(1052);
      },
    );
  });
});
