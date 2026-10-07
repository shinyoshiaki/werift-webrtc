import { getHostAddresses } from "../../src/utils";
import {
  createLocalTurnServer,
  createTestConnection,
  localRelayCandidates,
  localTurnOptions,
  turnAllocations,
} from "../utils";

const localTurnHost = getHostAddresses(true, false)[0]!;

describe("TURN allocation across ICE restart", () => {
  test("restart with unchanged TURN settings keeps the allocation", async () => {
    // Arrange: TURN 付きで一度 gather した connection を用意する
    const server = await createLocalTurnServer(localTurnHost);
    const connection = createTestConnection(true, localTurnOptions(server));
    try {
      await connection.gatherCandidates();
      const [before] = localRelayCandidates(connection);
      const [allocation] = turnAllocations(connection);

      // Act: 設定を変えずに ICE restart して gather し直す
      await connection.restart();
      await connection.gatherCandidates();

      // Assert: 新しい allocation は作らず、同じ relay candidate を新 generation で再広告する
      expect(turnAllocations(connection)).toEqual([allocation]);
      const after = localRelayCandidates(connection);
      expect(after).toHaveLength(1);
      expect([after[0].host, after[0].port]).toEqual([
        before.host,
        before.port,
      ]);
      expect(after[0].ufrag).toBe(connection.localUsername);
    } finally {
      await connection.close();
      await server.close();
    }
  });

  test("restart after a TURN server change replaces the stale allocation", async () => {
    // Arrange: 旧 TURN server で gather 済みの connection と、新しい TURN server を用意する
    const oldServer = await createLocalTurnServer(localTurnHost);
    const newServer = await createLocalTurnServer(localTurnHost);
    const connection = createTestConnection(true, localTurnOptions(oldServer));
    try {
      await connection.gatherCandidates();
      const [stale] = turnAllocations(connection);
      const closeStale = vi.spyOn(stale, "close");

      // Act: 新しい TURN server を設定してから ICE restart し、gather し直す
      connection.setIceServers(localTurnOptions(newServer));
      await connection.restart();
      await connection.gatherCandidates();

      // Assert: 旧 allocation は閉じて外し、新しい server の allocation だけが relay candidate を出す
      expect(closeStale).toHaveBeenCalled();
      const allocations = turnAllocations(connection);
      expect(allocations).toHaveLength(1);
      expect(allocations[0]).not.toBe(stale);
      expect(allocations[0].turn.server).toEqual(newServer.address);
      expect(localRelayCandidates(connection)).toHaveLength(1);
    } finally {
      await connection.close();
      await oldServer.close();
      await newServer.close();
    }
  });
});
