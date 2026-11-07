import { setTimeout as delay } from "node:timers/promises";

import {
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
  activeResourceCount,
  createSilentUdpServer,
  createTestConnection,
} from "../utils";

describe("close() during a TURN allocation", () => {
  test("releases the client socket and its retransmissions at once when the server never answers", async () => {
    // Arrange: 応答しない TURN server へ allocation を始めた agent。
    const server = await createSilentUdpServer();
    try {
      const socketsBefore = activeResourceCount("UDPWrap");
      const timersBefore = activeResourceCount("Timeout");
      const agent = createTestConnection(true, {
        turnServer: server.address,
        turnUsername: TURN_TEST_USERNAME,
        turnPassword: TURN_TEST_PASSWORD,
        forceTurn: true,
      });
      const gathering = agent.gatherCandidates().catch(() => undefined);
      await delay(100);
      expect(activeResourceCount("UDPWrap")).toBeGreaterThan(socketsBefore);

      // Act: allocation の途中で agent を閉じる。
      await agent.close();
      await gathering;
      await delay(50);

      // Assert: client の socket も再送の timer も残らない (allocation の timeout を待たない)。
      expect(activeResourceCount("UDPWrap")).toBe(socketsBefore);
      expect(activeResourceCount("Timeout")).toBeLessThanOrEqual(timersBefore);
    } finally {
      await server.close();
    }
  });
});
