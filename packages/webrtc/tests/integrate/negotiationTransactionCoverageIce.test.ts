import type { RTCPeerConnection } from "../../src";
import {
  assertNegotiationInvariants,
  createBundledIceRestartPranswer,
  createConnectedMediaAndDataPeers,
  createConnectedVideoPeers,
  createIceRestartPranswer,
  createInitialPranswerConnection,
  createLocalTurnIceServer,
  enforceSessionContinuation,
  exemptFromContinuation,
  expectSessionContinues,
  forceIceState,
  provisionalIce,
  recordConnectionStates,
  recordIceCandidates,
  recordIceConnectionStates,
  removeIceAgentServers,
  sectionOf,
  sendAndExpectData,
  sendAndExpectRtp,
  stubIceMdns,
  trickleCandidate,
  waitForCommittedNomination,
  waitForConnection,
  waitForEndOfCandidates,
  waitForProvisionalNomination,
  withIceCredentials,
} from "./negotiationTransactionUtils";

const ufragOf = (sdp: string) => sdp.match(/^a=ice-ufrag:(\S+)/m)![1];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type IceConnectionInternals = {
  nominated?: object;
  checkList: object[];
  provisionalNominated?: object;
  remoteCandidates: { port: number }[];
};
const iceConnection = (pc: RTCPeerConnection) =>
  pc.iceTransports[0].connection as unknown as IceConnectionInternals;

/**
 * Spec coverage of the ICE rules of the negotiation transaction ticket
 * (2.6 TURN settings, 2.7 provisional ICE generation, 2.8 ICE rules and
 * section 5 restartIce() / end-of-candidates). Test names start with the
 * requirement ID.
 */
