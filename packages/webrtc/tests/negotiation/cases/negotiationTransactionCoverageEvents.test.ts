import { MediaStream, MediaStreamTrack } from "../../../src";
import type { RTCDataChannel, RTCPeerConnection } from "../../../src";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  type NegotiationEvents,
  assertTransportsClosed,
  createDuplexSession,
  createInitialPranswerDataChannel,
  createKeptRemoteTransceiver,
  createMutationSession,
  createPeerPair,
  createSplitOffer,
  expectDataAlive,
  heldTransports,
  holdIncomingDcep,
  prepareMutationAnswerer,
  recordNegotiationEvents,
  registeredDataChannels,
  waitForDtlsConnected,
  waitForMutationSession,
  waitForPeersConnected,
  waitForProvisionalNomination,
} from "../harness/negotiationTransactionUtils";

/**
 * Observable events and speculative object lifetime of a negotiation
 * transaction (TICKET 2.1 replacement/rollback row, 2.3 and 5-4).
 */
describeCases("negotiation transaction events and object lifetime", () => {
  const repeatedCandidates = (candidates: NegotiationEvents["candidates"]) => {
    const keys = candidates
      .filter((candidate) => candidate !== undefined)
      .map((candidate) => `${candidate!.sdpMid} ${candidate!.candidate}`);
    return keys.filter((key, index) => keys.indexOf(key) !== index);
  };

  const streamIds = (event: NegotiationEvents["tracks"][number]) =>
    event.streams.map((stream) => stream.id);

  negotiationCase(
    "[2.1-T6] a replacement offer and its rollback repeat no delivered event and close the replacement's pending-only transports",
    { ref: "2.1-T6" },
    async (c) => {
      const addedTransports = (
        pc: RTCPeerConnection,
        before: ReturnType<typeof heldTransports>,
      ) => [...heldTransports(pc)].filter((t) => !before.has(t));

      // Arrange: 接続済み session の b で発火する通知を記録し、a に audio を足した offer A を b に適用する。
      const { a, b } = await c.given(createDuplexSession());
      const aEvents = recordNegotiationEvents(a);
      const bEvents = recordNegotiationEvents(b);
      const before = { a: heldTransports(a), b: heldTransports(b) };
      const audioOut = new MediaStreamTrack({ kind: "audio" });
      const audio = a.addTransceiver(audioOut, { direction: "sendonly" });
      await c.offer(a);
      expect(bEvents.remoteTransceivers.length).toEqual(1);
      expect(bEvents.tracks.length).toEqual(1);
      const remoteAudio = bEvents.remoteTransceivers[0];

      // Act: 同じ m-line を BUNDLE から外す replacement offer B を両側に適用し、b は answer 用 transport を準備する。
      const offerB = await createSplitOffer(a, audio.mid!);
      await c.setLocal(a, offerB);
      await c.setRemote(b, a.localDescription);
      await b.createAnswer();
      c.invariants();

      // Assert: A で通知済みの transceiver/track は B で再通知されず、同じ object のまま。
      expect(bEvents.remoteTransceivers).toEqual([remoteAudio]);
      expect(bEvents.tracks.length).toEqual(1);
      expect(b.getTransceivers()).toContain(remoteAudio);

      // Assert: B は両側に pending-only の transport を作っている。
      const pendingOnly = {
        a: addedTransports(a, before.a),
        b: addedTransports(b, before.b),
      };
      expect(pendingOnly.a.length).toBeGreaterThan(0);
      expect(pendingOnly.b.length).toBeGreaterThan(0);

      // Act: 両側で rollback する。
      await c.rollback(a);

      // Assert: rollback は通知を増やさず、remote-only の transceiver を除外する。
      expect(bEvents.remoteTransceivers).toEqual([remoteAudio]);
      expect(bEvents.tracks.length).toEqual(1);
      expect(b.getTransceivers()).not.toContain(remoteAudio);
      expect(remoteAudio.stopped).toBe(true);

      // Assert: B の pending-only transport は ICE/DTLS とも閉じている。
      assertTransportsClosed([...pendingOnly.a, ...pendingOnly.b]);

      // Assert: 同一 generation の同じ候補は二度通知されない。
      expect(repeatedCandidates(aEvents.candidates)).toEqual([]);
      expect(repeatedCandidates(bEvents.candidates)).toEqual([]);
      await c.alive();

      // Act: rollback 後に B を適用し直す。
      await c.setLocal(a, offerB);
      await c.setRemote(b, a.localDescription);

      // Assert: 除外済み transceiver の代わりに新しい object が正当な新規通知として 1 回ずつ出る。
      expect(bEvents.remoteTransceivers.length).toEqual(2);
      expect(bEvents.tracks.length).toEqual(2);
      const reapplied = bEvents.remoteTransceivers[1];
      expect(reapplied).not.toBe(remoteAudio);
      expect(bEvents.tracks[1].transceiver).toBe(reapplied);

      // Act: B を final answer で確定する。
      await c.answer(b);

      // Assert: commit は通知を重ねず、分離した audio と既存 session が通信する。
      expect(bEvents.remoteTransceivers.length).toEqual(2);
      expect(bEvents.tracks.length).toEqual(2);
      expect(repeatedCandidates(aEvents.candidates)).toEqual([]);
      expect(repeatedCandidates(bEvents.candidates)).toEqual([]);
      await waitForDtlsConnected(reapplied.dtlsTransport);
      await c.rtp(audioOut, reapplied.receiver.track);
      await c.alive();
    },
  );

  negotiationCase(
    "[2.3-1] a remote pranswer fires ontrack once before the final answer",
    { ref: "2.3-1" },
    async (c) => {
      // Arrange: 受信専用 video の初回 offer に、answerer が送信する pranswer を用意する。
      const { a, b } = await c.given(createPeerPair());
      const events = recordNegotiationEvents(a);
      const receiving = a.addTransceiver("video", { direction: "recvonly" });
      await c.offer(a);
      const outgoing = new MediaStreamTrack({ kind: "video" });
      const sending = b.getTransceivers()[0];
      sending.setDirection("sendonly");
      await sending.sender.replaceTrack(outgoing);
      const answer = await c.pranswer(b, { hold: true });
      expect(events.tracks.length).toEqual(0);

      // Act: offerer が remote pranswer を適用する。
      await c.setRemote(a, answer, { type: "pranswer" });

      // Assert: final answer 前に receiver の track が 1 回通知され、current は空のまま。
      expect(events.tracks.length).toEqual(1);
      expect(events.tracks[0].transceiver).toBe(receiving);
      expect(events.tracks[0].receiver).toBe(receiving.receiver);
      expect(events.tracks[0].track).toBe(receiving.receiver.track);
      expect(a.currentRemoteDescription).toEqual(null);

      // Assert: 通知した track に暫定 RTP が届く。
      await waitForPeersConnected(a, b);
      await c.rtp(outgoing, receiving.receiver.track);

      // Act: 同じ内容の final answer で確定する。
      await c.setLocal(b, answer);
      await c.setRemote(a, answer);

      // Assert: final answer は同じ receiver を再通知しない。
      expect(events.tracks.length).toEqual(1);
      await c.rtp(outgoing, receiving.receiver.track);
    },
  );

  negotiationCase(
    "[2.3-2] rollback keeps the receiver and track and restores the last-stable stream association",
    { ref: "2.3-2" },
    async (c) => {
      // Arrange: video に stream "stable-stream" を付けて確定し、別 stream へ移す re-offer を用意する。
      const { a, b, aOut, aVideo, bVideo } = await c.given(
        createDuplexSession(),
      );
      aVideo.sender.setStreams([new MediaStream({ id: "stable-stream" })]);
      await c.negotiate(a);
      const events = recordNegotiationEvents(b);
      const receiver = bVideo.receiver;
      const track = receiver.track;
      expect(receiver.remoteStreamIds).toEqual(["stable-stream"]);
      aVideo.sender.setStreams([new MediaStream({ id: "pending-stream" })]);

      // Act: stream を変えた re-offer を適用する。
      await c.offer(a);

      // Assert: 同じ receiver/track が新しい stream で通知される。
      expect(events.tracks.length).toEqual(1);
      expect(events.tracks[0].receiver).toBe(receiver);
      expect(events.tracks[0].track).toBe(track);
      expect(streamIds(events.tracks[0])).toEqual(["pending-stream"]);

      // Act: 両側で rollback する。
      await c.rollback(a);

      // Assert: receiver/track の identity を保ち、stream 関連は last-stable に戻る。
      expect(bVideo.receiver).toBe(receiver);
      expect(receiver.track).toBe(track);
      expect(receiver.remoteStreamIds).toEqual(["stable-stream"]);
      expect(receiver.remoteStreamId).toBe("stable-stream");

      // Assert: rollback は track を通知し直さず、同じ track に RTP が届き続ける。
      expect(events.tracks.length).toEqual(1);
      await c.rtp(aOut, track);

      // Act: stream の変更をもう一度交渉する。
      await c.negotiate(a);

      // Assert: last-stable からの stream 変更は実際の遷移なので再び 1 回通知される。
      expect(events.tracks.length).toEqual(2);
      expect(events.tracks[1].track).toBe(track);
      expect(streamIds(events.tracks[1])).toEqual(["pending-stream"]);
      expect(receiver.remoteStreamIds).toEqual(["pending-stream"]);
    },
  );

  negotiationCase(
    "[2.3-4] ontrack repeats only for a real stream addition or a transition to receiving",
    { ref: "2.3-4" },
    async (c) => {
      // Arrange: stream "first" で video を確定し、b の通知を記録する。
      const { a, b, aVideo, bVideo } = await c.given(createDuplexSession());
      const first = new MediaStream({ id: "first" });
      aVideo.sender.setStreams([first]);
      await c.negotiate(a);
      const events = recordNegotiationEvents(b);
      const track = bVideo.receiver.track;

      // Act: 何も変えない re-offer/answer を行う。
      await c.negotiate(a);

      // Assert: 受信方向も stream も変わらないので通知しない。
      expect(events.tracks.length).toEqual(0);

      // Act: 同じ receiver に stream を追加した re-offer を適用し、同じ offer を再適用する。
      aVideo.sender.setStreams([first, new MediaStream({ id: "second" })]);
      await c.offer(a);
      expect(events.tracks.length).toEqual(1);
      await c.setRemote(b, a.localDescription);

      // Assert: stream 追加で 1 回だけ通知され、再適用では通知しない。
      expect(events.tracks.length).toEqual(1);
      expect(events.tracks[0].track).toBe(track);
      expect(streamIds(events.tracks[0])).toEqual(["first", "second"]);

      // Act: answer で確定する。
      await c.answer(b);

      // Assert: commit は同じ遷移を再通知しない。
      expect(events.tracks.length).toEqual(1);

      // Act: a の送信を止める交渉をする。
      aVideo.setDirection("recvonly");
      await c.negotiate(a);

      // Assert: 受信をやめる遷移では track を通知しない。
      expect(events.tracks.length).toEqual(1);

      // Act: a の送信を再開する交渉をする。
      aVideo.setDirection("sendrecv");
      await c.negotiate(a);

      // Assert: 受信方向への遷移で同じ receiver/track が 1 回だけ再通知される。
      expect(events.tracks.length).toEqual(2);
      expect(events.tracks[1].receiver).toBe(bVideo.receiver);
      expect(events.tracks[1].track).toBe(track);
      await c.alive();
    },
  );

  negotiationCase(
    "[2.3-7] a remote-created transceiver kept by addTrack carries the next local offer",
    { ref: "2.3-7" },
    async (c) => {
      // Arrange: addTrack で使った remote-created transceiver を rollback 後も残す。
      const { a, b, kept, localTrack, offererEvents } = await c.given(
        createKeptRemoteTransceiver(),
      );
      expect(b.getTransceivers()).toEqual([kept]);
      expect(kept.sender.track).toBe(localTrack);
      expect(kept.mid).toEqual(null);

      // Act: answerer 側から次の offer を作り、offerer の answer で確定する。
      await c.negotiate(b);

      // Assert: 残した transceiver が新しい m-line に関連付けられ、余分な transceiver は作られない。
      expect(b.getTransceivers()).toEqual([kept]);
      expect(kept.mid).not.toEqual(null);
      expect(
        b.currentLocalDescription!.sdp.match(/^m=audio/gm)!.length,
      ).toEqual(1);
      expect(kept.currentDirection).toEqual("sendrecv");

      // Assert: その m-line で localTrack の RTP が相手に届く。
      const received = offererEvents.tracks.find(
        (event) => event.transceiver.mid === kept.mid,
      );
      expect(received).not.toEqual(undefined);
      await waitForPeersConnected(a, b);
      await c.rtp(localTrack, received!.track);
    },
  );

  negotiationCase(
    "[2.3-7] rollback leaves no candidate of the rolled-back offer on the kept transceiver's transport",
    { ref: "2.3-7" },
    async (c) => {
      // Arrange: addTrack で使った remote-created transceiver を rollback 後も残す。
      const { kept } = await c.given(createKeptRemoteTransceiver());

      // Act: rollback 後に残った transport の live checklist を読む。
      const connection = kept.dtlsTransport.iceTransport.connection;

      // Assert: 旧 m-line との関連と共に、rollback した remote offer の候補も外れている。
      expect(connection.remoteCandidates).toEqual([]);
    },
  );

  negotiationCase.for([
    { outcome: "rollback" },
    { outcome: "replacement offer" },
  ] as const)(
    "[2.3-14] $outcome closes a remote-created channel of a pending-only association and drops it from the registry",
    { ref: "2.3-14" },
    async (c, { outcome }) => {
      // Arrange: 初回 pranswer の provisional association で channel を開く。
      const { a, b, remote, local, answererEvents } = await c.given(
        createInitialPranswerDataChannel(),
      );
      const provisionalTransport = remote.sctp;
      expect(registeredDataChannels(b)).toContain(remote);

      // Act: pending-only association を rollback または replacement offer で破棄する。
      if (outcome === "rollback") {
        await c.setLocal(a, "rollback");
        await c.setRemote(b, "rollback");
      } else await c.offer(a);

      // Assert: answerer の remote-created channel は閉じ、内部 registry から外れる。
      await c.waitFor(() => remote.readyState === "closed");
      expect(Object.values(provisionalTransport.dataChannels)).not.toContain(
        remote,
      );
      expect(registeredDataChannels(b)).not.toContain(remote);

      // Assert: 同じ association 上の offerer の channel も閉じ、channel は再通知されない。
      await c.waitFor(() => local.readyState === "closed");
      expect(answererEvents.dataChannels).toEqual([remote]);
    },
  );

  negotiationCase(
    "[5-4] channels of a committed association stay open through a renegotiation rollback",
    { ref: "5-4" },
    async (c) => {
      // Arrange: 確立済み session で re-offer を pranswer まで進める。
      const { a, b, session, aChannel, bChannel } = await c.given(
        createDuplexSession(),
      );
      const bEvents = recordNegotiationEvents(b);
      const association = a.sctpTransport;
      await c.offer(a);
      await c.pranswer(b);

      // Act: pending 中に committed association 上へ新しい channel を開く。
      const duringPending = a.createDataChannel("during-pending");
      await c.waitFor(
        () =>
          duringPending.readyState === "open" &&
          bEvents.dataChannels.length === 1,
      );
      const remoteDuringPending = bEvents.dataChannels[0];

      // Act: 両側で rollback する。
      await c.rollback(a);

      // Assert: committed association とその上の channel はすべて open のまま通信できる。
      expect(a.sctpTransport).toBe(association);
      expect(
        [aChannel, bChannel, duringPending, remoteDuringPending].map(
          (channel) => channel.readyState,
        ),
      ).toEqual(["open", "open", "open", "open"]);
      await expectDataAlive(session, "committed-after-rollback");
      await c.data(duringPending, remoteDuringPending);

      // Assert: rollback で channel が再通知されることはない。
      expect(bEvents.dataChannels).toEqual([remoteDuringPending]);
    },
  );

  negotiationCase(
    "[2.3-19] an ICE restart pranswer and its rollback notify only real signaling transitions",
    { ref: "2.3-19" },
    async (c) => {
      // Arrange: 接続済み session の状態通知を記録する。
      const { a, b } = await c.given(createDuplexSession());
      const aEvents = recordNegotiationEvents(a);
      const bEvents = recordNegotiationEvents(b);

      // Act: ICE restart の pranswer で provisional generation を nominate させ、両側で rollback する。
      await c.offer(a, { iceRestart: true });
      await c.pranswer(b);
      await waitForProvisionalNomination(a);
      await c.rollback(a);
      await c.alive();

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
      expect([
        aEvents.connection,
        aEvents.iceConnection,
        bEvents.connection,
        bEvents.iceConnection,
      ]).toEqual([[], [], [], []]);
      expect([a.connectionState, b.connectionState]).toEqual([
        "connected",
        "connected",
      ]);
    },
  );

  negotiationCase(
    "[2.3-19] rolling back a connection made at the first pranswer notifies only the new transitions",
    { ref: "2.3-19" },
    async (c) => {
      const counts = (events: NegotiationEvents) => ({
        signaling: events.signaling.length,
        connection: events.connection.length,
        iceConnection: events.iceConnection.length,
      });
      const since = (
        events: NegotiationEvents,
        before: Record<"signaling" | "connection" | "iceConnection", number>,
      ) => ({
        signaling: events.signaling.slice(before.signaling),
        connection: events.connection.slice(before.connection),
        iceConnection: events.iceConnection.slice(before.iceConnection),
      });
      const repeatedStates = (states: string[]) =>
        states.filter((state, index) => states[index - 1] === state);

      // Arrange: 初回 pranswer で接続し、それまでの通知を控える。
      const { a, b, offererEvents, answererEvents } = await c.given(
        createInitialPranswerDataChannel(),
      );
      await c.waitFor(
        () =>
          a.connectionState === "connected" &&
          b.connectionState === "connected",
      );
      const before = [counts(offererEvents), counts(answererEvents)];

      // Assert: pranswer までの通知は重複のない実際の遷移になっている。
      expect(offererEvents.signaling).toEqual([
        "have-local-offer",
        "have-remote-pranswer",
      ]);
      expect(answererEvents.signaling).toEqual([
        "have-remote-offer",
        "have-local-pranswer",
      ]);
      expect(offererEvents.connection.at(-1)).toBe("connected");
      expect(answererEvents.connection.at(-1)).toBe("connected");
      expect(repeatedStates(offererEvents.connection)).toEqual([]);
      expect(repeatedStates(answererEvents.connection)).toEqual([]);

      // Act: 両側で rollback する。
      await c.setLocal(a, "rollback");
      await c.setRemote(b, "rollback");

      // Assert: rollback 後は stable と new への新しい遷移だけが 1 回ずつ追加される。
      expect(since(offererEvents, before[0])).toEqual({
        signaling: ["stable"],
        connection: ["new"],
        iceConnection: ["new"],
      });
      expect(since(answererEvents, before[1])).toEqual({
        signaling: ["stable"],
        connection: ["new"],
        iceConnection: ["new"],
      });
      expect([a.connectionState, b.connectionState]).toEqual(["new", "new"]);
    },
  );

  negotiationCase(
    "[2.3-19] negotiationneeded waits for stable and is recomputed once after rollback",
    { ref: "2.3-19" },
    async (c) => {
      // Arrange: 確立済み session で a の re-offer を pending にする。
      const { a } = await c.given(createDuplexSession());
      const aEvents = recordNegotiationEvents(a);
      await c.offer(a);

      // Act: pending 中に application が transceiver を追加する。
      const added = a.addTransceiver("audio");
      await c.sleep(20);

      // Assert: stable でない間は negotiationneeded を通知しない。
      expect(aEvents.negotiationNeeded).toEqual(0);

      // Act: 両側で rollback する。
      await c.rollback(a);

      // Assert: stable に戻った時点で必要性を再計算し、1 回だけ通知する。
      await c.waitFor(() => aEvents.negotiationNeeded !== 0);
      await c.sleep(20);
      expect(aEvents.negotiationNeeded).toEqual(1);
      expect(a.getTransceivers()).toContain(added);

      // Act: 追加した transceiver を交渉する。
      await c.negotiate(a);
      await c.sleep(20);

      // Assert: 交渉済みの変更について再び通知しない。
      expect(aEvents.negotiationNeeded).toEqual(1);
    },
  );

  negotiationCase(
    "[2.3-21] re-applying the same pranswer creates no new channel, transceiver or event",
    { ref: "2.3-21" },
    async (c) => {
      const objectsOf = (pcs: RTCPeerConnection[]) =>
        pcs.map((pc) => ({
          transceivers: pc.getTransceivers(),
          sctp: pc.sctpTransport,
          dtls: pc.dtlsTransports,
        }));

      // Arrange: video と DataChannel の初回 pranswer で暫定通信を始め、両側の通知を記録する。
      const { a, b, session } = await c.given(createMutationSession("initial"));
      const aEvents = recordNegotiationEvents(a);
      const bEvents = recordNegotiationEvents(b);
      await c.offer(a);
      await prepareMutationAnswerer(session);
      const answer = await c.pranswer(b, { hold: true });
      await c.setRemote(a, answer, { type: "pranswer" });
      await waitForMutationSession(session);
      const remoteChannel = session.b.channel;
      const objects = objectsOf([a, b]);
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
      await c.setLocal(b, answer, { type: "pranswer" });
      await c.setRemote(a, answer, { type: "pranswer" });

      // Assert: track/transceiver/channel の通知も object も増えず、同じ channel が open のまま。
      expect(counts()).toEqual(before);
      expect(objectsOf([a, b])).toEqual(objects);
      expect(session.b.channel).toBe(remoteChannel);
      expect(remoteChannel.readyState).toEqual("open");
      expect(repeatedCandidates(aEvents.candidates)).toEqual([]);
      expect(repeatedCandidates(bEvents.candidates)).toEqual([]);
      await c.alive();

      // Act: 同じ内容の final answer で確定する。
      await c.setLocal(b, answer, { type: "answer" });
      await c.setRemote(a, answer, { type: "answer" });

      // Assert: commit でも通知は増えず、同じ channel で通信を続ける。
      expect(counts()).toEqual(before);
      expect(session.b.channel).toBe(remoteChannel);
      await c.alive();
    },
  );

  negotiationCase(
    "[2.3-22] a DCEP reusing a stream ID on a new association after rollback creates a new channel",
    { ref: "2.3-22" },
    async (c) => {
      // Arrange: 初回 pranswer の association で channel を開いてから両側で rollback する。
      const { a, b, remote, local, answererEvents } = await c.given(
        createInitialPranswerDataChannel("first"),
      );
      const firstStreamId = remote.id;
      await c.setLocal(a, "rollback");
      await c.setRemote(b, "rollback");
      await c.waitFor(
        () => local.readyState === "closed" && remote.readyState === "closed",
      );

      // Act: 新しい channel で交渉し直し、新しい association を確定する。
      const second = a.createDataChannel("second");
      await c.negotiate(a);
      await c.waitFor(
        () =>
          second.readyState === "open" &&
          answererEvents.dataChannels.length === 2,
      );

      // Assert: 同じ stream ID でも association が違うので新しい object と event が作られる。
      expect(second.id).toEqual(firstStreamId);
      expect(answererEvents.dataChannels.length).toEqual(2);
      const renewed = answererEvents.dataChannels[1];
      expect(renewed).not.toBe(remote);
      expect(renewed).toMatchObject({ id: firstStreamId, label: "second" });

      // Assert: 旧 channel は閉じたままで、新しい channel だけが通信する。
      expect(remote.readyState).toEqual("closed");
      await c.data(second, renewed);
      await c.data(renewed, second);
    },
  );

  negotiationCase(
    "[2.3-24] a DCEP held past rollback is not delivered, while the provisional channel still gets its close event",
    { ref: "2.3-24" },
    async (c) => {
      const recordChannelEvents = (channel: RTCDataChannel) => {
        const record = { states: [] as string[], closes: 0 };
        channel.stateChanged.subscribe((state) => {
          record.states.push(state);
        });
        channel.addEventListener("close", () => record.closes++);
        return record;
      };

      // Arrange: 初回 pranswer の channel を開き、answerer に届く次の DCEP を保留する。
      const { a, b, remote, answererEvents } = await c.given(
        createInitialPranswerDataChannel("first"),
      );
      const remoteEvents = recordChannelEvents(remote);
      const provisionalTransport = remote.sctp;
      const dcep = holdIncomingDcep(b);
      const late = a.createDataChannel("late");
      await c.waitFor(() => dcep.held !== 0);

      // Act: 両側で rollback してから保留した DCEP を配送する。
      await c.setLocal(a, "rollback");
      await c.setRemote(b, "rollback");
      dcep.release();
      await c.sleep(50);

      // Assert: 廃棄済み transaction の DCEP は ondatachannel を発火せず、registry にも入らない。
      expect(answererEvents.dataChannels).toEqual([remote]);
      expect(
        Object.values(provisionalTransport.dataChannels).map(
          (channel) => channel.label,
        ),
      ).not.toContain("late");
      expect(
        registeredDataChannels(b).map((channel) => channel.label),
      ).not.toContain("late");

      // Assert: 既に渡した channel には close が 1 回配送される。
      expect(remote.readyState).toEqual("closed");
      expect(remoteEvents.states.at(-1)).toEqual("closed");
      expect(remoteEvents.closes).toEqual(1);

      // Assert: 保留中だった offerer 側の channel も pending-only association と共に閉じる。
      await c.waitFor(() => late.readyState === "closed");
      c.invariants();
    },
  );
});
