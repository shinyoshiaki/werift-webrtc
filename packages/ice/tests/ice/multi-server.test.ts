import type { Address } from "../../../common/src";
import { normalizeIceServerOptions } from "../../src/iceBase";
import { getHostAddresses } from "../../src/utils";
import {
  createCountingStunServer,
  createCountingTurnServer,
  createFixedMappingStunServer,
  createSilentUdpServer,
  createTestConnection,
  getClosedTcpPort,
  getLocalTurnClientTlsOptions,
  localReflexiveCandidates,
  localRelayCandidates,
  localTurnServerEntry,
  turnAllocations,
} from "../utils";

const localHost = getHostAddresses(true, false)[0]!;
/** One IPv4 UDP host socket, so every STUN query comes from one base. */
const singleSocket = {
  useIpv6: false,
  interfaceAddresses: { udp4: localHost },
} as const;

describe("normalizeIceServerOptions", () => {
  test("単数形を先頭に、複数形を設定順で並べ、重複を除く", () => {
    // Arrange
    const options = {
      stunServer: ["stun-a.example.com", 3478] as Address,
      stunServers: [
        ["stun-b.example.com", 3478],
        ["stun-a.example.com", 3478],
        ["stun-c.example.com", 3478],
      ] as Address[],
      turnServer: ["turn-a.example.com", 3478] as Address,
      turnUsername: "user-a",
      turnPassword: "pass-a",
      turnServers: [
        {
          address: ["turn-b.example.com", 5349] as Address,
          username: "user-b",
          password: "pass-b",
          transport: "tls" as const,
        },
        {
          address: ["turn-a.example.com", 3478] as Address,
          username: "user-a",
          password: "pass-a",
          transport: "udp" as const,
        },
      ],
    };

    // Act
    const normalized = normalizeIceServerOptions(options);

    // Assert: 単数形が先頭、続いて複数形の順。重複 (同じ STUN / 同じ TURN 設定) は 1 件
    expect(normalized.stunServers).toEqual([
      ["stun-a.example.com", 3478],
      ["stun-b.example.com", 3478],
      ["stun-c.example.com", 3478],
    ]);
    expect(normalized.turnServers).toEqual([
      {
        address: ["turn-a.example.com", 3478],
        username: "user-a",
        password: "pass-a",
        transport: "udp",
      },
      {
        address: ["turn-b.example.com", 5349],
        username: "user-b",
        password: "pass-b",
        transport: "tls",
      },
    ]);
  });

  test("不正なアドレスと credential のない TURN は除外する", () => {
    // Arrange
    const options = {
      stunServers: [
        ["", 3478],
        ["stun.example.com", 3478],
      ] as Address[],
      turnServers: [
        {
          address: ["turn-a.example.com", 3478] as Address,
          username: "",
          password: "pass-a",
        },
        {
          address: ["turn-b.example.com", 3478] as Address,
          username: "user-b",
          password: "pass-b",
        },
      ],
    };

    // Act
    const normalized = normalizeIceServerOptions(options);

    // Assert: 有効な要素だけが残り、transport の省略は "udp" になる
    expect(normalized.stunServers).toEqual([["stun.example.com", 3478]]);
    expect(normalized.turnServers).toEqual([
      {
        address: ["turn-b.example.com", 3478],
        username: "user-b",
        password: "pass-b",
        transport: "udp",
      },
    ]);
  });
});

