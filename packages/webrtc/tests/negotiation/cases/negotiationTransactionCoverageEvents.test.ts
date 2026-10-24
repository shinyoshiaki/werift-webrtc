import type { RTCDataChannel } from "../../../src";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  createDuplexSession,
  createInitialPranswerDataChannel,
  createKeptRemoteTransceiver,
  holdIncomingDcep,
  type NegotiationEvents,
  recordNegotiationEvents,
  registeredDataChannels,
} from "../harness/negotiationTransactionUtils";

/**
 * Observable events and speculative object lifetime of a negotiation
 * transaction (TICKET 2.1 replacement/rollback row, 2.3 and 5-4).
 */
describeCases("negotiation transaction events and object lifetime", () => {
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
