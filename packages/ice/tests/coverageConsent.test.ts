import type { Connection } from "../src/ice";
import { atFirstSelection, createTestConnection, inviteAccept } from "./utils";

/**
 * Spec coverage (ticket 2.8 "ICE の状態と consent"): the successful
 * connectivity check that selects a pair is its initial consent
 * (RFC 7675 section 5.1), so application data may flow from the selection.
 */
describe("initial consent", () => {
  test.each([
    ["controlling", true],
    ["controlled", false],
  ] as const)(
    "[2.8-14] the check that selects a pair lets the %s agent send at once, before any consent request",
    async (_, controllingSends) => {
      // Arrange: host 候補だけの 2 つの agent と、選択直後に送信する sender 側の hook。
      const a = createTestConnection(true);
      const b = createTestConnection(false);
      const [sender, receiver]: Connection[] = controllingSends
        ? [a, b]
        : [b, a];
      try {
        await inviteAccept(a, b);
        const text = `initial-consent-${controllingSends ? "a" : "b"}`;
        const received = receiver.onData.watch(
          (data) => data.toString() === text,
          2000,
        );
        const atSelection = atFirstSelection(sender, (pair) => {
          const observed = {
            consentRequestsSent: pair.consentRequestsSent,
            packetsSent: pair.packetsSent,
          };
          // Act: pair を選んだ直後 (consent request を 1 回も送る前) に送信する。
          void sender.send(Buffer.from(text));
          return observed;
        });

        // Act: 接続確認を始める。
        const connected = Promise.all([a.connect(), b.connect()]);
        const observed = await atSelection;
        await received;
        await connected;

        // Assert: 選択時点では consent request を 1 回も送っていない。
        expect(observed.consentRequestsSent).toBe(0);
        expect(observed.packetsSent).toBe(0);
        // Assert: 選択を決めた check の成功が初期 consent なので、その送信は実際に相手へ届く。
        expect(sender.nominated!.packetsSent).toBeGreaterThanOrEqual(1);
      } finally {
        await a.close();
        await b.close();
      }
    },
  );
});
