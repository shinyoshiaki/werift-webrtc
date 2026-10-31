import { StunOverTurnProtocol, TurnProtocol } from "../../src/turn/protocol";
import { getHostAddresses } from "../../src/utils";
import {
  collectGarbage,
  createHeldUdpProxy,
  createInterfaceBoundConnection,
  createLocalTurnServer,
  createTestConnection,
  localRelayCandidates,
  localTurnOptions,
  proxiedTurnOptions,
  remoteHostCandidate,
  turnAllocations,
} from "../utils";

const localTurnHost = getHostAddresses(true, false)[0]!;

/**
 * A gather an ICE restart left running in the background (STUN / TURN) must
 * not act on the generation that replaced it, nor on a closed agent.
 */
describe("gathering bound to its ICE generation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a gather replaced by a restart neither completes nor joins the next generation", async () => {
    // Arrange: TURN で gather 済みの connection を用意し、1 回目の restart の
    // allocation を proxy1、2 回目を proxy2 で保留する
    const server = await createLocalTurnServer(localTurnHost);
    const proxy1 = await createHeldUdpProxy(server.address!);
    const proxy2 = await createHeldUdpProxy(server.address!);
    const connection = createTestConnection(true, localTurnOptions(server));
    const closed = vi.spyOn(StunOverTurnProtocol.prototype, "close");
    const closedClients = vi.spyOn(TurnProtocol.prototype, "close");
    try {
      await connection.gatherCandidates();
      const [initial] = turnAllocations(connection);
      connection.setIceServers(proxiedTurnOptions(proxy1));
      await connection.restart();
      const first = connection.gatherCandidates();
      connection.setIceServers(proxiedTurnOptions(proxy2));
      await connection.restart();
      const second = connection.gatherCandidates();

      // Act: 置き換えられた 1 回目の gather の allocation を先に完了させる
      proxy1.release();
      await first;

      // Assert: 1 回目の gather は新 generation を完了扱いにせず、relay 候補も
      // allocation も新 generation に入れない。できた allocation は閉じる
      expect(connection.localCandidatesEnd).toBe(false);
      expect(turnAllocations(connection)).toHaveLength(0);
      expect(localRelayCandidates(connection)).toHaveLength(0);
      const closedAllocations = new Set(closed.mock.contexts);
      expect(closedAllocations.has(initial)).toBe(true);
      expect(closedAllocations.size).toBe(2);

      // Act: 新 generation の gather を完了させる
      proxy2.release();
      await second;

      // Assert: 新 generation は自分の allocation 1 つで完了する
      expect(connection.localCandidatesEnd).toBe(true);
      const [current] = turnAllocations(connection);
      expect(turnAllocations(connection)).toHaveLength(1);
      expect(closedAllocations.has(current)).toBe(false);
      const relay = localRelayCandidates(connection);
      expect(relay).toHaveLength(1);
      expect(relay[0].generation).toBe(connection.generation);
    } finally {
      await connection.close();
      proxy1.close();
      proxy2.close();
      await server.close();
    }
  });

  test("close() during a restart gather leaves no TURN allocation", async () => {
    // Arrange: restart 後の TURN allocation を proxy で保留したまま gather を始める
    const server = await createLocalTurnServer(localTurnHost);
    const proxy = await createHeldUdpProxy(server.address!);
    const connection = createTestConnection(true, localTurnOptions(server));
    const closed = vi.spyOn(StunOverTurnProtocol.prototype, "close");
    const closedClients = vi.spyOn(TurnProtocol.prototype, "close");
    try {
      await connection.gatherCandidates();
      const [initial] = turnAllocations(connection);
      connection.setIceServers(proxiedTurnOptions(proxy));
      await connection.restart();
      const gathering = connection.gatherCandidates();

      // Act: gather 中に close し、その後で allocation を完了させる
      await connection.close();
      proxy.release();
      // Assert: gather は close で待たずに終わる。
      await gathering;

      // Assert: 保留中の allocation は完了を待たずに close で client ごと閉じ (socket と
      // 再送 timer も止まる)、connection に入らない。closed の agent は gather を完了扱いにしない
      const clients = () => new Set(closedClients.mock.contexts);
      for (let i = 0; i < 100 && clients().size < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(turnAllocations(connection)).toHaveLength(0);
      expect(connection.localCandidatesEnd).toBe(false);
      expect(new Set(closed.mock.contexts).has(initial)).toBe(true);
      expect(clients().has(initial.turn)).toBe(true);
      expect(clients().size).toBe(2);
    } finally {
      proxy.close();
      await server.close();
    }
  });

  test("gathering that finishes while the checks run does not move the state", async () => {
    // Arrange: TURN allocation を proxy で保留したまま、応答しない相手への接続確認を始める
    const server = await createLocalTurnServer(localTurnHost);
    const proxy = await createHeldUdpProxy(server.address!);
    // 解放しない proxy は接続確認に応答しない相手になる
    const silentPeer = await createHeldUdpProxy(server.address!);
    const connection = createTestConnection(true, {
      ...proxiedTurnOptions(proxy),
      forceTurn: false,
    });
    const states: string[] = [];
    connection.stateChanged.subscribe((state) => states.push(state));
    try {
      const gathering = connection.gatherCandidates();
      await vi.waitFor(() =>
        expect(connection.localCandidates.length).toBeGreaterThan(0),
      );
      connection.remoteUsername = "remote";
      connection.remotePassword = "remote-password-remote";
      connection.remoteCandidates = [
        remoteHostCandidate(silentPeer.address[1], silentPeer.address[0]),
      ];
      void connection.connect().catch(() => undefined);

      // Act: 接続確認の実行中に gather (TURN allocation) を完了させる
      proxy.release();
      await gathering;

      // Assert: 接続確認の結果が出るまで、遅れて終わった gather は state を動かさない
      expect(states).not.toContain("completed");
      expect(connection.state).toBe("new");
    } finally {
      await connection.close();
      proxy.close();
      silentPeer.close();
      await server.close();
    }
  });

  test("終わった gathering の結果は、その後の ICE restart をまたいで保持されない", async () => {
    // Arrange: gathering ごとに一意の目印も一緒に解決させ、目印は WeakRef だけで追う。
    const connection = createInterfaceBoundConnection(true, {
      udp4: "127.0.0.1",
    });
    const markers: WeakRef<object>[] = [];
    const internal = connection as unknown as {
      getCandidatePromises: (...args: unknown[]) => Promise<unknown>[];
    };
    const original = internal.getCandidatePromises.bind(connection);
    internal.getCandidatePromises = (...args: unknown[]) => {
      const marker = { gathering: markers.length };
      markers.push(new WeakRef(marker));
      return [...original(...args), Promise.resolve(marker)];
    };

    try {
      // Act: gathering と ICE restart を繰り返し、各 gathering を完了させる。
      for (let i = 0; i < 5; i++) {
        await connection.gatherCandidates();
        await connection.restart();
      }
      await collectGarbage();

      // Assert: 完了した gathering の結果 (目印) は、agent が閉じる前でも解放される。
      expect(markers).toHaveLength(5);
      expect(markers.filter((ref) => ref.deref() !== undefined)).toEqual([]);
    } finally {
      await connection.close();
    }
  }, 20_000);
});
