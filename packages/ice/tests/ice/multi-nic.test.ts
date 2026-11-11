import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Connection } from "../../src/ice";
import {
  canBindAddress,
  createInterfaceBoundConnection,
  createTestConnection,
  fakeNetworkInterfaces,
  inviteAccept,
  recordUdpRequestSources,
  udpHostCandidatesWithBinding,
} from "../utils";

// 疑似 NIC: テストごとに os.networkInterfaces() の結果を差し替える
const nics = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    networkInterfaces: () => nics.current ?? actual.networkInterfaces(),
  };
});

const useNics = (map: Record<string, string[]>) => {
  nics.current = fakeNetworkInterfaces(map);
};

const advertised = (connection: Connection) =>
  connection.localCandidates.map((c) => `${c.host}:${c.port}`);

/** Shared Arrange: 疑似マルチ NIC の agent A と 127.0.0.1 に明示 bind した agent B */
async function connectMultiNic(
  bInterfaceAddresses: { udp4?: string; udp6?: string } = {
    udp4: "127.0.0.1",
  },
) {
  const a = createTestConnection(true);
  const b = createInterfaceBoundConnection(false, bInterfaceAddresses);
  await inviteAccept(a, b);
  const sourcesAtB = recordUdpRequestSources(b);
  const sourcesAtA = recordUdpRequestSources(a);
  await Promise.all([a.connect(), b.connect()]);
  return { a, b, sourcesAtA, sourcesAtB };
}

