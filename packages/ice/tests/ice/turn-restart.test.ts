import { getHostAddresses } from "../../src/utils";
import { Candidate } from "../../src/candidate";
import {
  createConnectedRelayOnlyPair,
  createLocalTurnServer,
  deliverLocalCandidates,
  exchangeIceCredentials,
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

  test("a relay-only restart whose new allocation completes after the peer's end-of-candidates nominates and carries data", async () => {
    // Arrange: relay-only で接続済みの pair。b の TURN 通信は proxy で止められる。
    const { a, b, proxy, close } = await createConnectedRelayOnlyPair();
    try {
      // Act: 両側を restart する。a は新しい allocation を済ませ、b の allocation は保留する。
      proxy.hold();
      await Promise.all([a.restart(), b.restart()]);
      await a.gatherCandidates();
      const gathering = b.gatherCandidates();
      exchangeIceCredentials(a, b);
      // Act: a の候補と end-of-candidates が、b のローカル候補より先に b へ届く。
      await deliverLocalCandidates(a, b, { endOfCandidates: true });
      b.onIceCandidate.subscribe((candidate) => {
        void a.addRemoteCandidate(Candidate.fromSdp(candidate.toSdp()));
      });
      const connecting = Promise.all([a.connect(), b.connect()]);
      // Act: 接続確認が始まってから b の allocation を完了させる。
      await new Promise((resolve) => setTimeout(resolve, 200));
      proxy.release();
      await gathering;
      await a.addRemoteCandidate(undefined);
      await connecting;

      // Assert: 両側が新 generation の relay pair を nominate する。
      for (const connection of [a, b]) {
        expect(connection.nominated?.localCandidate.type).toBe("relay");
        expect(connection.nominated?.localCandidate.ufrag).toBe(
          connection.localUsername,
        );
      }
      // Assert: relay 経由で双方向にデータが届く。
      const received = { ab: false, ba: false };
      a.onData.subscribe((data) => {
        if (data.toString() === "ba") received.ba = true;
      });
      b.onData.subscribe((data) => {
        if (data.toString() === "ab") received.ab = true;
      });
      for (let i = 0; i < 50 && !(received.ab && received.ba); i++) {
        await Promise.all([
          a.send(Buffer.from("ab")),
          b.send(Buffer.from("ba")),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(received).toEqual({ ab: true, ba: true });
    } finally {
      await close();
    }
  }, 30000);
});
