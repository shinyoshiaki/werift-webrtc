import { describe, expect, test, vi } from "vitest";

import { IceRestartedError } from "../../src";

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

// start() runs connect() a microtask later: an end of the generation in
// between must cancel that request, not let it check the next generation.
describe("RTCIceTransport.start() whose generation ends before its checks start", () => {
  test.each(["local", "remote"] as const)(
    "a %s restart cancels it and the next generation's checks start once",
    async (restart) => {
      // Arrange: 2 は 1 の認証情報だけを持つ (1 の候補なし)。
      const { transport1, transport2 } =
        await createIceTransportsWithoutPeerCandidates(30);
      const connect = vi.spyOn(transport2.connection, "connect");
      try {
        // Act: start() の直後、同じ同期区間で ICE restart する。
        const old = transport2.start().then(
          () => undefined,
          (error: unknown) => error,
        );
        endIceTransportGeneration(transport1, transport2, restart);
        const oldError = await old;

        // Assert: 旧世代の start() は connect() を呼ばずに IceRestartedError で決着し、failed にしない。
        expect(oldError).toBeInstanceOf(IceRestartedError);
        expect(connect).not.toHaveBeenCalled();
        expect(transport2.state).not.toBe("failed");

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
