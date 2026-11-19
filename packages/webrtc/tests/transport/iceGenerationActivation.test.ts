import { describe, expect, test, vi } from "vitest";

import { IceRestartedError, RTCIceParameters } from "../../src";

import {
  type ActivationWaiter,
  type ChecksEnd,
  createIceTransportsWithoutPeerCandidates,
  endIceTransportGeneration,
  exchangeIceTransportGeneration,
  startActivationWaiting,
} from "../utils";

// Invariant: once the ICE generation `TransportActivation` awaits ends (a
// local or remote-only restart, or the transport retires), its outcome
// changes no state: neither connectionState "failed" nor "connected", and no
// DTLS start. The new generation's own connect reports it.

const waiters: ActivationWaiter[] = [
  "connect-start",
  "connect-waiter",
  "pending-start",
  "pending-waiter",
];
const ends: ChecksEnd[] = ["restart", "resetRemoteGeneration", "retire"];

describe("TransportActivation when the awaited ICE generation ends", () => {
  describe.each(waiters)("%s", (waiter) => {
    test.each(ends)("%s changes no state", async (how) => {
      // Arrange: TransportActivation が相手の check を待つ ICE の checks を待っている。
      const { dtlsTransport, setConnectionState, running, end, cleanup } =
        await startActivationWaiting(waiter);
      try {
        // Act: 待っている世代を終わらせる。
        const started = performance.now();
        await end(how);
        const { error } = await running;

        // Assert: 待ち手は速やかにエラーなしで終わる。
        expect(error).toBeUndefined();
        expect(performance.now() - started).toBeLessThan(1000);

        // Assert: 旧世代の結果で connectionState が failed / connected にならず、DTLS も始まらない。
        const states = setConnectionState.mock.calls.map(([state]) => state);
        expect(states).not.toContain("failed");
        expect(states).not.toContain("connected");
        expect(dtlsTransport.start).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
    });
  });
});

describe("TransportActivation.connect() whose ICE generation ends in the connecting event", () => {
  test("a remote restart with new credentials there starts no check of the new generation", async () => {
    // Arrange: connectionState "connecting" の同期購読者が remote restart し、新しい認証情報を設定する。
    const { transport2, dtlsTransport, setConnectionState, running, cleanup } =
      await startActivationWaiting("connect-start", (state, transport) => {
        if (state !== "connecting") return;
        transport.resetRemoteGeneration();
        transport.setRemoteParams(
          new RTCIceParameters({
            usernameFragment: "next",
            password: "next-generation-password",
          }),
        );
      });
    try {
      // Act: connect() の決着を待つ。
      const { error } = await running;

      // Assert: 旧世代の connect() は新しい世代の checks を始めず、状態も変えない。
      expect(error).toBeUndefined();
      expect(transport2.checksStarted).toBe(false);
      expect(transport2.state).not.toBe("failed");
      const states = setConnectionState.mock.calls.map(([state]) => state);
      expect(states).toEqual(["connecting"]);
      expect(dtlsTransport.start).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
});

// start() runs connect() a microtask later, and emits "checking" before
// that: an end of the generation in between (right after start(), or from a
// synchronous "checking" subscriber) must cancel the request, not let it
// check the next generation or set its state.
describe("RTCIceTransport.start() whose generation ends before its checks start", () => {
  const cases = (["local", "remote"] as const).flatMap((restart) =>
    (["after start()", "in the checking event"] as const).map((when) => ({
      restart,
      when,
    })),
  );
  test.each(cases)(
    "a $restart restart $when cancels it and the next generation's checks start once",
    async ({ restart, when }) => {
      // Arrange: 2 は 1 の認証情報だけを持つ (1 の候補なし)。
      const { transport1, transport2 } =
        await createIceTransportsWithoutPeerCandidates(30);
      const connect = vi.spyOn(transport2.connection, "connect");
      if (when === "in the checking event") {
        // Arrange: checking の同期購読者が ICE restart する。
        const { unSubscribe } = transport2.onStateChange.subscribe((state) => {
          if (state !== "checking") return;
          unSubscribe();
          endIceTransportGeneration(transport1, transport2, restart);
        });
      }
      try {
        // Act: start() し、after start() では同じ同期区間で ICE restart する。
        const old = transport2.start().then(
          () => undefined,
          (error: unknown) => error,
        );
        if (when === "after start()") {
          endIceTransportGeneration(transport1, transport2, restart);
        }
        const oldError = await old;

        // Assert: 旧世代の start() は connect() を呼ばずに IceRestartedError で決着し、failed にしない。
        expect(oldError).toBeInstanceOf(IceRestartedError);
        expect(connect).not.toHaveBeenCalled();
        expect(transport2.state).not.toBe("failed");
        expect(transport2.checksStarted).toBe(false);

        // Act: 新しい世代の候補と認証情報を交換し、両側を start する。
        await exchangeIceTransportGeneration(transport1, transport2, restart);
        await Promise.all([transport1.start(), transport2.start()]);

        // Assert: 新しい世代は接続し、2 の connect() は一度だけ呼ばれる。
        expect(transport1.state).toBe("connected");
        expect(transport2.state).toBe("connected");
        expect(connect).toHaveBeenCalledTimes(1);
      } finally {
        await Promise.all([transport1.stop(), transport2.stop()]);
      }
    },
  );

  test("a remote restart with the new credentials in the checking event leaves the new generation to its own start()", async () => {
    // Arrange: 1 は次の世代を収集済み。2 の checking の同期購読者が remote restart し、新しい認証情報を設定する。
    const { transport1, transport2 } =
      await createIceTransportsWithoutPeerCandidates(30);
    transport1.restart(false);
    await transport1.gather();
    const connect = vi.spyOn(transport2.connection, "connect");
    const { unSubscribe } = transport2.onStateChange.subscribe((state) => {
      if (state !== "checking") return;
      unSubscribe();
      transport2.resetRemoteGeneration();
      transport2.setRemoteParams(transport1.localParameters);
    });
    try {
      // Act: 旧世代で start() する。
      const oldError = await transport2.start().then(
        () => undefined,
        (error: unknown) => error,
      );

      // Assert: 旧世代の start() は新しい世代の connect() を呼ばず、failed にもしない。
      expect(oldError).toBeInstanceOf(IceRestartedError);
      expect(connect).not.toHaveBeenCalled();
      expect(transport2.state).not.toBe("failed");
      expect(transport2.checksStarted).toBe(false);

      // Act: 新しい世代の候補を交換し、両側を start する。
      transport2.localCandidates.forEach(transport1.addRemoteCandidate);
      transport1.localCandidates.forEach(transport2.addRemoteCandidate);
      transport1.setRemoteParams(transport2.localParameters);
      await Promise.all([transport1.start(), transport2.start()]);

      // Assert: 新しい世代は接続し、2 の connect() は一度だけ呼ばれる。
      expect(transport2.state).toBe("connected");
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all([transport1.stop(), transport2.stop()]);
    }
  });

  test("the new generation started in the new event of a remote restart keeps its single start", async () => {
    // Arrange: 2 の旧世代の start() が相手の check を待っている。1 は次の世代を収集済み。
    const { transport1, transport2 } =
      await createIceTransportsWithoutPeerCandidates(30);
    const old = transport2.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    transport1.restart(false);
    await transport1.gather();
    const connect = vi.spyOn(transport2.connection, "connect");
    let next: Promise<void> | undefined;
    const { unSubscribe } = transport2.onStateChange.subscribe((state) => {
      if (state !== "new") return;
      unSubscribe();
      // "new" の同期購読者が新しい世代の認証情報と候補を設定して start する。
      transport2.setRemoteParams(transport1.localParameters);
      transport1.localCandidates.forEach(transport2.addRemoteCandidate);
      next = transport2.start();
    });
    try {
      // Act: remote restart し、その後にもう一度 start() を呼ぶ (同じ世代の start は共有される)。
      transport2.resetRemoteGeneration();
      const again = transport2.start();
      transport2.localCandidates.forEach(transport1.addRemoteCandidate);
      transport1.setRemoteParams(transport2.localParameters);
      await Promise.all([transport1.start(), next, again]);

      // Assert: 旧世代は IceRestartedError で終わり、新しい世代の connect() は一度だけで接続する。
      expect(await old).toBeInstanceOf(IceRestartedError);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(transport2.state).toBe("connected");
    } finally {
      await Promise.all([transport1.stop(), transport2.stop()]);
    }
  });

  test("stop() cancels it without starting checks", async () => {
    // Arrange: 2 は 1 の認証情報だけを持つ (1 の候補なし)。
    const { transport1, transport2 } =
      await createIceTransportsWithoutPeerCandidates(30);
    const connect = vi.spyOn(transport2.connection, "connect");
    try {
      // Act: start() の直後、同じ同期区間で stop する。
      const old = transport2.start().then(
        () => undefined,
        (error: unknown) => error,
      );
      const stopping = transport2.stop();
      const oldError = await old;
      await stopping;

      // Assert: start() は connect() を呼ばずに失敗で決着し、transport は closed のまま。
      expect(oldError).toBeInstanceOf(Error);
      expect(connect).not.toHaveBeenCalled();
      expect(transport2.state).toBe("closed");
    } finally {
      await Promise.all([transport1.stop(), transport2.stop()]);
    }
  });
});
