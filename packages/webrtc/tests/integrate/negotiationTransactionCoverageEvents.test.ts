import { MediaStream, MediaStreamTrack, RTCPeerConnection } from "../../src";
import {
  assertNegotiationInvariants,
  assertTransportsClosed,
  createDuplexSession,
  createInitialPranswerDataChannel,
  createKeptRemoteTransceiver,
  createMutationSession,
  createSplitOffer,
  expectDataAlive,
  expectSessionAlive,
  heldTransports,
  holdIncomingDcep,
  negotiate,
  prepareMutationAnswerer,
  recordNegotiationEvents,
  registeredDataChannels,
  sendAndExpectData,
  sendAndExpectRtp,
  step,
  waitForDtlsConnected,
  waitForMutationSession,
  waitForPeersConnected,
  waitForProvisionalNomination,
  waitUntil,
} from "./negotiationTransactionUtils";

/**
 * Observable events and speculative object lifetime of a negotiation
 * transaction (TICKET 2.1 replacement/rollback row, 2.3 and 5-4).
 */
describe("negotiation transaction events and object lifetime", () => {
  const cleanups: (() => Promise<unknown>)[] = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((close) => close()));
  });

  async function duplex() {
    const session = await createDuplexSession();
    cleanups.push(session.close);
    return session;
  }

  async function initialPranswerDataChannel(label?: string) {
    const peers = await createInitialPranswerDataChannel(label);
    cleanups.push(peers.close);
    return peers;
  }

  /** Candidates signalled more than once (same m-line and candidate line). */
  function repeatedCandidates(
    candidates: ReturnType<typeof recordNegotiationEvents>["candidates"],
  ) {
    const keys = candidates
      .filter((candidate) => candidate !== undefined)
      .map((candidate) => `${candidate!.sdpMid} ${candidate!.candidate}`);
    return keys.filter((key, index) => keys.indexOf(key) !== index);
  }

  /** Transports `pc` holds now that were not in `before`. */
  function addedTransports(
    pc: RTCPeerConnection,
    before: ReturnType<typeof heldTransports>,
  ) {
    return [...heldTransports(pc)].filter((t) => !before.has(t));
  }

  test("[2.1-T6] a replacement offer and its rollback repeat no delivered event and close the replacement's pending-only transports", async () => {
    // Arrange: 接続済み session の b で発火する通知を記録し、a に audio を足した offer A を b に適用する。
    const session = await duplex();
    const { a, b } = session;
    const aEvents = recordNegotiationEvents(a.pc);
    const bEvents = recordNegotiationEvents(b.pc);
    const before = { a: heldTransports(a.pc), b: heldTransports(b.pc) };
    const audioOut = new MediaStreamTrack({ kind: "audio" });
    const audio = a.pc.addTransceiver(audioOut, { direction: "sendonly" });
    await step(session, async () =>
      a.pc.setLocalDescription(await a.pc.createOffer()),
    );
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );
    expect(bEvents.remoteTransceivers).toHaveLength(1);
    expect(bEvents.tracks).toHaveLength(1);
    const remoteAudio = bEvents.remoteTransceivers[0];

    // Act: 同じ m-line を BUNDLE から外す replacement offer B を両側に適用し、b は answer 用 transport を準備する。
    const offerB = await createSplitOffer(a.pc, audio.mid!);
    await step(session, () =>
      a.pc.setLocalDescription({ type: "offer", sdp: offerB }),
    );
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );
    await step(session, () => b.pc.createAnswer());

    // Assert: A で通知済みの transceiver/track は B で再通知されず、同じ object のまま。
    expect(bEvents.remoteTransceivers).toEqual([remoteAudio]);
    expect(bEvents.tracks).toHaveLength(1);
    expect(b.pc.getTransceivers()).toContain(remoteAudio);
    // Assert: B は両側に pending-only の transport を作っている。
    const pendingOnly = {
      a: addedTransports(a.pc, before.a),
      b: addedTransports(b.pc, before.b),
    };
    expect(pendingOnly.a.length).toBeGreaterThan(0);
    expect(pendingOnly.b.length).toBeGreaterThan(0);

    // Act: 両側で rollback する。
    await step(session, () => a.pc.setLocalDescription({ type: "rollback" }));
    await step(session, () => b.pc.setRemoteDescription({ type: "rollback" }));

    // Assert: rollback は通知を増やさず、remote-only の transceiver を除外する。
    expect(bEvents.remoteTransceivers).toEqual([remoteAudio]);
    expect(bEvents.tracks).toHaveLength(1);
    expect(b.pc.getTransceivers()).not.toContain(remoteAudio);
    expect(remoteAudio.stopped).toBe(true);
    // Assert: B の pending-only transport は ICE/DTLS とも閉じている。
    assertTransportsClosed([...pendingOnly.a, ...pendingOnly.b]);
    // Assert: 同一 generation の同じ候補は二度通知されない。
    expect(repeatedCandidates(aEvents.candidates)).toEqual([]);
    expect(repeatedCandidates(bEvents.candidates)).toEqual([]);
    await expectSessionAlive(session, "t6-after-rollback");

    // Act: rollback 後に B を適用し直す。
    await step(session, () =>
      a.pc.setLocalDescription({ type: "offer", sdp: offerB }),
    );
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );

    // Assert: 除外済み transceiver の代わりに新しい object が正当な新規通知として 1 回ずつ出る。
    expect(bEvents.remoteTransceivers).toHaveLength(2);
    expect(bEvents.tracks).toHaveLength(2);
    const reapplied = bEvents.remoteTransceivers[1];
    expect(reapplied).not.toBe(remoteAudio);
    expect(bEvents.tracks[1].transceiver).toBe(reapplied);

    // Act: B を final answer で確定する。
    await step(session, async () =>
      b.pc.setLocalDescription(await b.pc.createAnswer()),
    );
    await step(session, () =>
      a.pc.setRemoteDescription(b.pc.localDescription!),
    );

    // Assert: commit は通知を重ねず、分離した audio と既存 session が通信する。
    expect(bEvents.remoteTransceivers).toHaveLength(2);
    expect(bEvents.tracks).toHaveLength(2);
    expect(repeatedCandidates(aEvents.candidates)).toEqual([]);
    expect(repeatedCandidates(bEvents.candidates)).toEqual([]);
    await waitForDtlsConnected(reapplied.dtlsTransport!);
    await sendAndExpectRtp(audioOut, reapplied.receiver.track, "t6-audio");
    await expectSessionAlive(session, "t6-after-commit");
  }, 20000);

  test("[2.3-1] a remote pranswer fires ontrack once before the final answer", async () => {
    // Arrange: 受信専用 video の初回 offer に、answerer が送信する pranswer を用意する。
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    cleanups.push(() =>
      Promise.allSettled([offerer.close(), answerer.close()]),
    );
    const events = recordNegotiationEvents(offerer);
    const receiving = offerer.addTransceiver("video", {
      direction: "recvonly",
    });
    await offerer.setLocalDescription(await offerer.createOffer());
    await answerer.setRemoteDescription(offerer.localDescription!);
    const outgoing = new MediaStreamTrack({ kind: "video" });
    const sending = answerer.getTransceivers()[0];
    sending.direction = "sendonly";
    await sending.sender.replaceTrack(outgoing);
    const pranswer = (await answerer.createAnswer()).sdp;
    await answerer.setLocalDescription({ type: "pranswer", sdp: pranswer });
    expect(events.tracks).toHaveLength(0);

    // Act: offerer が remote pranswer を適用する。
    await offerer.setRemoteDescription({ type: "pranswer", sdp: pranswer });
    assertNegotiationInvariants(offerer);

    // Assert: final answer 前に receiver の track が 1 回通知され、current は空のまま。
    expect(events.tracks).toHaveLength(1);
    expect(events.tracks[0].transceiver).toBe(receiving);
    expect(events.tracks[0].receiver).toBe(receiving.receiver);
    expect(events.tracks[0].track).toBe(receiving.receiver.track);
    expect(offerer.currentRemoteDescription).toBeNull();
    // Assert: 通知した track に暫定 RTP が届く。
    await waitForPeersConnected(offerer, answerer);
    await sendAndExpectRtp(outgoing, receiving.receiver.track, "pranswer-rtp");

    // Act: 同じ内容の final answer で確定する。
    await answerer.setLocalDescription({ type: "answer", sdp: pranswer });
    await offerer.setRemoteDescription({ type: "answer", sdp: pranswer });
    assertNegotiationInvariants(offerer);
    assertNegotiationInvariants(answerer);

    // Assert: final answer は同じ receiver を再通知しない。
    expect(events.tracks).toHaveLength(1);
    await sendAndExpectRtp(outgoing, receiving.receiver.track, "answer-rtp");
  }, 15000);

  test("[2.3-2] rollback keeps the receiver and track and restores the last-stable stream association", async () => {
    // Arrange: video に stream "stable-stream" を付けて確定し、別 stream へ移す re-offer を用意する。
    const session = await duplex();
    const { a, b } = session;
    a.video.sender.setStreams([new MediaStream({ id: "stable-stream" })]);
    await negotiate(session, a, b);
    const events = recordNegotiationEvents(b.pc);
    const receiver = b.video.receiver;
    const track = receiver.track;
    expect(receiver.remoteStreamIds).toEqual(["stable-stream"]);
    a.video.sender.setStreams([new MediaStream({ id: "pending-stream" })]);

    // Act: stream を変えた re-offer を適用する。
    await step(session, async () =>
      a.pc.setLocalDescription(await a.pc.createOffer()),
    );
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );

    // Assert: 同じ receiver/track が新しい stream で通知される。
    expect(events.tracks).toHaveLength(1);
    expect(events.tracks[0].receiver).toBe(receiver);
    expect(events.tracks[0].track).toBe(track);
    expect(events.tracks[0].streams.map((s) => s.id)).toEqual([
      "pending-stream",
    ]);

    // Act: 両側で rollback する。
    await step(session, () => a.pc.setLocalDescription({ type: "rollback" }));
    await step(session, () => b.pc.setRemoteDescription({ type: "rollback" }));

    // Assert: receiver/track の identity を保ち、stream 関連は last-stable に戻る。
    expect(b.video.receiver).toBe(receiver);
    expect(receiver.track).toBe(track);
    expect(receiver.remoteStreamIds).toEqual(["stable-stream"]);
    expect(receiver.remoteStreamId).toBe("stable-stream");
    // Assert: rollback は track を通知し直さず、同じ track に RTP が届き続ける。
    expect(events.tracks).toHaveLength(1);
    await sendAndExpectRtp(a.out, track, "stream-after-rollback");

    // Act: stream の変更をもう一度交渉する。
    await negotiate(session, a, b);

    // Assert: last-stable からの stream 変更は実際の遷移なので再び 1 回通知される。
    expect(events.tracks).toHaveLength(2);
    expect(events.tracks[1].track).toBe(track);
    expect(events.tracks[1].streams.map((s) => s.id)).toEqual([
      "pending-stream",
    ]);
    expect(receiver.remoteStreamIds).toEqual(["pending-stream"]);
  }, 15000);

  test("[2.3-4] ontrack repeats only for a real stream addition or a transition to receiving", async () => {
    // Arrange: stream "first" で video を確定し、b の通知を記録する。
    const session = await duplex();
    const { a, b } = session;
    const first = new MediaStream({ id: "first" });
    a.video.sender.setStreams([first]);
    await negotiate(session, a, b);
    const events = recordNegotiationEvents(b.pc);
    const track = b.video.receiver.track;

    // Act: 何も変えない re-offer/answer を行う。
    await negotiate(session, a, b);

    // Assert: 受信方向も stream も変わらないので通知しない。
    expect(events.tracks).toHaveLength(0);

    // Act: 同じ receiver に stream を追加した re-offer を適用し、同じ offer を再適用する。
    a.video.sender.setStreams([first, new MediaStream({ id: "second" })]);
    await step(session, async () =>
      a.pc.setLocalDescription(await a.pc.createOffer()),
    );
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );
    expect(events.tracks).toHaveLength(1);
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );

    // Assert: stream 追加で 1 回だけ通知され、再適用では通知しない。
    expect(events.tracks).toHaveLength(1);
    expect(events.tracks[0].track).toBe(track);
    expect(events.tracks[0].streams.map((s) => s.id)).toEqual([
      "first",
      "second",
    ]);

    // Act: answer で確定する。
    await step(session, async () =>
      b.pc.setLocalDescription(await b.pc.createAnswer()),
    );
    await step(session, () =>
      a.pc.setRemoteDescription(b.pc.localDescription!),
    );

    // Assert: commit は同じ遷移を再通知しない。
    expect(events.tracks).toHaveLength(1);

    // Act: a の送信を止める交渉をする。
    a.video.direction = "recvonly";
    await negotiate(session, a, b);

    // Assert: 受信をやめる遷移では track を通知しない。
    expect(events.tracks).toHaveLength(1);

    // Act: a の送信を再開する交渉をする。
    a.video.direction = "sendrecv";
    await negotiate(session, a, b);

    // Assert: 受信方向への遷移で同じ receiver/track が 1 回だけ再通知される。
    expect(events.tracks).toHaveLength(2);
    expect(events.tracks[1].receiver).toBe(b.video.receiver);
    expect(events.tracks[1].track).toBe(track);
    await expectSessionAlive(session, "receiving-again");
  }, 20000);

  test("[2.3-7] a remote-created transceiver kept by addTrack carries the next local offer", async () => {
    // Arrange: addTrack で使った remote-created transceiver を rollback 後も残す。
    const { offerer, answerer, kept, localTrack, offererEvents, both, close } =
      await createKeptRemoteTransceiver();
    cleanups.push(close);
    expect(answerer.getTransceivers()).toEqual([kept]);
    expect(kept.sender.track).toBe(localTrack);
    expect(kept.mid).toBeNull();

    // Act: answerer 側から次の offer を作り、offerer の answer で確定する。
    await both(async () =>
      answerer.setLocalDescription(await answerer.createOffer()),
    );
    await both(() => offerer.setRemoteDescription(answerer.localDescription!));
    await both(async () =>
      offerer.setLocalDescription(await offerer.createAnswer()),
    );
    await both(() => answerer.setRemoteDescription(offerer.localDescription!));

    // Assert: 残した transceiver が新しい m-line に関連付けられ、余分な transceiver は作られない。
    expect(answerer.getTransceivers()).toEqual([kept]);
    expect(kept.mid).not.toBeNull();
    const audioLines =
      answerer.currentLocalDescription!.sdp.match(/^m=audio/gm);
    expect(audioLines).toHaveLength(1);
    expect(kept.currentDirection).toBe("sendrecv");
    // Assert: その m-line で localTrack の RTP が相手に届く。
    const remote = offererEvents.tracks.find(
      (event) => event.transceiver.mid === kept.mid,
    );
    expect(remote).toBeDefined();
    await waitForPeersConnected(offerer, answerer);
    await sendAndExpectRtp(localTrack, remote!.track, "kept-transceiver");
  }, 15000);

  test("[2.3-7] rollback leaves no candidate of the rolled-back offer on the kept transceiver's transport", async () => {
    // Arrange: addTrack で使った remote-created transceiver を rollback 後も残す。
    const { kept, close } = await createKeptRemoteTransceiver();
    cleanups.push(close);

    // Act: rollback 後に残った transport の live checklist を読む。
    const connection = kept.dtlsTransport!.iceTransport
      .connection as unknown as { remoteCandidates: unknown[] };

    // Assert: 旧 m-line との関連と共に、rollback した remote offer の候補も外れている。
    expect(connection.remoteCandidates).toEqual([]);
  });

  test.each(["rollback", "replacement offer"] as const)(
    "[2.3-14] %s closes a remote-created channel of a pending-only association and drops it from the registry",
    async (outcome) => {
      // Arrange: 初回 pranswer の provisional association で channel を開く。
      const { offerer, answerer, local, remote, answererEvents } =
        await initialPranswerDataChannel();
      const provisionalTransport = remote.sctp;
      expect(registeredDataChannels(answerer)).toContain(remote);

      // Act: pending-only association を rollback または replacement offer で破棄する。
      if (outcome === "rollback") {
        await offerer.setLocalDescription({ type: "rollback" });
        await answerer.setRemoteDescription({ type: "rollback" });
      } else {
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);
      }
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);

      // Assert: answerer の remote-created channel は閉じ、内部 registry から外れる。
      await waitUntil(
        () => remote.readyState === "closed",
        "remote-created channel did not close",
      );
      expect(Object.values(provisionalTransport.dataChannels)).not.toContain(
        remote,
      );
      expect(registeredDataChannels(answerer)).not.toContain(remote);
      // Assert: 同じ association 上の offerer の channel も閉じ、channel は再通知されない。
      await waitUntil(
        () => local.readyState === "closed",
        "offerer channel did not close",
      );
      expect(answererEvents.dataChannels).toEqual([remote]);
    },
    15000,
  );

  test("[5-4] channels of a committed association stay open through a renegotiation rollback", async () => {
    // Arrange: 確立済み session で re-offer を pranswer まで進める。
    const session = await duplex();
    const { a, b } = session;
    const bEvents = recordNegotiationEvents(b.pc);
    const association = a.pc.sctpTransport;
    await step(session, async () =>
      a.pc.setLocalDescription(await a.pc.createOffer()),
    );
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );
    const pranswer = (await b.pc.createAnswer()).sdp;
    await step(session, () =>
      b.pc.setLocalDescription({ type: "pranswer", sdp: pranswer }),
    );
    await step(session, () =>
      a.pc.setRemoteDescription({ type: "pranswer", sdp: pranswer }),
    );

    // Act: pending 中に committed association 上へ新しい channel を開く。
    const duringPending = a.pc.createDataChannel("during-pending");
    await waitUntil(
      () =>
        duringPending.readyState === "open" &&
        bEvents.dataChannels.length === 1,
      "channel on the committed association did not open",
    );
    const remoteDuringPending = bEvents.dataChannels[0];

    // Act: 両側で rollback する。
    await step(session, () => a.pc.setLocalDescription({ type: "rollback" }));
    await step(session, () => b.pc.setRemoteDescription({ type: "rollback" }));

    // Assert: committed association とその上の channel はすべて open のまま通信できる。
    expect(a.pc.sctpTransport).toBe(association);
    for (const channel of [
      a.channel,
      b.channel,
      duringPending,
      remoteDuringPending,
    ]) {
      expect(channel.readyState).toBe("open");
    }
    await expectDataAlive(session, "committed-after-rollback");
    await sendAndExpectData(
      duringPending,
      remoteDuringPending,
      "during-pending-after-rollback",
    );
    // Assert: rollback で channel が再通知されることはない。
    expect(bEvents.dataChannels).toEqual([remoteDuringPending]);
  }, 15000);

  test("[2.3-19] an ICE restart pranswer and its rollback notify only real signaling transitions", async () => {
    // Arrange: 接続済み session の状態通知を記録する。
    const session = await duplex();
    const { a, b } = session;
    const aEvents = recordNegotiationEvents(a.pc);
    const bEvents = recordNegotiationEvents(b.pc);

    // Act: ICE restart の pranswer で provisional generation を nominate させ、両側で rollback する。
    await step(session, async () =>
      a.pc.setLocalDescription(await a.pc.createOffer({ iceRestart: true })),
    );
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );
    const pranswer = (await b.pc.createAnswer()).sdp;
    await step(session, () =>
      b.pc.setLocalDescription({ type: "pranswer", sdp: pranswer }),
    );
    await step(session, () =>
      a.pc.setRemoteDescription({ type: "pranswer", sdp: pranswer }),
    );
    await waitForProvisionalNomination(a.pc);
    await step(session, () => a.pc.setLocalDescription({ type: "rollback" }));
    await step(session, () => b.pc.setRemoteDescription({ type: "rollback" }));
    await expectSessionAlive(session, "restart-rollback");

    // Assert: signaling は実際の遷移だけを順に通知する。
    expect(aEvents.signaling).toEqual([
      "have-local-offer",
      "have-remote-pranswer",
      "stable",
    ]);
    expect(bEvents.signaling).toEqual([
      "have-remote-offer",
      "have-local-pranswer",
      "stable",
    ]);
    // Assert: live の接続状態は変わらないので、接続状態の通知は出ない。
    for (const events of [aEvents, bEvents]) {
      expect(events.connection).toEqual([]);
      expect(events.iceConnection).toEqual([]);
    }
    expect([a.pc.connectionState, b.pc.connectionState]).toEqual([
      "connected",
      "connected",
    ]);
  }, 15000);

  test("[2.3-19] rolling back a connection made at the first pranswer notifies only the new transitions", async () => {
    // Arrange: 初回 pranswer で接続し、それまでの通知を控える。
    const { offerer, answerer, offererEvents, answererEvents } =
      await initialPranswerDataChannel();
    await waitUntil(
      () =>
        offerer.connectionState === "connected" &&
        answerer.connectionState === "connected",
      "first pranswer did not connect",
    );
    const before = [offererEvents, answererEvents].map((events) => ({
      signaling: events.signaling.length,
      connection: events.connection.length,
      iceConnection: events.iceConnection.length,
    }));
    // Assert: pranswer までの通知は重複のない実際の遷移になっている。
    expect(offererEvents.signaling).toEqual([
      "have-local-offer",
      "have-remote-pranswer",
    ]);
    expect(answererEvents.signaling).toEqual([
      "have-remote-offer",
      "have-local-pranswer",
    ]);
    for (const events of [offererEvents, answererEvents]) {
      expect(events.connection.at(-1)).toBe("connected");
      expect(
        events.connection.filter(
          (state, index) => events.connection[index - 1] === state,
        ),
      ).toEqual([]);
    }

    // Act: 両側で rollback する。
    await offerer.setLocalDescription({ type: "rollback" });
    await answerer.setRemoteDescription({ type: "rollback" });
    assertNegotiationInvariants(offerer);
    assertNegotiationInvariants(answerer);

    // Assert: rollback 後は stable と new への新しい遷移だけが 1 回ずつ追加される。
    [offererEvents, answererEvents].forEach((events, index) => {
      expect(events.signaling.slice(before[index].signaling)).toEqual([
        "stable",
      ]);
      expect(events.connection.slice(before[index].connection)).toEqual([
        "new",
      ]);
      expect(events.iceConnection.slice(before[index].iceConnection)).toEqual([
        "new",
      ]);
    });
    expect([offerer.connectionState, answerer.connectionState]).toEqual([
      "new",
      "new",
    ]);
  }, 15000);

  test("[2.3-19] negotiationneeded waits for stable and is recomputed once after rollback", async () => {
    // Arrange: 確立済み session で a の re-offer を pending にする。
    const session = await duplex();
    const { a, b } = session;
    const aEvents = recordNegotiationEvents(a.pc);
    await step(session, async () =>
      a.pc.setLocalDescription(await a.pc.createOffer()),
    );
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );

    // Act: pending 中に application が transceiver を追加する。
    const added = a.pc.addTransceiver("audio");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Assert: stable でない間は negotiationneeded を通知しない。
    expect(aEvents.negotiationNeeded).toBe(0);

    // Act: 両側で rollback する。
    await step(session, () => a.pc.setLocalDescription({ type: "rollback" }));
    await step(session, () => b.pc.setRemoteDescription({ type: "rollback" }));

    // Assert: stable に戻った時点で必要性を再計算し、1 回だけ通知する。
    await waitUntil(
      () => aEvents.negotiationNeeded > 0,
      "negotiationneeded was not recomputed after rollback",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(aEvents.negotiationNeeded).toBe(1);
    expect(a.pc.getTransceivers()).toContain(added);

    // Act: 追加した transceiver を交渉する。
    await negotiate(session, a, b);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Assert: 交渉済みの変更について再び通知しない。
    expect(aEvents.negotiationNeeded).toBe(1);
  }, 15000);

  test("[2.3-21] re-applying the same pranswer creates no new channel, transceiver or event", async () => {
    // Arrange: video と DataChannel の初回 pranswer で暫定通信を始め、両側の通知を記録する。
    const session = await createMutationSession("initial");
    cleanups.push(session.close);
    const { a, b } = session;
    const aEvents = recordNegotiationEvents(a.pc);
    const bEvents = recordNegotiationEvents(b.pc);
    await step(session, async () =>
      a.pc.setLocalDescription(await a.pc.createOffer()),
    );
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );
    await prepareMutationAnswerer(session);
    const pranswer = (await b.pc.createAnswer()).sdp;
    await step(session, () =>
      b.pc.setLocalDescription({ type: "pranswer", sdp: pranswer }),
    );
    await step(session, () =>
      a.pc.setRemoteDescription({ type: "pranswer", sdp: pranswer }),
    );
    await waitForMutationSession(session);
    const remoteChannel = b.channel;
    const objects = [a.pc, b.pc].map((pc) => ({
      transceivers: pc.getTransceivers(),
      sctp: pc.sctpTransport,
      dtls: pc.dtlsTransports,
    }));
    const counts = () =>
      [aEvents, bEvents].map((events) => ({
        tracks: events.tracks.length,
        remoteTransceivers: events.remoteTransceivers.length,
        dataChannels: events.dataChannels.length,
      }));
    const before = counts();
    expect(before[1]).toEqual({
      tracks: 1,
      remoteTransceivers: 1,
      dataChannels: 1,
    });

    // Act: 同じ pranswer を両側に再適用する。
    await step(session, () =>
      b.pc.setLocalDescription({ type: "pranswer", sdp: pranswer }),
    );
    await step(session, () =>
      a.pc.setRemoteDescription({ type: "pranswer", sdp: pranswer }),
    );

    // Assert: track/transceiver/channel の通知も object も増えず、同じ channel が open のまま。
    expect(counts()).toEqual(before);
    expect(
      [a.pc, b.pc].map((pc) => ({
        transceivers: pc.getTransceivers(),
        sctp: pc.sctpTransport,
        dtls: pc.dtlsTransports,
      })),
    ).toEqual(objects);
    expect(b.channel).toBe(remoteChannel);
    expect(remoteChannel.readyState).toBe("open");
    expect(repeatedCandidates(aEvents.candidates)).toEqual([]);
    expect(repeatedCandidates(bEvents.candidates)).toEqual([]);
    await expectSessionAlive(session, "same-pranswer");

    // Act: 同じ内容の final answer で確定する。
    await step(session, () =>
      b.pc.setLocalDescription({ type: "answer", sdp: pranswer }),
    );
    await step(session, () =>
      a.pc.setRemoteDescription({ type: "answer", sdp: pranswer }),
    );

    // Assert: commit でも通知は増えず、同じ channel で通信を続ける。
    expect(counts()).toEqual(before);
    expect(b.channel).toBe(remoteChannel);
    await expectSessionAlive(session, "same-pranswer-committed");
  }, 20000);

  test("[2.3-22] a DCEP reusing a stream ID on a new association after rollback creates a new channel", async () => {
    // Arrange: 初回 pranswer の association で channel を開いてから両側で rollback する。
    const { offerer, answerer, local, remote, answererEvents } =
      await initialPranswerDataChannel("first");
    const firstStreamId = remote.id;
    await offerer.setLocalDescription({ type: "rollback" });
    await answerer.setRemoteDescription({ type: "rollback" });
    await waitUntil(
      () => local.readyState === "closed" && remote.readyState === "closed",
      "provisional channels did not close",
    );

    // Act: 新しい channel で交渉し直し、新しい association を確定する。
    const second = offerer.createDataChannel("second");
    await offerer.setLocalDescription(await offerer.createOffer());
    await answerer.setRemoteDescription(offerer.localDescription!);
    await answerer.setLocalDescription(await answerer.createAnswer());
    await offerer.setRemoteDescription(answerer.localDescription!);
    assertNegotiationInvariants(offerer);
    assertNegotiationInvariants(answerer);
    await waitUntil(
      () =>
        second.readyState === "open" && answererEvents.dataChannels.length > 1,
      "channel on the new association did not open",
    );

    // Assert: 同じ stream ID でも association が違うので新しい object と event が作られる。
    expect(second.id).toBe(firstStreamId);
    expect(answererEvents.dataChannels).toHaveLength(2);
    const renewed = answererEvents.dataChannels[1];
    expect(renewed).not.toBe(remote);
    expect(renewed.id).toBe(firstStreamId);
    expect(renewed.label).toBe("second");
    // Assert: 旧 channel は閉じたままで、新しい channel だけが通信する。
    expect(remote.readyState).toBe("closed");
    await sendAndExpectData(second, renewed, "renewed-a-to-b");
    await sendAndExpectData(renewed, second, "renewed-b-to-a");
  }, 15000);

  test("[2.3-24] a DCEP held past rollback is not delivered, while the provisional channel still gets its close event", async () => {
    // Arrange: 初回 pranswer の channel を開き、answerer に届く次の DCEP を保留する。
    const { offerer, answerer, remote, answererEvents } =
      await initialPranswerDataChannel("first");
    const remoteStates: string[] = [];
    remote.stateChanged.subscribe((state) => {
      remoteStates.push(state);
    });
    let closeEvents = 0;
    remote.addEventListener("close", () => closeEvents++);
    const provisionalTransport = remote.sctp;
    const dcep = holdIncomingDcep(answerer);
    const late = offerer.createDataChannel("late");
    await waitUntil(() => dcep.held > 0, "DCEP was not received");

    // Act: 両側で rollback してから保留した DCEP を配送する。
    await offerer.setLocalDescription({ type: "rollback" });
    await answerer.setRemoteDescription({ type: "rollback" });
    dcep.release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert: 廃棄済み transaction の DCEP は ondatachannel を発火せず、registry にも入らない。
    expect(answererEvents.dataChannels).toEqual([remote]);
    expect(
      Object.values(provisionalTransport.dataChannels).map((c) => c.label),
    ).not.toContain("late");
    expect(
      registeredDataChannels(answerer).map((channel) => channel.label),
    ).not.toContain("late");
    // Assert: 既に渡した channel には close が 1 回配送される。
    expect(remote.readyState).toBe("closed");
    expect(remoteStates.at(-1)).toBe("closed");
    expect(closeEvents).toBe(1);
    // Assert: 保留中だった offerer 側の channel も pending-only association と共に閉じる。
    await waitUntil(
      () => late.readyState === "closed",
      "offerer channel did not close",
    );
    assertNegotiationInvariants(offerer);
    assertNegotiationInvariants(answerer);
  }, 15000);
});
