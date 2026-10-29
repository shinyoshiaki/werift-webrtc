import type { RTCIceCandidate, RTCPeerConnection } from "../../../src";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  createConnectedMediaAndDataPeers,
  createConnectedVideoPeers,
  createIceRestartPranswer,
  createInitialPranswerConnection,
  createLocalTurnIceServer,
  forceIceState,
  provisionalIce,
  recordConnectionStates,
  recordIceCandidates,
  recordIceConnectionStates,
  removeIceAgentServers,
  waitForCommittedNomination,
  waitForConnection,
  waitForEndOfCandidates,
  waitForProvisionalNomination,
} from "../harness/negotiationTransactionUtils";

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
describeCases("negotiation transaction spec coverage: ICE", () => {
  const ufragOf = (sdp: string) => sdp.match(/^a=ice-ufrag:(\S+)/m)![1];

  const trickleAll = async (
    pc: RTCPeerConnection,
    candidates: (RTCIceCandidate | undefined)[],
  ) => {
    for (const candidate of candidates) {
      await pc.addIceCandidate(candidate?.toJSON() ?? (null as never));
    }
  };

  negotiationCase(
    "[2.7-T4a] the final answer checks the restarted generation from scratch instead of taking the provisional nomination",
    { ref: "2.7-T4a" },
    async (c) => {
      const restartCheck = (
        pc: RTCPeerConnection,
        provisional: object,
        states: string[],
      ) => {
        const connection = iceConnection(pc);
        return {
          sawChecking: states.includes("checking"),
          checkingBeforeConnected:
            states.indexOf("checking") < states.lastIndexOf("connected"),
          nominated: connection.nominated !== undefined,
          tookProvisional: connection.nominated === provisional,
          provisionalInCheckList: connection.checkList.includes(provisional),
          nominatedInCheckList: connection.checkList.includes(
            connection.nominated!,
          ),
          provisionalLeft: connection.provisionalNominated !== undefined,
        };
      };

      // Arrange: ICE restart offer に pranswer を返し、双方の provisional generation が nominate するまで待つ。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers(),
      );
      await c.offer(a, { iceRestart: true });
      const answer = await c.pranswer(b, { hold: true });
      await c.setRemote(a, answer, { type: "pranswer" });
      await Promise.all([
        waitForProvisionalNomination(a),
        waitForProvisionalNomination(b),
      ]);
      const provisional = [
        iceConnection(a).provisionalNominated,
        iceConnection(b).provisionalNominated,
      ];
      const states = [
        recordIceConnectionStates(a),
        recordIceConnectionStates(b),
      ];

      // Act: pranswer と同じ内容の final answer で restart を確定する。
      await c.setLocal(b, answer, { type: "answer" });
      await c.setRemote(a, answer, { type: "answer" });
      await Promise.all([
        waitForCommittedNomination(a),
        waitForCommittedNomination(b),
      ]);

      // Assert: live generation は checking を経て一から接続確認をやり直し、provisional で nominate した pair は引き継がず新しい checklist の pair を選び、commit 後に provisional generation は残らない。
      expect(restartCheck(a, provisional[0]!, states[0])).toEqual({
        sawChecking: true,
        checkingBeforeConnected: true,
        nominated: true,
        tookProvisional: false,
        provisionalInCheckList: false,
        nominatedInCheckList: true,
        provisionalLeft: false,
      });
      expect(restartCheck(b, provisional[1]!, states[1])).toEqual({
        sawChecking: true,
        checkingBeforeConnected: true,
        nominated: true,
        tookProvisional: false,
        provisionalInCheckList: false,
        nominatedInCheckList: true,
        provisionalLeft: false,
      });
      c.invariants();

      // Assert: 確定した generation で RTP が届く。
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase.for([
    { replacement: "a replacement offer" },
    { replacement: "a replacement ICE restart offer" },
  ] as const)(
    "[2.7-T4b] $replacement ends the provisional generation of a restart pranswer and the live pair keeps carrying RTP",
    { ref: "2.7-T4b" },
    async (c, { replacement }) => {
      // Arrange: pranswer の provisional generation が nominate するまで待ち、live pair を控える。
      const { a, b, outgoing, incoming, ufrag } = await c.given(
        createIceRestartPranswer(),
      );
      await waitForProvisionalNomination(a);
      const live = iceConnection(a).nominated;

      // Act: pranswer を受けた offerer が置き換えの offer (restartIce() 後の restart offer を含む) を作って適用する。
      if (replacement === "a replacement ICE restart offer") a.restartIce();
      const offer = await c.offer(a, { hold: true });

      // Assert: pranswer の generation の check と nominate は終わり、live pair は変わらない。
      expect(a.signalingState).toEqual("have-local-offer");
      expect(iceConnection(a).provisionalNominated).toEqual(undefined);
      expect((provisionalIce(a)?.pairs || []).length).toEqual(0);
      expect((provisionalIce(a)?.remoteCandidates || []).length).toEqual(0);
      expect(iceConnection(a).nominated).toBe(live);
      expect(
        a.iceTransports[0].getRemoteParameters()?.usernameFragment,
      ).not.toBe(ufrag);
      await c.rtp(outgoing, incoming);

      // Act: answerer は pranswer を取り消し、置き換えの offer に answer して確定する。
      await c.setRemote(b, "rollback");
      await c.setRemote(b, a.localDescription);
      await c.answer(b);
      await Promise.all([
        waitForCommittedNomination(a),
        waitForCommittedNomination(b),
      ]);

      // Assert: 置き換えの offer の generation で確定し、RTP が届く。
      expect(ufragOf(a.currentLocalDescription!.sdp)).toEqual(
        ufragOf(offer.sdp),
      );
      c.invariants();
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase(
    "[2.8-5] an ICE restart without ICE servers puts end-of-candidates in its descriptions and trickles nothing after the commit",
    { ref: "2.8-5" },
    async (c) => {
      // Arrange: 両 peer の ICE agent に問い合わせる server がない状態にし、onIceCandidate を記録する。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers({ iceServers: [] }, { withAudio: true }),
      );
      removeIceAgentServers(a);
      removeIceAgentServers(b);
      const events = {
        offerer: recordIceCandidates(a),
        answerer: recordIceCandidates(b),
      };

      // Act: ICE server のない session で ICE restart を offer / answer で確定する。
      a.restartIce();
      const offer = await a.createOffer();
      await c.setLocal(a, offer);
      await c.setRemote(b, offer);
      const answer = await b.createAnswer();
      await c.setLocal(b, answer);
      await c.setRemote(a, answer);

      // Assert: restart の offer と answer は全 m-line に end-of-candidates を含む。
      expect(offer.sdp.match(/^a=end-of-candidates/gm)!.length).toEqual(
        offer.sdp.match(/^m=/gm)!.length,
      );
      expect(answer.sdp.match(/^a=end-of-candidates/gm)!.length).toEqual(
        answer.sdp.match(/^m=/gm)!.length,
      );
      expect(ufragOf(a.currentLocalDescription!.sdp)).toEqual(
        ufragOf(offer.sdp),
      );

      // Act: commit 後の新 generation の接続を待ち、背景の gather が走る時間をおく。
      const signalled = {
        offerer: events.offerer.length,
        answerer: events.answerer.length,
      };
      await Promise.all([
        waitForCommittedNomination(a),
        waitForCommittedNomination(b),
      ]);
      await c.sleep(500);

      // Assert: commit 後に追加の候補も end-of-candidates も trickle されない。
      expect(events.offerer.length).toEqual(signalled.offerer);
      expect(events.answerer.length).toEqual(signalled.answerer);

      // Assert: end-of-candidates は generation ごとに高々一度。
      expect(
        events.offerer.filter((candidate) => candidate === undefined).length,
      ).toBeLessThanOrEqual(1);
      expect(
        events.answerer.filter((candidate) => candidate === undefined).length,
      ).toBeLessThanOrEqual(1);
      expect([a.iceGatheringState, b.iceGatheringState]).toEqual([
        "complete",
        "complete",
      ]);
      c.invariants();
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase.for([{ state: "connected" }, { state: "failed" }] as const)(
    "[2.8-27] an answer that starts no connection work leaves a $state connectionState unchanged",
    { ref: "2.8-27" },
    async (c, { state }) => {
      // Arrange: 確立済みの session (failed の場合は offerer の ICE generation を consent 失効相当で failed にする)。
      const { a, b } = await c.given(createConnectedVideoPeers());
      if (state === "failed") forceIceState(a, "failed");
      const before = [a, b].map((pc) => ({
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
      }));
      const recorded = [a, b].map((pc) => ({
        connection: recordConnectionStates(pc),
        ice: recordIceConnectionStates(pc),
      }));
      expect(a.connectionState).toEqual(state);

      // Act: ICE restart も新しい transport も含まない再交渉を answer まで行う。
      await c.negotiate(a);
      await c.sleep(200);

      // Assert: 接続処理を始めも待ちもしないので、connectionState も ICE の状態も変わらず通知もない。
      expect(
        [a, b].map((pc) => ({
          connection: pc.connectionState,
          ice: pc.iceConnectionState,
        })),
      ).toEqual(before);
      expect(recorded).toEqual([
        { connection: [], ice: [] },
        { connection: [], ice: [] },
      ]);
    },
  );

  negotiationCase.for([
    { side: "offerer", rolling: "a", peer: "b" },
    { side: "answerer", rolling: "b", peer: "a" },
  ] as const)(
    "[2.8-35] after the $side rolls back a first pranswer connection it reports no later state of that connection",
    { ref: "2.8-35", timeout: 10000 },
    async (c, { side, rolling, peer }) => {
      // Arrange: 初回 pranswer で両 peer が接続済みと報告している。
      const { a, b } = await c.given(createInitialPranswerConnection());
      await Promise.all([waitForConnection(a), waitForConnection(b)]);

      // Act: 片側で初回交渉を rollback する。
      if (side === "offerer") await c.setLocal(a, "rollback");
      else await c.setRemote(b, "rollback");

      // Assert: current session がないので接続状態は new に戻る。
      expect([
        c.named(rolling).connectionState,
        c.named(rolling).iceConnectionState,
      ]).toEqual(["new", "new"]);
      const connectionStates = recordConnectionStates(c.named(rolling));
      const iceStates = recordIceConnectionStates(c.named(rolling));

      // Act: 相手が提案の接続を閉じ (DTLS close / ICE の consent 喪失)、遅延処理が走る時間待つ。相手の close() 自体が検証対象の操作なので、両 peer とも継続確認の対象外にする。
      c.exempt("close() is the operation under test");
      await c.named(peer).close();
      await c.sleep(1500);

      // Assert: rollback した提案の接続処理は以後の状態を報告しない。
      expect([
        c.named(rolling).connectionState,
        c.named(rolling).iceConnectionState,
      ]).toEqual(["new", "new"]);
      expect(connectionStates).toEqual([]);
      expect(iceStates).toEqual([]);
      expect(c.named(rolling).signalingState).toEqual("stable");
    },
  );

  negotiationCase(
    "[2.6-T3a] ICE servers set while an ICE restart is pending survive its rollback and apply to the next restart",
    { ref: "2.6-T3a" },
    async (c) => {
      // Arrange: TURN なしで接続済みの peer と、後から設定するローカル TURN server を用意する。
      const { a, b, channel, received } = await c.given(
        createConnectedMediaAndDataPeers(),
      );
      const turn = await createLocalTurnIceServer();
      c.closing(turn.server);
      a.restartIce();
      await c.offer(a, { hold: true });

      // Act: restart offer の pending 中に TURN を設定し、その offer を rollback する。
      a.setConfiguration({ iceServers: turn.iceServers });
      await c.setLocal(a, "rollback");

      // Assert: ICE server 設定は configuration なので rollback で戻らない。
      expect(a.getConfiguration().iceServers).toEqual(turn.iceServers);

      // Act: 次の ICE restart を確定し、commit 後に出る候補を answerer へ trickle する。
      const events = recordIceCandidates(a);
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

      // Assert: 次の restart は設定した TURN で集め直し、relay 候補を commit 後に trickle する。
      expect(offerSdp).not.toContain("typ relay");
      expect(
        committed.some((candidate) =>
          candidate?.candidate.includes("typ relay"),
        ),
      ).toBe(true);
      expect(committed.at(-1)).toBe(undefined);
      expect(
        b.iceTransports[0]
          .getRemoteCandidates()
          .some((candidate) => candidate.candidate.includes("typ relay")),
      ).toBe(true);

      // Assert: 新しい generation が nominate され、DataChannel が通信できる。
      await waitForCommittedNomination(a);
      c.invariants(a);
      await c.data(channel, received);
    },
  );

  negotiationCase(
    "[2.6-T3b] ICE servers set after a restart offer was created apply to that restart's gathering at its commit",
    { ref: "2.6-T3b" },
    async (c) => {
      // Arrange: TURN なしで接続済みの peer で、restartIce() の offer を作って restart を stage する。
      const { a, b, channel, received } = await c.given(
        createConnectedMediaAndDataPeers(),
      );
      const turn = await createLocalTurnIceServer();
      c.closing(turn.server);
      const events = recordIceCandidates(a);
      a.restartIce();
      const offer = await a.createOffer();

      // Act: stage した後に TURN を設定し、その offer を適用して answer で確定する。
      a.setConfiguration({ iceServers: turn.iceServers });
      await c.setLocal(a, offer);
      await c.setRemote(b, a.localDescription);
      await c.answer(b, { hold: true });
      const committedFrom = events.length;
      await c.setRemote(a, b.localDescription);
      await waitForEndOfCandidates(events);
      const committed = events.slice(committedFrom);
      await trickleAll(b, committed);

      // Assert: offer は relay も end-of-candidates も含まず、commit 後の背景 gather が新しい TURN の relay 候補を trickle する (JSEP 4.1.18)。
      expect(offer.sdp).not.toContain("typ relay");
      expect(offer.sdp).not.toContain("a=end-of-candidates");
      expect(
        committed.some((candidate) =>
          candidate?.candidate.includes("typ relay"),
        ),
      ).toBe(true);
      expect(committed.at(-1)).toBe(undefined);
      expect(
        b.iceTransports[0]
          .getRemoteCandidates()
          .some((candidate) => candidate.candidate.includes("typ relay")),
      ).toBe(true);

      // Assert: 新しい generation が nominate され、DataChannel が通信できる。
      await waitForCommittedNomination(a);
      c.invariants(a);
      await c.data(channel, received);
    },
  );
});
