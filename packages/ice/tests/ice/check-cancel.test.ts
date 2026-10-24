import { setTimeout as delay } from "node:timers/promises";

import { createUnansweredCheckAgent } from "../utils";

describe("connectivity checks of a replaced checklist", () => {
  test("a restart stops the retransmissions of the checks in flight", async () => {
    // Arrange: 応答のない相手への check が再送待ちになっている agent。
    const { agent, transactions } = await createUnansweredCheckAgent();
    void agent.connect().catch(() => undefined);
    await delay(100);
    expect(transactions()).toBeGreaterThan(0);

    try {
      // Act: ICE restart で checklist を置き換える。
      await agent.restart();
      await delay(50);

      // Assert: 置き換えた checklist の check は再送をやめ、待っている transaction が残らない。
      expect(transactions()).toBe(0);
    } finally {
      await agent.close();
    }
  });
});
