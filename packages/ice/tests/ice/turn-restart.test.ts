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
  test("restart replaces the TURN allocation so a dead one can recover", async () => {
    // Arrange: TURN 付きで一度 gather した connection を用意する
    const server = await createLocalTurnServer(localTurnHost);
    const connection = createTestConnection(true, localTurnOptions(server));
    try {
      await connection.gatherCandidates();
      const [previous] = turnAllocations(connection);
      const closePrevious = vi.spyOn(previous, "close");

      // Act: 設定を変えずに ICE restart して gather し直す
      await connection.restart();
      await connection.gatherCandidates();

      // Assert: 旧 allocation は閉じて外し、新しい allocation の relay 候補だけを新 generation で出す
      expect(closePrevious).toHaveBeenCalled();
      const allocations = turnAllocations(connection);
      expect(allocations).toHaveLength(1);
      expect(allocations[0]).not.toBe(previous);
      const relay = localRelayCandidates(connection);
      expect(relay).toHaveLength(1);
      expect(relay[0].ufrag).toBe(connection.localUsername);
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