describe("multi-NIC host candidates without interfaceAddresses", () => {
  beforeEach(async (context) => {
    if (!(await canBindAddress("127.0.0.2"))) {
      context.skip();
    }
  });
  afterEach(() => {
    nics.current = undefined;
  });

  test("each host socket is bound to the address it advertises", async () => {
    // Arrange: 127.0.0.1 / 127.0.0.2 を別 NIC として見せる
    useNics({ eth0: ["127.0.0.1"], eth1: ["127.0.0.2"] });
    const connection = createTestConnection(true);

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: NIC ごとに host candidate があり、bind 先 IP/port と一致する
      const hosts = udpHostCandidatesWithBinding(connection);
      expect(hosts.map((h) => h.candidate[0])).toEqual([
        "127.0.0.1",
        "127.0.0.2",
      ]);
      for (const host of hosts) {
        expect(host.bound).toEqual(host.candidate);
        expect(host.localIp).toBe(host.candidate[0]);
      }
    } finally {
      await connection.close();
    }
  });

  test("connectivity checks leave from the advertised candidates, so no prflx is learned", async () => {
    // Arrange: 疑似マルチ NIC の agent A。先に check される eth0 を 127.0.0.2 にし、
    // 宛先 127.0.0.1 へのルーティング上の送信元 (127.0.0.1) と異なるアドレスにする
    useNics({ eth0: ["127.0.0.2"], eth1: ["127.0.0.1"] });

    // Act: 127.0.0.1 に明示 bind した agent B と接続する
    const { a, b, sourcesAtA, sourcesAtB } = await connectMultiNic();

    try {
      // Assert: B が受けた check の送信元はすべて A の広告 candidate のどれか
      expect(sourcesAtB.length).toBeGreaterThan(0);
      for (const [host, port] of sourcesAtB) {
        expect(advertised(a)).toContain(`${host}:${port}`);
      }
      // Assert: 127.0.0.2 の candidate からの check は 127.0.0.2 から届く
      expect(sourcesAtB.some(([host]) => host === "127.0.0.2")).toBe(true);
      for (const [host, port] of sourcesAtA) {
        expect(advertised(b)).toContain(`${host}:${port}`);
      }
      // Assert: 送信元不一致による peer-reflexive candidate は生まれない
      expect(b.remoteCandidates.filter((c) => c.type === "prflx")).toEqual([]);
      expect(a.remoteCandidates.filter((c) => c.type === "prflx")).toEqual([]);
      // Assert: 選択ペアの local / remote は双方の広告 candidate と一致する
      const nominatedA = a.nominated!;
      const nominatedB = b.nominated!;
      expect(advertised(a)).toContain(
        `${nominatedA.localCandidate.host}:${nominatedA.localCandidate.port}`,
      );
      expect(advertised(b)).toContain(
        `${nominatedA.remoteCandidate.host}:${nominatedA.remoteCandidate.port}`,
      );
      expect(advertised(a)).toContain(
        `${nominatedB.remoteCandidate.host}:${nominatedB.remoteCandidate.port}`,
      );
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("a failed bind drops only that address and keeps no socket for it", async () => {
    // Arrange: このホストに存在しない TEST-NET-1 アドレスを別 NIC に混ぜる
    useNics({ eth0: ["127.0.0.1"], eth1: ["192.0.2.1"] });
    const connection = createTestConnection(true);
    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: bind に失敗したアドレスは広告されず、他 NIC の candidate は残る
      expect(connection.localCandidates.map((c) => c.host)).toEqual([
        "127.0.0.1",
      ]);
      // Assert: 保持する UDP host ソケットも広告済みの 1 つだけ (失敗分は保持しない)
      expect(udpHostCandidatesWithBinding(connection)).toHaveLength(1);
    } finally {
      await connection.close();
    }
  });

  test("IPv4 and IPv6 host sockets are each bound to their advertised address", async (context) => {
    // Arrange: ::1 に bind できる環境で IPv4 / IPv6 の疑似 NIC を用意する
    if (!(await canBindAddress("::1"))) {
      context.skip();
    }
    useNics({ eth0: ["127.0.0.1", "::1"], eth1: ["127.0.0.2"] });

    // Act: IPv4 / IPv6 の両方に明示 bind した agent B と接続する
    const { a, b, sourcesAtB } = await connectMultiNic({
      udp4: "127.0.0.1",
      udp6: "::1",
    });

    try {
      // Assert: 各ファミリーの candidate は bind 先と一致する
      const hosts = udpHostCandidatesWithBinding(a);
      expect(new Set(hosts.map((h) => h.candidate[0]))).toEqual(
        new Set(["127.0.0.1", "127.0.0.2", "::1"]),
      );
      for (const host of hosts) {
        expect(host.bound).toEqual(host.candidate);
      }
      // Assert: 送信元は広告 candidate と一致し、prflx は生まれない
      for (const [host, port] of sourcesAtB) {
        expect(advertised(a)).toContain(`${host}:${port}`);
      }
      expect(b.remoteCandidates.filter((c) => c.type === "prflx")).toEqual([]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("ICE restart reuses the per-address sockets", async () => {
    // Arrange: 疑似マルチ NIC で一度収集済みの agent
    useNics({ eth0: ["127.0.0.1"], eth1: ["127.0.0.2"] });
    const connection = createTestConnection(true);
    await connection.gatherCandidates();
    const before = udpHostCandidatesWithBinding(connection);

    try {
      // Act: ICE restart 後に再収集する
      await connection.restart();
      await connection.gatherCandidates();

      // Assert: ソケット数は変わらず、同じ bind 先で再広告される
      const after = udpHostCandidatesWithBinding(connection);
      expect(after).toEqual(before);
      expect(advertised(connection)).toEqual(
        before.map((h) => `${h.candidate[0]}:${h.candidate[1]}`),
      );
    } finally {
      await connection.close();
    }
  });

  test("each socket binds its own address within portRange", async () => {
    // Arrange: portRange 付きの疑似マルチ NIC の agent
    useNics({ eth0: ["127.0.0.1"], eth1: ["127.0.0.2"] });
    const portRange: [number, number] = [45200, 45300];
    const connection = createTestConnection(true, { portRange });

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: 各ソケットは具体 IP に bind され、ポートは範囲内
      const hosts = udpHostCandidatesWithBinding(connection);
      expect(hosts.map((h) => h.bound[0])).toEqual(["127.0.0.1", "127.0.0.2"]);
      for (const host of hosts) {
        expect(host.bound).toEqual(host.candidate);
        expect(host.bound[1]).toBeGreaterThanOrEqual(portRange[0]);
        expect(host.bound[1]).toBeLessThanOrEqual(portRange[1]);
      }
    } finally {
      await connection.close();
    }
  });

  test("an additional host address not assigned locally is still advertised over a wildcard socket", async () => {
    // Arrange: ローカルにない 1:1 NAT 公開 IP を追加アドレスに指定する
    useNics({ eth0: ["127.0.0.1"] });
    const connection = createTestConnection(true, {
      additionalHostAddresses: ["203.0.113.10"],
    });

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: 追加アドレスは wildcard ソケットで広告され、列挙アドレスは具体 bind
      const hosts = udpHostCandidatesWithBinding(connection);
      const additional = hosts.find((h) => h.candidate[0] === "203.0.113.10");
      const local = hosts.find((h) => h.candidate[0] === "127.0.0.1");
      expect(additional?.bound[0]).toBe("0.0.0.0");
      expect(additional?.candidate[1]).toBe(additional?.bound[1]);
      expect(local?.bound).toEqual(local?.candidate);
    } finally {
      await connection.close();
    }
  });

  test("an additional host address assigned to an excluded NIC is bound to itself", async () => {
    // Arrange: tun0 は候補列挙から除外されるが、127.0.0.2 はローカルに割り当て済み
    useNics({ eth0: ["127.0.0.1"], tun0: ["127.0.0.2"] });
    const connection = createTestConnection(true, {
      additionalHostAddresses: ["127.0.0.2"],
    });

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: 割り当て済みの追加アドレスは wildcard ではなくそのアドレスに bind される
      const hosts = udpHostCandidatesWithBinding(connection);
      const additional = hosts.find((h) => h.candidate[0] === "127.0.0.2");
      expect(additional?.bound).toEqual(additional?.candidate);
      expect(additional?.localIp).toBe("127.0.0.2");
    } finally {
      await connection.close();
    }
  });

  test("an explicit wildcard interface address keeps wildcard sockets without advertising the wildcard", async () => {
    // Arrange: 疑似マルチ NIC で udp4 を 0.0.0.0 に明示した agent
    useNics({ eth0: ["127.0.0.1"], eth1: ["127.0.0.2"] });
    const connection = createInterfaceBoundConnection(true, {
      udp4: "0.0.0.0",
    });

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: 列挙アドレスが wildcard ソケットで広告され、0.0.0.0 は広告されない
      const hosts = udpHostCandidatesWithBinding(connection);
      expect(hosts.map((h) => h.candidate[0])).toEqual([
        "127.0.0.1",
        "127.0.0.2",
      ]);
      for (const host of hosts) {
        expect(host.bound[0]).toBe("0.0.0.0");
        expect(host.candidate[1]).toBe(host.bound[1]);
      }
    } finally {
      await connection.close();
    }
  });
});