describe("negotiation transaction spec coverage: ICE", () => {
  enforceSessionContinuation();

  test("[2.7-T4a] the final answer checks the restarted generation from scratch instead of taking the provisional nomination", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: ICE restart offer に pranswer を返し、双方の provisional generation が nominate するまで待つ。
      await offerer.setLocalDescription(
        await offerer.createOffer({ iceRestart: true }),
      );
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = (await answerer.createAnswer()).sdp;
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer });
      await offerer.setRemoteDescription({ type: "pranswer", sdp: answer });
      await Promise.all([
        waitForProvisionalNomination(offerer),
        waitForProvisionalNomination(answerer),
      ]);
      const peers = [offerer, answerer].map((pc) => ({
        pc,
        provisional: iceConnection(pc).provisionalNominated!,
        states: recordIceConnectionStates(pc),
      }));

      // Act: pranswer と同じ内容の final answer で restart を確定する。
      await answerer.setLocalDescription({ type: "answer", sdp: answer });
      await offerer.setRemoteDescription({ type: "answer", sdp: answer });
      await Promise.all([
        waitForCommittedNomination(offerer),
        waitForCommittedNomination(answerer),
      ]);

      for (const { pc, provisional, states } of peers) {
        const connection = iceConnection(pc);
        // Assert: live generation は checking を経て一から接続確認をやり直す。
        expect(states).toContain("checking");
        expect(states.indexOf("checking")).toBeLessThan(
          states.lastIndexOf("connected"),
        );
        // Assert: provisional で nominate した pair は引き継がず、新しい checklist の pair を選ぶ。
        expect(connection.nominated).toBeDefined();
        expect(connection.nominated).not.toBe(provisional);
        expect(connection.checkList).not.toContain(provisional);
        expect(connection.checkList).toContain(connection.nominated);
        // Assert: commit 後に provisional generation は残らない。
        expect(connection.provisionalNominated).toBeUndefined();
        assertNegotiationInvariants(pc);
      }
      // Assert: 確定した generation で RTP が届く。
      await sendAndExpectRtp(outgoing, incoming, "t4a-after-commit");
      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "t4a");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test.each(["a replacement offer", "a replacement ICE restart offer"])(
    "[2.7-T4b] %s ends the provisional generation of a restart pranswer and the live pair keeps carrying RTP",
    async (replacement) => {
      const { offerer, answerer, outgoing, incoming, ufrag } =
        await createIceRestartPranswer();
      try {
        // Arrange: pranswer の provisional generation が nominate するまで待ち、live pair を控える。
        await waitForProvisionalNomination(offerer);
        const live = iceConnection(offerer).nominated;

        // Act: pranswer を受けた offerer が置き換えの offer (restartIce() 後の restart offer を含む) を作って適用する。
        if (replacement === "a replacement ICE restart offer") {
          offerer.restartIce();
        }
        const offer = await offerer.createOffer();
        await offerer.setLocalDescription(offer);

        // Assert: pranswer の generation の check と nominate は終わり、live pair は変わらない。
        expect(offerer.signalingState).toBe("have-local-offer");
        expect(iceConnection(offerer).provisionalNominated).toBeUndefined();
        const provisional = provisionalIce(offerer);
        expect(provisional?.pairs ?? []).toHaveLength(0);
        expect(provisional?.remoteCandidates ?? []).toHaveLength(0);
        expect(iceConnection(offerer).nominated).toBe(live);
        expect(
          offerer.iceTransports[0].getRemoteParameters()?.usernameFragment,
        ).not.toBe(ufrag);
        assertNegotiationInvariants(offerer);
        await sendAndExpectRtp(outgoing, incoming, "t4b-after-replacement");

        // Act: answerer は pranswer を取り消し、置き換えの offer に answer して確定する。
        await answerer.setRemoteDescription({ type: "rollback" });
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);
        await Promise.all([
          waitForCommittedNomination(offerer),
          waitForCommittedNomination(answerer),
        ]);

        // Assert: 置き換えの offer の generation で確定し、RTP が届く。
        expect(ufragOf(offerer.currentLocalDescription!.sdp)).toBe(
          ufragOf(offer.sdp),
        );
        assertNegotiationInvariants(offerer);
        assertNegotiationInvariants(answerer);
        await sendAndExpectRtp(outgoing, incoming, "t4b-after-commit");
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, "t4b");
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    60000,
  );

  test("[2.8-5] an ICE restart without ICE servers puts end-of-candidates in its descriptions and trickles nothing after the commit", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers({ iceServers: [] }, { withAudio: true });
    try {
      // Arrange: 両 peer の ICE agent に問い合わせる server がない状態にし、onIceCandidate を記録する。
      removeIceAgentServers(offerer);
      removeIceAgentServers(answerer);
      const events = {
        offerer: recordIceCandidates(offerer),
        answerer: recordIceCandidates(answerer),
      };

      // Act: ICE server のない session で ICE restart を offer / answer で確定する。
      offerer.restartIce();
      const offer = await offerer.createOffer();
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offer);
      const answer = await answerer.createAnswer();
      await answerer.setLocalDescription(answer);
      await offerer.setRemoteDescription(answer);

      // Assert: restart の offer と answer は全 m-line に end-of-candidates を含む。
      for (const sdp of [offer.sdp, answer.sdp]) {
        expect(sdp.match(/^a=end-of-candidates/gm)).toHaveLength(
          sdp.match(/^m=/gm)!.length,
        );
      }
      expect(ufragOf(offerer.currentLocalDescription!.sdp)).toBe(
        ufragOf(offer.sdp),
      );

      // Act: commit 後の新 generation の接続を待ち、背景の gather が走る時間をおく。
      const signalled = {
        offerer: events.offerer.length,
        answerer: events.answerer.length,
      };
      await Promise.all([
        waitForCommittedNomination(offerer),
        waitForCommittedNomination(answerer),
      ]);
      await sleep(500);

      for (const pc of ["offerer", "answerer"] as const) {
        // Assert: commit 後に追加の候補も end-of-candidates も trickle されない。
        expect(events[pc]).toHaveLength(signalled[pc]);
        // Assert: end-of-candidates は generation ごとに高々一度。
        expect(
          events[pc].filter((candidate) => candidate === undefined).length,
        ).toBeLessThanOrEqual(1);
      }
      expect(offerer.iceGatheringState).toBe("complete");
      expect(answerer.iceGatheringState).toBe("complete");
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "2.8-5-after-restart");
      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "2.8-5");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test.each(["connected", "failed"] as const)(
    "[2.8-27] an answer that starts no connection work leaves a %s connectionState unchanged",
    async (state) => {
      const { offerer, answerer } = await createConnectedVideoPeers();
      try {
        // Arrange: 確立済みの session (failed の場合は offerer の ICE generation を consent 失効相当で failed にする)。
        if (state === "failed") forceIceState(offerer, "failed");
        const peers = [offerer, answerer].map((pc) => ({
          pc,
          before: {
            connection: pc.connectionState,
            ice: pc.iceConnectionState,
          },
          connectionStates: recordConnectionStates(pc),
          iceStates: recordIceConnectionStates(pc),
        }));
        expect(offerer.connectionState).toBe(state);

        // Act: ICE restart も新しい transport も含まない再交渉を answer まで行う。
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);
        await sleep(200);

        for (const { pc, before, connectionStates, iceStates } of peers) {
          // Assert: 接続処理を始めも待ちもしないので、connectionState も ICE の状態も変わらず通知もない。
          expect(pc.connectionState).toBe(before.connection);
          expect(pc.iceConnectionState).toBe(before.ice);
          expect(connectionStates).toEqual([]);
          expect(iceStates).toEqual([]);
          assertNegotiationInvariants(pc);
        }
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, `2.8-27-${state}`);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    60000,
  );

  test("[2.8-29] end-of-candidates on a non-tag m-line completes the provisional generation of a restart pranswer for its whole BUNDLE group", async () => {
    const { offerer, answerer, outgoing, incoming, ufrag, video, audio } =
      await createBundledIceRestartPranswer();
    try {
      // Arrange: pranswer は end-of-candidates を含まず、provisional generation は未完了。
      expect(provisionalIce(offerer)!.remoteCandidatesEnd).toBe(false);

      // Act: BUNDLE の非 tag (audio) m-line に restart generation の end-of-candidates を trickle する。
      await offerer.addIceCandidate({
        candidate: "",
        sdpMid: audio,
        usernameFragment: ufrag,
      });

      // Assert: provisional generation が完了し、pending SDP の group の全 m-line が end-of-candidates を持つ。
      const provisional = provisionalIce(offerer)!;
      expect(provisional.remoteCandidatesEnd).toBe(true);
      const pending = offerer.pendingRemoteDescription!.sdp;
      expect(sectionOf(pending, video)).toContain("a=end-of-candidates");
      expect(sectionOf(pending, audio)).toContain("a=end-of-candidates");
      assertNegotiationInvariants(offerer);

      // Act: その後に tag (video) m-line へ同じ generation の候補が届く。
      const candidates = provisional.remoteCandidates.length;
      await offerer.addIceCandidate(trickleCandidate(50996, ufrag, video));

      // Assert: 完了した generation の候補は pending SDP にも provisional checklist にも入らない。
      expect(offerer.pendingRemoteDescription!.sdp).not.toContain(" 50996 ");
      expect(provisional.remoteCandidates).toHaveLength(candidates);
      expect(
        provisional.pairs.some((pair) => pair.remoteCandidate.port === 50996),
      ).toBe(false);
      assertNegotiationInvariants(offerer);
      // Assert: live pair の RTP は続く。
      await sendAndExpectRtp(outgoing, incoming, "2.8-29-provisional-eoc");
      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "2.8-29");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test.each(["offerer", "answerer"] as const)(
    "[2.8-35] after the %s rolls back a first pranswer connection it reports no later state of that connection",
    async (side) => {
      const { offerer, answerer, close } =
        await createInitialPranswerConnection();
      try {
        // Arrange: 初回 pranswer で両 peer が接続済みと報告している。
        await Promise.all([
          waitForConnection(offerer),
          waitForConnection(answerer),
        ]);
        const [rolling, peer] =
          side === "offerer" ? [offerer, answerer] : [answerer, offerer];

        // Act: 片側で初回交渉を rollback する。
        if (side === "offerer") {
          await offerer.setLocalDescription({ type: "rollback" });
        } else {
          await answerer.setRemoteDescription({ type: "rollback" });
        }

        // Assert: current session がないので接続状態は new に戻る。
        expect(rolling.connectionState).toBe("new");
        expect(rolling.iceConnectionState).toBe("new");
        const connectionStates = recordConnectionStates(rolling);
        const iceStates = recordIceConnectionStates(rolling);

        // Act: 相手が提案の接続を閉じ (DTLS close / ICE の consent 喪失)、遅延処理が走る時間待つ。
        // 相手の close() 自体が検証対象の操作なので、両 peer とも継続確認の対象外にする。
        exemptFromContinuation(
          [rolling, peer],
          "close() is the operation under test",
        );
        await peer.close();
        await sleep(1500);

        // Assert: rollback した提案の接続処理は以後の状態を報告しない。
        expect(rolling.connectionState).toBe("new");
        expect(rolling.iceConnectionState).toBe("new");
        expect(connectionStates).toEqual([]);
        expect(iceStates).toEqual([]);
        expect(rolling.signalingState).toBe("stable");
      } finally {
        await close();
      }
    },
    10000,
  );

  test("[5-9] a restartIce() request survives the implicit rollback of a glare until an answer commits new credentials", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: offerer が restartIce() の offer を適用する (相手の offer と衝突する)。
      const current = ufragOf(offerer.currentLocalDescription!.sdp);
      offerer.restartIce();
      const restartOffer = await offerer.createOffer();
      await offerer.setLocalDescription(restartOffer);
      expect(ufragOf(restartOffer.sdp)).not.toBe(current);

      // Act: 相手の offer を受けて implicit rollback (glare) し、answer で確定する。
      await answerer.setLocalDescription(await answerer.createOffer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      assertNegotiationInvariants(offerer);
      await offerer.setLocalDescription(await offerer.createAnswer());
      await answerer.setRemoteDescription(offerer.localDescription!);

      // Assert: restart しない answer は current の資格情報を保つ。
      expect(offerer.signalingState).toBe("stable");
      expect(ufragOf(offerer.currentLocalDescription!.sdp)).toBe(current);
      assertNegotiationInvariants(offerer);

      // Act: glare の後に次の offer を作る。
      const retry = await offerer.createOffer();

      // Assert: 要求は glare と answer の確定を越えて残り、current と異なる資格情報を出す。
      expect(ufragOf(retry.sdp)).not.toBe(current);

      // Act: その offer で交渉を確定する。
      await offerer.setLocalDescription(retry);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await waitForCommittedNomination(offerer);

      // Assert: 新しい資格情報の確定で要求は解除され、次の offer は確定した資格情報を再利用する。
      const committed = ufragOf(offerer.currentLocalDescription!.sdp);
      expect(committed).toBe(ufragOf(retry.sdp));
      expect(ufragOf((await offerer.createOffer()).sdp)).toBe(committed);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "5-9-after-glare");
      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "5-9-glare");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("[5-9] an offer created after restartIce() while a restart offer is pending replaces the pending credentials too", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: restart offer を適用して pending にする。
      const current = ufragOf(offerer.currentLocalDescription!.sdp);
      await offerer.setLocalDescription(
        await offerer.createOffer({ iceRestart: true }),
      );
      const pending = ufragOf(offerer.pendingLocalDescription!.sdp);

      // Act: pending 中に restartIce() を呼び、次の offer を作る。
      offerer.restartIce();
      const retry = await offerer.createOffer();

      // Assert: current と pending の ufrag はどちらも置き換え対象なので、新しい資格情報を出す
      // (W3C [[LocalIceCredentialsToReplace]])。
      expect(ufragOf(retry.sdp)).not.toBe(current);
      expect(ufragOf(retry.sdp)).not.toBe(pending);

      // Act: その offer で交渉を確定する。
      await offerer.setLocalDescription(retry);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await waitForCommittedNomination(offerer);

      // Assert: 新しい資格情報で確定し、要求は解除され、RTP が届く。
      const committed = ufragOf(offerer.currentLocalDescription!.sdp);
      expect(committed).toBe(ufragOf(retry.sdp));
      expect(ufragOf((await offerer.createOffer()).sdp)).toBe(committed);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "5-9-restart-while-pending");
      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "5-9-pending");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test.each(["a replacement pranswer", "a rollback"] as const)(
    "[5-12] an mDNS candidate of a restart pranswer still resolving at %s reaches neither the SDP nor any checklist",
    async (interruption) => {
      const { offerer, answerer, outgoing, incoming, ufrag, mid } =
        await createIceRestartPranswer();
      const mdns = stubIceMdns(offerer);
      try {
        // Arrange: provisional generation の mDNS 候補を解決中にする。
        await offerer.addIceCandidate(
          trickleCandidate(50995, ufrag, mid, "peer.local"),
        );
        expect(mdns.requested).toBe(1);

        // Act: 解決前に replacement pranswer (別の資格情報) を適用するか、rollback する。
        if (interruption === "a replacement pranswer") {
          await offerer.setRemoteDescription({
            type: "pranswer",
            sdp: withIceCredentials(
              answerer.localDescription!.sdp.replace(
                /^a=end-of-candidates\r?\n/gm,
                "",
              ),
              "repl",
              "replacementpassword00000",
            ),
          });
        } else {
          await offerer.setLocalDescription({ type: "rollback" });
        }
        // Act: その後で mDNS の解決を完了させる。
        mdns.resolveAll("127.0.0.1");
        await sleep(100);

        // Assert: 解決した候補は新しい provisional checklist にも live の checklist にも入らない。
        const provisional = provisionalIce(offerer);
        expect(
          provisional?.remoteCandidates.some((c) => c.port === 50995) ?? false,
        ).toBe(false);
        expect(
          provisional?.pairs.some((p) => p.remoteCandidate.port === 50995) ??
            false,
        ).toBe(false);
        expect(
          iceConnection(offerer).remoteCandidates.some((c) => c.port === 50995),
        ).toBe(false);
        // Assert: pending / current の SDP にも入らない。
        if (interruption === "a replacement pranswer") {
          expect(provisional?.remoteCandidatesEnd).toBe(false);
          expect(offerer.pendingRemoteDescription!.sdp).not.toContain(
            " 50995 ",
          );
        } else {
          expect(offerer.pendingRemoteDescription).toBeNull();
        }
        expect(offerer.currentRemoteDescription!.sdp).not.toContain(" 50995 ");
        assertNegotiationInvariants(offerer);
        // Assert: live pair の RTP は続く。
        await sendAndExpectRtp(outgoing, incoming, `5-12-${interruption}`);
        // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
        await expectSessionContinues(offerer, answerer, `5-12-${interruption}`);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    60000,
  );

  test("[2.6-T3a] ICE servers set while an ICE restart is pending survive its rollback and apply to the next restart", async () => {
    // Arrange: TURN なしで接続済みの peer と、後から設定するローカル TURN server を用意する。
    const { offerer, answerer, channel, received } =
      await createConnectedMediaAndDataPeers();
    const turn = await createLocalTurnIceServer();
    try {
      offerer.restartIce();
      await offerer.setLocalDescription(await offerer.createOffer());

      // Act: restart offer の pending 中に TURN を設定し、その offer を rollback する。
      offerer.setConfiguration({ iceServers: turn.iceServers });
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: ICE server 設定は configuration なので rollback で戻らない。
      expect(offerer.getConfiguration().iceServers).toEqual(turn.iceServers);
      assertNegotiationInvariants(offerer);

      // Act: 次の ICE restart を確定し、commit 後に出る候補を answerer へ trickle する。
      const events = recordIceCandidates(offerer);
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

      // Assert: 次の restart は設定した TURN で集め直し、relay 候補を commit 後に trickle する。
      expect(offerSdp).not.toContain("typ relay");
      expect(committed.some((c) => c?.candidate.includes("typ relay"))).toBe(
        true,
      );
      expect(committed.at(-1)).toBeUndefined();
      expect(
        answerer.iceTransports[0]
          .getRemoteCandidates()
          .some((c) => c.candidate.includes("typ relay")),
      ).toBe(true);
      // Assert: 新しい generation が nominate され、DataChannel が通信できる。
      await waitForCommittedNomination(offerer);
      assertNegotiationInvariants(offerer);
      await sendAndExpectData(channel, received, "2.6-T3a-after-restart");
      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "2.6-T3a");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
      await turn.server.close();
    }
  }, 60000);

  test("[2.6-T3b] ICE servers set after a restart offer was created apply to that restart's gathering at its commit", async () => {
    // Arrange: TURN なしで接続済みの peer で、restartIce() の offer を作って restart を stage する。
    const { offerer, answerer, channel, received } =
      await createConnectedMediaAndDataPeers();
    const turn = await createLocalTurnIceServer();
    const events = recordIceCandidates(offerer);
    try {
      offerer.restartIce();
      const offer = await offerer.createOffer();

      // Act: stage した後に TURN を設定し、その offer を適用して answer で確定する。
      offerer.setConfiguration({ iceServers: turn.iceServers });
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      const committedFrom = events.length;
      await offerer.setRemoteDescription(answerer.localDescription!);
      await waitForEndOfCandidates(events);
      const committed = events.slice(committedFrom);
      for (const candidate of committed) {
        await answerer.addIceCandidate(candidate?.toJSON() ?? null);
      }

      // Assert: offer は relay も end-of-candidates も含まず、commit 後の背景 gather が新しい TURN の relay 候補を trickle する (JSEP 4.1.18)。
      expect(offer.sdp).not.toContain("typ relay");
      expect(offer.sdp).not.toContain("a=end-of-candidates");
      expect(committed.some((c) => c?.candidate.includes("typ relay"))).toBe(
        true,
      );
      expect(committed.at(-1)).toBeUndefined();
      expect(
        answerer.iceTransports[0]
          .getRemoteCandidates()
          .some((c) => c.candidate.includes("typ relay")),
      ).toBe(true);
      // Assert: 新しい generation が nominate され、DataChannel が通信できる。
      await waitForCommittedNomination(offerer);
      assertNegotiationInvariants(offerer);
      await sendAndExpectData(channel, received, "2.6-T3b-after-restart");
      // Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
      await expectSessionContinues(offerer, answerer, "2.6-T3b");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
      await turn.server.close();
    }
  }, 60000);
});
