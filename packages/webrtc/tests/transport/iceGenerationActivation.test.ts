import { describe, expect, test } from "vitest";

import {
  type ActivationWaiter,
  type ChecksEnd,
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