describe("gathering from multiple STUN servers", () => {
  test("両方の STUN server が Binding request を受け、同じマッピングの srflx は 1 件にまとまる", async () => {
    // Arrange
    const first = await createCountingStunServer(localHost);
    const second = await createCountingStunServer(localHost);
    const connection = createTestConnection(true, {
      ...singleSocket,
      stunServers: [first.address!, second.address!],
    });
    try {
      // Act
      await connection.gatherCandidates();

      // Assert: 2 つの server がどちらも問い合わせを受けている
      expect(first.bindingRequests.length).toBeGreaterThan(0);
      expect(second.bindingRequests.length).toBeGreaterThan(0);
      // Assert: 同じ (host, port) のマッピングは冗長候補として 1 件だけ出る
      expect(localReflexiveCandidates(connection)).toHaveLength(1);
    } finally {
      await connection.close();
      await first.close();
      await second.close();
    }
  });

  test("宛先ごとに異なるマッピングはそれぞれ srflx 候補になり、restart でも全件を再広告する", async () => {
    // Arrange: 別々のマッピングを返す 2 つの STUN server (宛先ごとにマッピングする NAT 相当)
    const first = await createFixedMappingStunServer(localHost, [
      "203.0.113.1",
      40001,
    ]);
    const second = await createFixedMappingStunServer(localHost, [
      "203.0.113.2",
      40002,
    ]);
    const connection = createTestConnection(true, {
      ...singleSocket,
      stunServers: [first.address, second.address],
    });
    try {
      // Act
      await connection.gatherCandidates();

      // Assert: マッピングごとに srflx が 1 件ずつ出る
      const mapped = (candidates: { host: string; port: number }[]) =>
        candidates.map(({ host, port }) => [host, port]);
      expect(mapped(localReflexiveCandidates(connection))).toEqual(
        expect.arrayContaining([
          ["203.0.113.1", 40001],
          ["203.0.113.2", 40002],
        ]),
      );
      expect(localReflexiveCandidates(connection)).toHaveLength(2);

      // Act: ICE restart して保持したソケットで gather し直す
      await connection.restart();
      await connection.gatherCandidates();

      // Assert: 両方のマッピングを新しい ufrag で 1 件ずつ出し直し、両 server に再び問い合わせる
      const restarted = localReflexiveCandidates(connection);
      expect(restarted).toHaveLength(2);
      expect(
        restarted.every(
          (candidate) => candidate.ufrag === connection.localUsername,
        ),
      ).toBe(true);
      expect(first.bindingRequests.length).toBeGreaterThan(1);
      expect(second.bindingRequests.length).toBeGreaterThan(1);
    } finally {
      await connection.close();
      await first.close();
      await second.close();
    }
  });

  test("1 つ目の STUN server が応答しなくても 2 つ目から srflx が得られ gathering が完了する", async () => {
    // Arrange: 1 つ目は受信するだけで応答しない server
    const unreachable = await createSilentUdpServer(localHost);
    const reachable = await createCountingStunServer(localHost);
    const connection = createTestConnection(true, {
      ...singleSocket,
      stunGatherTimeout: 1,
      stunServers: [unreachable.address, reachable.address!],
    });
    try {
      // Act
      await connection.gatherCandidates();

      // Assert: gathering は完了し、2 つ目の server の srflx が出ている
      expect(connection.localCandidatesEnd).toBe(true);
      expect(reachable.bindingRequests.length).toBeGreaterThan(0);
      expect(localReflexiveCandidates(connection)).toHaveLength(1);
    } finally {
      await connection.close();
      await unreachable.close();
      await reachable.close();
    }
  });
});

