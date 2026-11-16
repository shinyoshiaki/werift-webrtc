import { describe, expect, test } from "vitest";

import {
  createLiteAgentStillGathering,
  createLiteAgentWithoutPeerCandidates,
  timeSettle,
} from "../utils";

// An ICE-lite agent sends no checks: with an empty check list it waits
// `incomingCheckTimeout` for the peer's first check, as a full agent does.
describe("ICE-lite with an empty check list", () => {
  test("fails when no check arrives within incomingCheckTimeout", async () => {
    // Arrange: lite 側は相手候補なし。full 側は connect しない (check が届かない)。
    const { full, lite } = await createLiteAgentWithoutPeerCandidates(0.3);
    try {
      // Act: lite 側だけ connect する。
      const { error, elapsedMs } = await timeSettle(lite.connect());

      // Assert: incomingCheckTimeout だけ待ってから失敗する。
      expect((error as Error).message).toBe("ICE negotiation failed");
      expect(elapsedMs).toBeGreaterThanOrEqual(250);
      expect(elapsedMs).toBeLessThan(5000);
      expect(lite.state).not.toBe("connected");
    } finally {
      await Promise.all([full.close(), lite.close()]);
    }
  });

  test("0 fails at once", async () => {
    // Arrange: lite 側は相手候補なし、待ち時間 0。
    const { full, lite } = await createLiteAgentWithoutPeerCandidates(0);
    try {
      // Act: lite 側だけ connect する。
      const { error, elapsedMs } = await timeSettle(lite.connect());

      // Assert: 待たずに失敗する。
      expect((error as Error).message).toBe("ICE negotiation failed");
      expect(elapsedMs).toBeLessThan(250);
    } finally {
      await Promise.all([full.close(), lite.close()]);
    }
  });

  test("connects through the full agent's check and nomination within the time", async () => {
    // Arrange: lite 側は相手候補なし (待ち時間 5 秒)。full 側は lite の候補を知っている。
    const { full, lite } = await createLiteAgentWithoutPeerCandidates(5);
    try {
      // Act: 両側で connect する。
      const [fullResult, liteResult] = await Promise.all([
        timeSettle(full.connect()),
        timeSettle(lite.connect()),
      ]);

      // Assert: lite は full の check で peer-reflexive の pair を学習し、nomination で接続する。
      expect(fullResult.error).toBeUndefined();
      expect(liteResult.error).toBeUndefined();
      expect(liteResult.elapsedMs).toBeLessThan(5000);
      expect(lite.state).toBe("connected");
      expect(lite.nominated?.remoteCandidate.type).toBe("prflx");

      // Assert: 選ばれた pair でデータが届く。
      const received = lite.onData.asPromise();
      await full.send(Buffer.from("full-to-lite"));
      expect((await received)[0].toString()).toBe("full-to-lite");
    } finally {
      await Promise.all([full.close(), lite.close()]);
    }
  });

  test("connect() right after gathering starts waits for the sockets and connects", async () => {
    // Arrange: lite 側の収集は始まったばかりで、まだソケットがない (待ち時間 5 秒)。
    const { full, lite, gathering } = await createLiteAgentStillGathering(5);
    try {
      expect((lite as any).protocols).toHaveLength(0);

      // Act: 収集の完了を待たずに lite 側で connect し、収集後に full 側も connect する。
      const connecting = timeSettle(lite.connect());
      await gathering;
      const fullResult = await timeSettle(full.connect());
      const liteResult = await connecting;

      // Assert: lite は即失敗せず、full の check と nomination で接続する。
      expect(liteResult.error).toBeUndefined();
      expect(fullResult.error).toBeUndefined();
      expect(lite.state).toBe("connected");
    } finally {
      await Promise.all([full.close(), lite.close()]);
    }
  });
});
