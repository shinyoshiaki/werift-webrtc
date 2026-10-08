import { vi } from "vitest";

import { RTCDataChannel, RTCDataChannelParameters } from "../../src";
import { SctpTransportManager } from "../../src/sctpManager";
import {
  assertNegotiationInvariants,
  createConnectedVideoPeers,
  createUnstartedSctpPair,
  exchangeOfferAnswer,
  exchangePranswer,
  muteSctpReceive,
  negotiateAndExpectChannel,
  negotiateLateDataChannel,
  recordConnectionStates,
  rejectApplicationSection,
  sctpAssociationOf,
  sendAndExpectData,
  waitForChannelState,
  waitForSctpState,
  watchSctpRestart,
} from "./negotiationTransactionUtils";

const ESTABLISHED = 4;

describe("SCTP added by renegotiation after DTLS is connected", () => {
  test.each([
    ["the original answerer (ICE controlled) re-offers", "answerer"],
    ["the original offerer (ICE controlling) re-offers", "offerer"],
  ] as const)(
    "%s",
    async (_, reofferer) => {
      // Arrange: video だけで接続済みのセッション (SCTP なし)。
      const peers = await createConnectedVideoPeers();
      const { offerer, answerer } = peers;
      const [from, to] =
        reofferer === "offerer" ? [offerer, answerer] : [answerer, offerer];
      try {
        expect(offerer.iceTransports[0].role).toBe("controlling");
        expect(answerer.iceTransports[0].role).toBe("controlled");
        expect(offerer.sctpTransport).toBeUndefined();
        expect(answerer.sctpTransport).toBeUndefined();
        const states = [
          recordConnectionStates(offerer),
          recordConnectionStates(answerer),
        ];

        // Act: 片側で DataChannel を作り、offer/answer を 1 往復する。
        const { local, remote } = await negotiateLateDataChannel(from, to);

        // Assert: 既存の DTLS を共有したまま両側の association が確立する。
        for (const pc of [offerer, answerer]) {
          expect(pc.dtlsTransports).toHaveLength(1);
          expect(pc.sctpTransport!.dtlsTransport).toBe(pc.dtlsTransports[0]);
          expect(sctpAssociationOf(pc).state).toBe("connected");
          expect(sctpAssociationOf(pc).associationState).toBe(ESTABLISHED);
          assertNegotiationInvariants(pc);
        }
        // Assert: 双方向に送受信できる。
        await sendAndExpectData(local, remote, "late-forward");
        await sendAndExpectData(remote, local, "late-backward");
        // Assert: 再交渉で connectionState は揺れない (シナリオ G)。
        expect(states).toEqual([[], []]);
        expect(offerer.connectionState).toBe("connected");
        expect(answerer.connectionState).toBe("connected");
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    15000,
  );

  test("negotiated DataChannels on both ends open on a late association", async () => {
    // Arrange: 接続済みのセッションで両側が negotiated channel を作る。
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      const options = {
        negotiated: true,
        id: 2,
        ordered: false,
        maxRetransmits: 0,
      };
      const offererChannel = offerer.createDataChannel("late", options);
      const answererChannel = answerer.createDataChannel("late", options);

      // Act: 再交渉で m=application を追加する。
      await exchangeOfferAnswer(offerer, answerer);

      // Assert: 両側の negotiated channel が open になり、送受信できる。
      await waitForChannelState(offererChannel, "open");
      await waitForChannelState(answererChannel, "open");
      await sendAndExpectData(offererChannel, answererChannel, "negotiated-1");
      await sendAndExpectData(answererChannel, offererChannel, "negotiated-2");
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("an association the remote established first is not restarted by the local answer", async () => {
    // Arrange: controlling 側が re-offer し、answer を先に受け取って INIT を送る。
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      const remote = answerer.onDataChannel.watch((c) => c.label === "late");
      const local = offerer.createDataChannel("late");
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();
      await offerer.setRemoteDescription(answer);
      await waitForSctpState(
        answerer,
        (association) => association.state === "connected",
        "remote INIT did not establish the passive association",
      );
      const passive = watchSctpRestart(answerer);
      expect(passive.association.started).toBe(false);

      // Act: 通常の post-negotiation 経路 (local answer の commit) を走らせる。
      await answerer.setLocalDescription(answer);

      // Assert: 2 回目の INIT を送らず、connecting にも COOKIE_WAIT にも戻らない。
      expect(passive.inits).toBe(0);
      expect(passive.connecting).toBe(0);
      expect(passive.association.state).toBe("connected");
      expect(passive.association.associationState).toBe(ESTABLISHED);
      expect(sctpAssociationOf(answerer)).toBe(passive.association);
      passive.dispose();

      // Assert: in-band channel が双方向に通る。
      await waitForChannelState(local, "open");
      const [received] = await remote;
      await sendAndExpectData(local, received, "passive-forward");
      await sendAndExpectData(received, local, "passive-backward");
      // Assert: passive 側から作った in-band channel も偶数 ID で採番される。
      const fromPassive = offerer.onDataChannel.watch(
        (c) => c.label === "from-passive",
      );
      const passiveChannel = answerer.createDataChannel("from-passive");
      await waitForChannelState(passiveChannel, "open");
      expect(passiveChannel.id! % 2).toBe(0);
      const [passiveRemote] = await fromPassive;
      await sendAndExpectData(passiveChannel, passiveRemote, "even-id");
      // Assert: negotiated channel も送受信できる。
      const negotiated = { negotiated: true, id: 8 };
      const a = offerer.createDataChannel("negotiated", negotiated);
      const b = answerer.createDataChannel("negotiated", negotiated);
      await waitForChannelState(a, "open");
      await waitForChannelState(b, "open");
      await sendAndExpectData(b, a, "negotiated-after-passive");
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("connectSctp is idempotent on an ICE controlling association established passively", async () => {
    // Arrange: controlled 側を SCTP client として先に INIT させ、controlling 側は未 start のまま確立させる。
    const pair = await createUnstartedSctpPair();
    const { local, remote } = pair;
    try {
      remote.sctp.isServer = false;
      await remote.sctp.start(local.port);
      const manager = new SctpTransportManager();
      manager.sctpTransport = local;
      manager.sctpRemotePort = remote.port;
      await local.sctp.stateChanged.connected.asPromise();
      expect(local.sctp.started).toBe(false);
      const sendChunk = vi.spyOn(local.sctp, "sendChunk");
      let connecting = 0;
      local.sctp.stateChanged.connecting.subscribe(() => connecting++);

      // Act: 起動経路を何度も呼ぶ。
      await manager.connectSctp();
      await manager.connectSctp();

      // Assert: INIT を送らず state も戻らない。
      expect(
        sendChunk.mock.calls.filter(([chunk]) => chunk.type === 1 /* INIT */),
      ).toHaveLength(0);
      expect(connecting).toBe(0);
      expect(local.sctp.state).toBe("connected");
      expect(local.sctp.associationState).toBe(ESTABLISHED);

      // Act: 両側から in-band channel を開く (remote は start を経由していない)。
      const fromRemote = local.onDataChannel.asPromise().then(([c]) => c);
      const fromLocal = remote.onDataChannel.asPromise().then(([c]) => c);
      const localChannel = new RTCDataChannel(
        local,
        new RTCDataChannelParameters({ label: "controlling" }),
      );
      const remoteChannel = new RTCDataChannel(
        remote,
        new RTCDataChannelParameters({ label: "controlled" }),
      );

      // Assert: controlling は奇数、controlled は偶数 ID で採番され、送受信できる。
      await waitForChannelState(localChannel, "open");
      await waitForChannelState(remoteChannel, "open");
      expect(localChannel.id! % 2).toBe(1);
      expect(remoteChannel.id! % 2).toBe(0);
      await sendAndExpectData(localChannel, await fromLocal, "to-controlled");
      await sendAndExpectData(
        remoteChannel,
        await fromRemote,
        "to-controlling",
      );
    } finally {
      await pair.close();
    }
  }, 15000);

  test("connectSctp settles when the remote never answers because the INIT retries give up", async () => {
    // Arrange: 相手の SCTP 受信を止め、INIT に一切応答しない状態にする。
    const pair = await createUnstartedSctpPair();
    const { local, remote } = pair;
    try {
      remote.dtlsTransport.dataReceiver = () => {};
      const manager = new SctpTransportManager();
      manager.sctpTransport = local;
      manager.sctpRemotePort = remote.port;
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setImmediate"],
      });

      // Act: 起動を待ち始め、INIT 再送の上限 (T1) まで時間を進める。
      let settled = false;
      const connecting = manager.connectSctp().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: 再送が続く間は待機中のまま。
      expect(settled).toBe(false);
      expect(local.sctp.state).toBe("connecting");

      // Act: INIT 再送が尽きるまで進める。
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await connecting;

      // Assert: association が closed になり、待機が有限時間で解消する。
      expect(settled).toBe(true);
      expect(local.sctp.state).toBe("closed");
    } finally {
      vi.useRealTimers();
      await pair.close();
    }
  }, 15000);

  test("another offer / answer on the same application section keeps the association", async () => {
    // Arrange: 後付け SCTP で channel を開く。
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      const { local, remote } = await negotiateLateDataChannel(
        answerer,
        offerer,
      );
      const watches = [watchSctpRestart(offerer), watchSctpRestart(answerer)];

      // Act: 同じ application section のまま両方向で再交渉する。
      await exchangeOfferAnswer(offerer, answerer);
      await exchangeOfferAnswer(answerer, offerer);

      // Assert: association を再起動せず、channel は open のまま通る。
      for (const watch of watches) {
        expect(watch.inits).toBe(0);
        expect(watch.connecting).toBe(0);
        watch.dispose();
      }
      expect(sctpAssociationOf(offerer)).toBe(watches[0].association);
      expect(sctpAssociationOf(answerer)).toBe(watches[1].association);
      expect(local.readyState).toBe("open");
      await sendAndExpectData(local, remote, "same-section");
      await sendAndExpectData(remote, local, "same-section-back");
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("an ICE restart keeps a late association open", async () => {
    // Arrange: 後付け SCTP で channel を開く。
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      const { local, remote } = await negotiateLateDataChannel(
        offerer,
        answerer,
      );
      const watches = [watchSctpRestart(offerer), watchSctpRestart(answerer)];

      // Act: ICE restart を交渉する。
      await offerer.setLocalDescription(
        await offerer.createOffer({ iceRestart: true }),
      );
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: SCTP は再起動されず、channel は開いたまま通る。
      await sendAndExpectData(local, remote, "after-restart");
      await sendAndExpectData(remote, local, "after-restart-back");
      for (const watch of watches) {
        expect(watch.inits).toBe(0);
        expect(watch.connecting).toBe(0);
        watch.dispose();
      }
      expect(local.readyState).toBe("open");
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 20000);

  test("bundlePolicy disable starts a late association on its own DTLS transport", async () => {
    // Arrange: BUNDLE なしで video だけ接続する。
    const { offerer, answerer } = await createConnectedVideoPeers({
      bundlePolicy: "disable",
    });
    try {
      // Act: DataChannel を後付けで交渉する。
      const { local, remote } = await negotiateLateDataChannel(
        offerer,
        answerer,
      );

      // Assert: video とは別の DTLS transport で association が確立する。
      const videoTransport = offerer.getTransceivers()[0].dtlsTransport;
      expect(offerer.sctpTransport!.dtlsTransport).not.toBe(videoTransport);
      await sendAndExpectData(local, remote, "unbundled");
      await sendAndExpectData(remote, local, "unbundled-back");
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);
});

describe("late SCTP under pranswer", () => {
  test("a pranswer starts it and the final answer keeps it", async () => {
    // Arrange: 接続済みセッションで後付け m=application を pranswer まで進める。
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      const remote = answerer.onDataChannel.watch((c) => c.label === "late");
      const local = offerer.createDataChannel("late");
      const states = recordConnectionStates(offerer);

      // Act: pranswer を適用する。
      const answer = await exchangePranswer(offerer, answerer);

      // Assert: pranswer の時点で channel が open になり、送受信できる。
      await waitForChannelState(local, "open");
      const [received] = await remote;
      await sendAndExpectData(local, received, "provisional");
      await sendAndExpectData(received, local, "provisional-back");

      // Act: 同じ sctp-port の final answer で確定する。
      const watches = [watchSctpRestart(offerer), watchSctpRestart(answerer)];
      await answerer.setLocalDescription({ type: "answer", sdp: answer });
      await offerer.setRemoteDescription({ type: "answer", sdp: answer });

      // Assert: association は継続し、再起動しない。
      for (const watch of watches) {
        expect(watch.inits).toBe(0);
        expect(watch.connecting).toBe(0);
        watch.dispose();
      }
      await sendAndExpectData(local, received, "committed");
      expect(states).toEqual([]);
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("rollback after a pranswer discards the pending-only association", async () => {
    // Arrange: createOffer 前に作った channel を pranswer で開く (transport は baseline に含まれる)。
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      const remote = answerer.onDataChannel.watch((c) => c.label === "late");
      const local = offerer.createDataChannel("late");
      const transport = offerer.sctpTransport;
      await exchangePranswer(offerer, answerer);
      await waitForChannelState(local, "open");
      const [received] = await remote;
      const discarded = sctpAssociationOf(offerer);

      // Act: offerer 側を rollback する。
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: attach 済み channel が閉じ、remote 側も ABORT で閉じる。
      expect(local.readyState).toBe("closed");
      await waitForChannelState(received, "closed");
      expect(discarded.state).toBe("closed");

      // Act: answerer 側も rollback する。
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: application-owned の transport は未交渉・初期状態の association で残る。
      expect(offerer.sctpTransport).toBe(transport);
      expect(offerer.sctpTransport!.mid).toBeUndefined();
      expect(offerer.sctpRemotePort).toBeUndefined();
      expect(sctpAssociationOf(offerer)).not.toBe(discarded);
      expect(offerer.sctpTransport!.associationActive).toBe(false);
      expect(answerer.sctpTransport).toBeUndefined();
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);

      // Act / Assert: 次の交渉では新しい association で channel が開く。
      const next = offerer.createDataChannel("after-rollback");
      await negotiateAndExpectChannel(offerer, answerer, next);
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("an unattached channel survives the rollback and opens at the next negotiation", async () => {
    // Arrange: remote が応答しないため stream ID を割当てられないまま pranswer で起動する。
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      const queued = offerer.createDataChannel("queued");
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      muteSctpReceive(answerer);
      const answer = await answerer.createAnswer();
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await offerer.setRemoteDescription({ type: "pranswer", sdp: answer.sdp });
      expect(sctpAssociationOf(offerer).started).toBe(true);

      // Act: 両側を rollback する。
      await offerer.setLocalDescription({ type: "rollback" });
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: 未 attach の channel は connecting のまま残り、association は初期状態。
      expect(queued.readyState).toBe("connecting");
      expect(queued.id).toBeUndefined();
      expect(offerer.sctpTransport!.associationActive).toBe(false);
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);

      // Act: rollback 後に作った channel と一緒に再交渉する。
      const queuedRemote = answerer.onDataChannel.watch(
        (c) => c.label === "queued",
      );
      const next = offerer.createDataChannel("after-rollback");
      await negotiateAndExpectChannel(offerer, answerer, next);

      // Assert: 持ち越した channel も新しい association で双方向に通る。
      await waitForChannelState(queued, "open");
      const [received] = await queuedRemote;
      await sendAndExpectData(queued, received, "carried-over");
      await sendAndExpectData(received, queued, "carried-over-back");
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("a passive association established during the pranswer is discarded by rollback", async () => {
    // Arrange: 両側が createOffer 前に channel を作る。answerer は pranswer を適用しない。
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      const offererChannel = offerer.createDataChannel("from-offerer");
      const answererChannel = answerer.createDataChannel("from-answerer");
      const answererTransport = answerer.sctpTransport;
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();
      await offerer.setRemoteDescription({ type: "pranswer", sdp: answer.sdp });
      await waitForChannelState(answererChannel, "open");
      const passive = sctpAssociationOf(answerer);
      expect(passive.started).toBe(false);
      expect(passive.state).toBe("connected");

      // Act: 両側を rollback する。
      await answerer.setRemoteDescription({ type: "rollback" });
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: started に依存せず passive association も破棄される。
      expect(answererChannel.readyState).toBe("closed");
      await waitForChannelState(offererChannel, "closed");
      expect(answerer.sctpTransport).toBe(answererTransport);
      expect(sctpAssociationOf(answerer)).not.toBe(passive);
      expect(answerer.sctpTransport!.associationActive).toBe(false);
      expect(offerer.sctpTransport!.associationActive).toBe(false);
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("a channel created while the remote offer is pending keeps its transport after rollback", async () => {
    // Arrange: have-remote-offer 中に answerer が channel を作り、offerer が応答しない状態で pranswer で起動する。
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      offerer.createDataChannel("from-offerer");
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const pending = answerer.createDataChannel("pending");
      const transport = answerer.sctpTransport;
      muteSctpReceive(offerer);
      const answer = await answerer.createAnswer();
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await offerer.setRemoteDescription({ type: "pranswer", sdp: answer.sdp });
      expect(sctpAssociationOf(answerer).started).toBe(true);

      // Act: 両側を rollback する。
      await offerer.setLocalDescription({ type: "rollback" });
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: transport は application-owned として残り、association は作り直される。
      expect(answerer.sctpTransport).toBe(transport);
      expect(answerer.sctpTransport!.associationActive).toBe(false);
      expect(answerer.sctpRemotePort).toBeUndefined();
      expect(pending.readyState).toBe("connecting");
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);

      // Act / Assert: answerer からの次の交渉で持ち越した channel が開く。
      const received = await negotiateAndExpectChannel(
        answerer,
        offerer,
        pending,
      );
      await sendAndExpectData(received, pending, "pending-back");
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("a final answer rejecting m=application closes the provisional association", async () => {
    // Arrange: pranswer で後付け channel を開く。
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      const remote = answerer.onDataChannel.watch((c) => c.label === "late");
      const local = offerer.createDataChannel("late");
      const answer = await exchangePranswer(offerer, answerer);
      await waitForChannelState(local, "open");
      const [received] = await remote;

      // Act: final answer で m=application を拒否する。
      await offerer.setRemoteDescription({
        type: "answer",
        sdp: rejectApplicationSection(answer),
      });

      // Assert: association が閉じ、attach 済み channel が closed になる。
      expect(local.readyState).toBe("closed");
      await waitForChannelState(received, "closed");
      expect(offerer.sctpRemotePort).toBeUndefined();
      expect(offerer.sctpTransport!.associationActive).toBe(false);
      assertNegotiationInvariants(offerer);
      // Assert: 相手側 (answerer) も ABORT を受けて association と channel が閉じる。
      await vi.waitFor(() =>
        expect(sctpAssociationOf(answerer).state).toBe("closed"),
      );
      expect(received.readyState).toBe("closed");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("a final answer changing the sctp-port is rejected and the association continues", async () => {
    // Arrange: pranswer で後付け channel を開く。
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      const remote = answerer.onDataChannel.watch((c) => c.label === "late");
      const local = offerer.createDataChannel("late");
      const answer = await exchangePranswer(offerer, answerer);
      await waitForChannelState(local, "open");
      const [received] = await remote;

      // Act / Assert: sctp-port を変えた final answer は検証で拒否される。
      await expect(
        offerer.setRemoteDescription({
          type: "answer",
          sdp: answer.replace(/^a=sctp-port:\d+/m, "a=sctp-port:5001"),
        }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: provisional association はそのまま通る。
      expect(offerer.signalingState).toBe("have-remote-pranswer");
      await sendAndExpectData(local, received, "port-unchanged");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);
});
