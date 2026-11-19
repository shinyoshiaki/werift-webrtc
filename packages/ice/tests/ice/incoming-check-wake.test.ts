import { setTimeout } from "timers/promises";

import { describe, expect, test } from "vitest";

import { IceRestartedError } from "../../src";
import {
  createLiteAgentStillGathering,
  createLiteAgentWithoutPeerCandidates,
  createTcpOnlyConnections,
  exchangeTcpOnlyCandidates,
  timeSettle,
} from "../utils";

// Invariant of the wait on an empty check list (waitForIncomingCheck):
// (1) a pair being added continues at once, (2) the end of the local
// gathering without a socket fails at once, (3) the end of the generation
// settles at once with its error, (4) otherwise it fails at the
// `incomingCheckTimeout` deadline, which being woken does not extend.
// Every concurrent connect() of one generation wakes on its own.

describe("waitForIncomingCheck wake sources", () => {
  describe("ICE-lite still gathering", () => {
    test("a pair added by the peer's check continues to connected", async () => {
      // Arrange: lite の収集が始まったばかり (待ち時間 5 秒)。
      const { full, lite, gathering } = await createLiteAgentStillGathering(5);
      try {
        // Act: lite が収集中に connect し、収集後に full が connect する。
        const connecting = timeSettle(lite.connect());
        await gathering;
        await full.connect();
        const result = await connecting;

        // Assert: full の check で pair が追加され、lite は connected になる。
        expect(result.error).toBeUndefined();
        expect(lite.state).toBe("connected");
      } finally {
        await Promise.all([full.close(), lite.close()]);
      }
    });

    test("the gathering ending without a socket fails at once", async () => {
      // Arrange: lite はどのアドレスファミリーも使わない (ソケットが 1 つもできない)。待ち時間 3 秒。
      const { full, lite, gathering } = await createLiteAgentStillGathering(3, {
        useIpv4: false,
        useIpv6: false,
      });
      try {
        // Act: 収集中に connect し、収集の終了を待つ。
        const connecting = timeSettle(lite.connect());
        await gathering;
        const result = await connecting;

        // Assert: 待ち時間を待たず、収集の終了直後に失敗する。
        expect((lite as any).protocols).toHaveLength(0);
        expect((result.error as Error).message).toBe("ICE negotiation failed");
        expect(result.elapsedMs).toBeLessThan(1000);
      } finally {
        await Promise.all([full.close(), lite.close()]);
      }
    });

    test("the gathering ending with sockets but no pair keeps the original deadline", async () => {
      // Arrange: lite の収集が始まったばかり (待ち時間 0.6 秒)。相手の check は来ない。
      const { full, lite, gathering } =
        await createLiteAgentStillGathering(0.6);
      try {
        // Act: 収集中に connect し、収集の終了 (待機の起床) 後も check が来ないまま待つ。
        const connecting = timeSettle(lite.connect());
        await gathering;
        const result = await connecting;

        // Assert: 収集の終了では失敗せず、connect の開始から数えた期限 (0.6 秒) で失敗する。
        expect((lite as any).protocols.length).toBeGreaterThan(0);
        expect((result.error as Error).message).toBe("ICE negotiation failed");
        expect(result.elapsedMs).toBeGreaterThanOrEqual(550);
        expect(result.elapsedMs).toBeLessThan(900);
      } finally {
        await Promise.all([full.close(), lite.close()]);
      }
    });

    test.each([
      ["restart", IceRestartedError],
      ["close", Error],
    ] as const)(
      "the generation ending by %s settles it at once",
      async (end, errorType) => {
        // Arrange: lite の収集が始まったばかりで connect が待っている (待ち時間 30 秒)。
        const { full, lite, gathering } =
          await createLiteAgentStillGathering(30);
        try {
          const connecting = timeSettle(lite.connect());
          await gathering;

          // Act: 世代を終わらせる。
          if (end === "restart") await lite.restart();
          else await lite.close();
          const result = await connecting;

          // Assert: その世代のエラーで直ちに決着する。
          expect(result.error).toBeInstanceOf(errorType);
          if (end === "close") {
            expect((result.error as Error).message).toBe(
              "ICE negotiation failed",
            );
          }
          expect(result.elapsedMs).toBeLessThan(1000);
        } finally {
          await Promise.all([full.close(), lite.close()]);
        }
      },
    );
  });

  describe("two concurrent connect() of one generation", () => {
    test("ICE-lite after gathering: both settle right after the peer's check", async () => {
      // Arrange: lite は相手候補なし (待ち時間 3 秒)。
      const { full, lite } = await createLiteAgentWithoutPeerCandidates(3);
      try {
        // Act: lite で connect を 2 本並行に呼び、少し後に full が connect する。
        const first = timeSettle(lite.connect());
        const second = timeSettle(lite.connect());
        await setTimeout(100);
        await full.connect();
        const results = await Promise.all([first, second]);

        // Assert: 2 本とも待ち時間を待たずに接続で決着する。
        for (const result of results) {
          expect(result.error).toBeUndefined();
          expect(result.elapsedMs).toBeLessThan(2000);
        }
        expect(lite.state).toBe("connected");
      } finally {
        await Promise.all([full.close(), lite.close()]);
      }
    });

    test("full after gathering: both wake on the peer's check", async () => {
      // Arrange: b は a の候補を知らない (check list が空)。待ち時間 3 秒。
      const { a, b } = createTcpOnlyConnections({ incomingCheckTimeout: 3 });
      await exchangeTcpOnlyCandidates(a, b, () => false);
      try {
        // Act: b で connect を 2 本並行に呼び、少し後に a が connect する。
        const first = timeSettle(b.connect());
        const second = timeSettle(b.connect());
        await setTimeout(100);
        await a.connect();
        const results = await Promise.all([first, second]);

        // Assert: 2 本とも待ち時間を待たずに接続で決着し、b は connected になる。
        for (const result of results) {
          expect(result.error).toBeUndefined();
          expect(result.elapsedMs).toBeLessThan(2000);
        }
        expect(b.state).toBe("connected");
      } finally {
        await Promise.all([a.close(), b.close()]);
      }
    });
  });
});