describe("gathering from multiple TURN servers", () => {
  test("両方の TURN server が Allocate を受け、relay 候補が 2 件できる", async () => {
    // Arrange
    const first = await createCountingTurnServer(localHost);
    const second = await createCountingTurnServer(localHost);
    const connection = createTestConnection(true, {
      forceTurn: true,
      turnServers: [localTurnServerEntry(first), localTurnServerEntry(second)],
    });
    try {
      // Act
      await connection.gatherCandidates();

      // Assert: 各 server が Allocate を受け、それぞれの allocation から relay 候補が出る
      expect(first.allocateRequests.length).toBeGreaterThan(0);
      expect(second.allocateRequests.length).toBeGreaterThan(0);
      expect(localRelayCandidates(connection)).toHaveLength(2);
      expect(
        turnAllocations(connection).map(
          (allocation) => allocation.turn.configuredServer,
        ),
      ).toEqual(
        expect.arrayContaining([first.address, second.address] as Address[]),
      );
    } finally {
      await connection.close();
      await first.close();
      await second.close();
    }
  });

  test("各 TURN server は自分の credential だけで認証される", async () => {
    // Arrange: それぞれ自分のユーザーしか知らない server (取り違えると 401)
    const first = await createCountingTurnServer(localHost, {
      credentials: { "user-a": "pass-a" },
    });
    const second = await createCountingTurnServer(localHost, {
      credentials: { "user-b": "pass-b" },
    });
    const connection = createTestConnection(true, {
      forceTurn: true,
      turnServers: [
        localTurnServerEntry(first, { username: "user-a", password: "pass-a" }),
        localTurnServerEntry(second, {
          username: "user-b",
          password: "pass-b",
        }),
      ],
    });
    try {
      // Act
      await connection.gatherCandidates();

      // Assert: 各 server には自分のユーザー名だけが届き、どちらも認証に成功する
      const usernames = (server: typeof first) =>
        server.allocateRequests.flatMap(({ username }) =>
          username ? [username] : [],
        );
      expect(new Set(usernames(first))).toEqual(new Set(["user-a"]));
      expect(new Set(usernames(second))).toEqual(new Set(["user-b"]));
      expect(first.authenticatedUsernames).toContain("user-a");
      expect(second.authenticatedUsernames).toContain("user-b");
      expect(localRelayCandidates(connection)).toHaveLength(2);
    } finally {
      await connection.close();
      await first.close();
      await second.close();
    }
  });

  test("UDP / TCP / TLS を同時に設定すると、それぞれの transport で Allocate する", async () => {
    // Arrange: UDP / TCP / TLS を受ける TURN server と、3 つの transport の設定
    const server = await createCountingTurnServer(localHost, { tls: true });
    const connection = createTestConnection(true, {
      forceTurn: true,
      turnTlsOptions: getLocalTurnClientTlsOptions(),
      turnServers: [
        localTurnServerEntry(server, { transport: "udp" }),
        localTurnServerEntry(server, { transport: "tcp" }),
        localTurnServerEntry(server, { transport: "tls" }),
      ],
    });
    try {
      // Act
      await connection.gatherCandidates();

      // Assert: 3 つの transport それぞれで Allocate が届き、relay 候補が 3 件できる
      expect(
        new Set(server.allocateRequests.map(({ transport }) => transport)),
      ).toEqual(new Set(["udp", "tcp", "tls"]));
      expect(localRelayCandidates(connection)).toHaveLength(3);
    } finally {
      await connection.close();
      await server.close();
    }
  }, 20_000);

  test("1 つ目の TURN server に到達できなくても 2 つ目の relay 候補ができる", async () => {
    // Arrange: 1 つ目は待ち受けのない TCP ポート
    const closedPort = await getClosedTcpPort(localHost);
    const reachable = await createCountingTurnServer(localHost);
    const connection = createTestConnection(true, {
      forceTurn: true,
      turnServers: [
        {
          address: closedPort,
          username: "unused",
          password: "unused",
          transport: "tcp",
        },
        localTurnServerEntry(reachable),
      ],
    });
    try {
      // Act
      await connection.gatherCandidates();

      // Assert: gathering は完了し、2 つ目の server の relay 候補だけが出る
      expect(connection.localCandidatesEnd).toBe(true);
      expect(reachable.allocateRequests.length).toBeGreaterThan(0);
      const allocations = turnAllocations(connection);
      expect(allocations).toHaveLength(1);
      expect(allocations[0].turn.configuredServer).toEqual(reachable.address);
      expect(localRelayCandidates(connection)).toHaveLength(1);
    } finally {
      await connection.close();
      await reachable.close();
    }
  });

  test("同じ TURN server の UDP / TCP から TCP だけ残した暫定世代は、UDP の allocation を使わない", async () => {
    // Arrange: 同じアドレス・credential で UDP と TCP の 2 つを gather 済みの connection
    const server = await createCountingTurnServer(localHost);
    const connection = createTestConnection(true, {
      forceTurn: true,
      turnServers: [
        localTurnServerEntry(server, { transport: "udp" }),
        localTurnServerEntry(server, { transport: "tcp" }),
      ],
    });
    try {
      await connection.gatherCandidates();
      const allocations = turnAllocations(connection);
      expect(allocations).toHaveLength(2);
      const allows = (
        generation: unknown,
        protocol: (typeof allocations)[number],
      ) =>
        (
          connection as unknown as {
            allowsProvisional(g: unknown, p: unknown): boolean;
          }
        ).allowsProvisional(generation, protocol);
      const byTransport = (transport: "udp" | "tcp") =>
        allocations.find(
          ({ configuredTransport }) => configuredTransport === transport,
        )!;

      // Act: TCP だけを残す設定の暫定世代で、各 allocation が許可されるか調べる
      const tcpOnly = {
        gatherOptions: {
          forceTurn: true,
          turnServers: [localTurnServerEntry(server, { transport: "tcp" })],
        },
      };

      // Assert: TCP の allocation だけ許可され、削除した UDP は許可されない
      expect(allows(tcpOnly, byTransport("tcp"))).toBe(true);
      expect(allows(tcpOnly, byTransport("udp"))).toBe(false);
    } finally {
      await connection.close();
      await server.close();
    }
  });

  test("setIceServers + ICE restart で複数の TURN server が置き換わり、古い allocation はすべて閉じる", async () => {
    // Arrange: TURN A / B の 2 つで gather 済みの connection と、置き換え先の TURN C
    const first = await createCountingTurnServer(localHost);
    const second = await createCountingTurnServer(localHost);
    const replacement = await createCountingTurnServer(localHost);
    const connection = createTestConnection(true, {
      forceTurn: true,
      turnServers: [localTurnServerEntry(first), localTurnServerEntry(second)],
    });
    try {
      await connection.gatherCandidates();
      const previous = turnAllocations(connection);
      expect(previous).toHaveLength(2);
      const closes = previous.map((allocation) =>
        vi.spyOn(allocation, "close"),
      );

      // Act: サーバー一覧を TURN C だけに置き換えて ICE restart し、gather し直す
      connection.setIceServers({
        turnServers: [localTurnServerEntry(replacement)],
      });
      await connection.restart();
      await connection.gatherCandidates();

      // Assert: Connection のサーバー一覧は C だけになる
      expect(connection.turnServers.map(({ address }) => address)).toEqual([
        replacement.address,
      ]);
      // Assert: 旧 allocation は 2 件とも閉じて外れ、C の allocation だけが relay 候補を出す
      for (const close of closes) expect(close).toHaveBeenCalled();
      const allocations = turnAllocations(connection);
      expect(allocations).toHaveLength(1);
      expect(allocations[0].turn.configuredServer).toEqual(replacement.address);
      expect(replacement.allocateRequests.length).toBeGreaterThan(0);
      const relay = localRelayCandidates(connection);
      expect(relay).toHaveLength(1);
      expect(relay[0].ufrag).toBe(connection.localUsername);
    } finally {
      await connection.close();
      await first.close();
      await second.close();
      await replacement.close();
    }
  });

  test("setIceServers は配列フィールドも完全に置き換え、STUN だけの更新で TURN が残らない", () => {
    // Arrange
    const connection = createTestConnection(true, {
      stunServers: [["stun-a.example.com", 3478]],
      turnServers: [
        {
          address: ["turn-a.example.com", 3478],
          username: "user-a",
          password: "pass-a",
        },
        {
          address: ["turn-b.example.com", 3478],
          username: "user-b",
          password: "pass-b",
        },
      ],
    });
    try {
      // Act
      connection.setIceServers({ stunServers: [["stun-b.example.com", 3478]] });

      // Assert: STUN は新しい一覧に置き換わり、TURN と credential は残らない
      expect(connection.stunServers).toEqual([["stun-b.example.com", 3478]]);
      expect(connection.turnServers).toEqual([]);
      expect(connection.options.turnServers).toBeUndefined();
      expect(connection.gathersFromServers).toBe(true);
    } finally {
      void connection.close();
    }
  });
});
