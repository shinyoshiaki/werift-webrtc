import { Connection } from "../../src/ice";
import { recordLookupHosts } from "../utils";

describe("Connection gather without STUN", () => {
  test("stunServer 省略時は DNS lookup せず host 候補だけで収集を終える", async () => {
    // Arrange: STUN 未指定。STUN 待ちが起きれば検出できるよう timeout を長くする
    const lookups = recordLookupHosts();
    const connection = new Connection(true, { stunGatherTimeout: 30 });

    try {
      // Act: 候補を収集し、かかった時間を測る
      const started = Date.now();
      await connection.gatherCandidates();
      const elapsed = Date.now() - started;

      // Assert: STUN / TURN の名前解決は一度も起きない
      expect(lookups.hosts).toEqual([]);
      // Assert: 収集は完了し、host 候補だけが出る
      expect(connection.localCandidatesEnd).toBe(true);
      expect(connection.localCandidates.length).toBeGreaterThan(0);
      expect(
        connection.localCandidates.every(
          (candidate) => candidate.type === "host",
        ),
      ).toBe(true);
      // Assert: stunGatherTimeout (30 秒) を待たずに終わる
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      lookups.restore();
      await connection.close();
    }
  });
});
