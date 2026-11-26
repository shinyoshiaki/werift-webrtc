import { setTimeout } from "timers/promises";

import { describe, expect, test, vi } from "vitest";

import { IceRestartedError } from "../../src";
import {
  type ConnectWaitPhase,
  exchangeGeneration,
  restartGeneration,
  startConnectWaitingIn,
} from "../utils";

// Invariant: when the generation connect() checks ends (local restart,
// remote-only restart, close), that connect() settles at once with the
// error of the end, checks none of the next generation's pairs, and the next
// generation connects on its own.

const phases: ConnectWaitPhase[] = [
  "empty",
  "scheduling",
  "completion",
  "lite",
];

describe("connect() when its generation ends", () => {
  describe.each(phases)("waiting in %s", (phase) => {
    test.each(["local", "remote"] as const)(
      "a %s restart cancels it and the next generation connects",
      async (end) => {
        // Arrange: b の connect() が phase の待ちに入っている。
        const { a, b, connecting, cleanup } =
          await startConnectWaitingIn(phase);
        try {
          // Act: 待機中に ICE restart する (新しい世代の候補はまだ届いていない)。
          const checkStart = vi.spyOn(b as any, "checkStart");
          await restartGeneration(a, b, end);
          const old = await connecting;

          // Assert: 旧世代の connect() は 1 秒以内に IceRestartedError で決着する。
          expect(old.error).toBeInstanceOf(IceRestartedError);
          expect(old.elapsedMs).toBeLessThan(1000);

          // Act: 新しい世代の候補と認証情報を交換し、connect() を始める前に少し待つ。
          exchangeGeneration(a, b);
          await setTimeout(200);

          // Assert: 旧世代の connect() は新しい世代の pair に check を送らない。
          expect(checkStart).not.toHaveBeenCalled();

          // Act: 新しい世代で両側が connect する。
          await Promise.all([a.connect(), b.connect()]);

          // Assert: 新しい世代は接続する。
          expect(a.state).toBe("connected");
          expect(b.state).toBe("connected");
        } finally {
          await cleanup();
        }
      },
    );

    test("close() fails it at once", async () => {
      // Arrange: b の connect() が phase の待ちに入っている。
      const { connecting, cleanup } = await startConnectWaitingIn(phase);

      // Act: 待機中に close する。
      await cleanup();
      const old = await connecting;

      // Assert: connect() は 1 秒以内に従来どおり "ICE negotiation failed" で決着する。
      expect(old.error).not.toBeInstanceOf(IceRestartedError);
      expect((old.error as Error).message).toBe("ICE negotiation failed");
      expect(old.elapsedMs).toBeLessThan(1000);
    });
  });
});
