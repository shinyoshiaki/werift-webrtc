import { describe, expect, test } from "vitest";

import { resolveHostAddresses } from "../../src/internal/resolveHostAddresses";
import { getHostAddresses } from "../../src/utils";
import {
  canBindIpv6Loopback,
  createInterfaceBoundConnection,
  inviteAccept,
  udpHostCandidatesWithBinding,
} from "../utils";

describe("interfaceAddresses host candidates", () => {
  test("udp4 interface address is advertised with the bound address and port", async () => {
    // Arrange: 列挙対象外 (internal) の 127.0.0.1 に bind する agent
    const connection = createInterfaceBoundConnection(true, {
      udp4: "127.0.0.1",
    });

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: UDP host candidate は bind アドレスと一致する 1 つだけ
      const hosts = udpHostCandidatesWithBinding(connection);
      expect(hosts).toHaveLength(1);
      expect(hosts[0].candidate).toEqual(hosts[0].bound);
      expect(hosts[0].candidate[0]).toBe("127.0.0.1");
      // Assert: ICE restart の重複排除に使う localIp も同じアドレス
      expect(hosts[0].localIp).toBe("127.0.0.1");
      // Assert: LAN など別アドレスの candidate は advertise されない
      expect(connection.localCandidates.map((c) => c.host)).toEqual([
        "127.0.0.1",
      ]);
    } finally {
      await connection.close();
    }
  });

  test("udp6 interface address is advertised with the bound address and port", async (context) => {
    // Arrange: ::1 に bind できる環境でのみ実行する
    if (!(await canBindIpv6Loopback())) {
      context.skip();
    }
    const connection = createInterfaceBoundConnection(true, { udp6: "::1" });

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: UDP host candidate は bind アドレスと一致する ::1 の 1 つだけ
      const hosts = udpHostCandidatesWithBinding(connection);
      expect(hosts).toHaveLength(1);
      expect(hosts[0].candidate).toEqual(hosts[0].bound);
      expect(hosts[0].candidate[0]).toBe("::1");
      // Assert: 指定のない IPv4 の列挙アドレスは収集しない (従来挙動の維持)
      expect(connection.localCandidates.map((c) => c.host)).toEqual(["::1"]);
    } finally {
      await connection.close();
    }
  });

  test("ICE restart keeps the single interface-bound UDP socket", async () => {
    // Arrange: 127.0.0.1 に bind して一度収集済みの agent
    const connection = createInterfaceBoundConnection(true, {
      udp4: "127.0.0.1",
    });
    await connection.gatherCandidates();
    const [before] = udpHostCandidatesWithBinding(connection);

    try {
      // Act: ICE restart 後に再収集する
      await connection.restart();
      await connection.gatherCandidates();

      // Assert: ソケットは増えず、同じアドレスとポートで再 advertise される
      const after = udpHostCandidatesWithBinding(connection);
      expect(after).toHaveLength(1);
      expect(after[0].candidate).toEqual(before.candidate);
      expect(connection.localCandidates.map((c) => c.host)).toEqual([
        "127.0.0.1",
      ]);
    } finally {
      await connection.close();
    }
  });

  test("candidate port is the bound port within portRange", async () => {
    // Arrange: portRange 付きで 127.0.0.1 に bind する agent
    const portRange: [number, number] = [45000, 45100];
    const connection = createInterfaceBoundConnection(
      true,
      { udp4: "127.0.0.1" },
      { portRange },
    );

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: candidate のポートは実際の bind ポートで、範囲内にある
      const [host] = udpHostCandidatesWithBinding(connection);
      expect(host.candidate[1]).toBe(host.bound[1]);
      expect(host.candidate[1]).toBeGreaterThanOrEqual(portRange[0]);
      expect(host.candidate[1]).toBeLessThanOrEqual(portRange[1]);
    } finally {
      await connection.close();
    }
  });

  test("additionalHostAddresses other than the bound address are ignored", async () => {
    // Arrange: bind アドレスと異なる IPv4 の追加アドレスを指定する
    const connection = createInterfaceBoundConnection(
      true,
      { udp4: "127.0.0.1" },
      { additionalHostAddresses: ["127.0.0.1", "192.0.2.1"] },
    );

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: 重複排除された bind アドレスの candidate だけが出る
      expect(connection.localCandidates.map((c) => c.host)).toEqual([
        "127.0.0.1",
      ]);
    } finally {
      await connection.close();
    }
  });

  test("TCP host candidates use the interface address", async () => {
    // Arrange: TCP も有効にして 127.0.0.1 を指定する
    const connection = createInterfaceBoundConnection(
      true,
      { udp4: "127.0.0.1" },
      { useTcp: true },
    );

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: UDP / TCP いずれの host candidate も指定アドレスだけ
      const candidates = connection.localCandidates;
      expect(new Set(candidates.map((c) => c.transport))).toEqual(
        new Set(["udp", "tcp"]),
      );
      expect(new Set(candidates.map((c) => c.host))).toEqual(
        new Set(["127.0.0.1"]),
      );
    } finally {
      await connection.close();
    }
  });

  test("a failed bind to the interface address advertises no host candidate", async () => {
    // Arrange: このホストに存在しない (TEST-NET-1) アドレスを指定する
    const connection = createInterfaceBoundConnection(
      true,
      { udp4: "192.0.2.123" },
      { useIpv6: false },
    );

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: 別アドレスへフォールバックせず、host candidate は 0 個
      expect(connection.localCandidates).toEqual([]);
    } finally {
      await connection.close();
    }
  });

  test("without interfaceAddresses, every enumerated address gets a host candidate", async () => {
    // Arrange: 明示指定なし (列挙アドレスごとに具体 bind) の agent
    const enumerated = getHostAddresses(true, false);
    const connection = createInterfaceBoundConnection(true, undefined, {
      useIpv6: false,
    });

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: 列挙アドレスごとに host candidate があり、wildcard は出ない
      const hosts = udpHostCandidatesWithBinding(connection);
      expect(new Set(hosts.map((h) => h.candidate[0]))).toEqual(
        new Set(enumerated),
      );
      for (const host of hosts) {
        expect(["0.0.0.0", "::"]).not.toContain(host.candidate[0]);
        // Assert: 各ソケットは広告アドレスそのものに bind されている
        expect(host.candidate).toEqual(host.bound);
        expect(host.localIp).toBe(host.candidate[0]);
      }
    } finally {
      await connection.close();
    }
  });

  test("two agents connect using only their interface-bound candidates", async () => {
    // Arrange: 双方 127.0.0.1 に bind した agent
    const a = createInterfaceBoundConnection(
      true,
      { udp4: "127.0.0.1" },
      { useIpv6: false },
    );
    const b = createInterfaceBoundConnection(
      false,
      { udp4: "127.0.0.1" },
      { useIpv6: false },
    );

    try {
      // Act: candidate を交換して接続する
      await inviteAccept(a, b);
      await Promise.all([a.connect(), b.connect()]);

      // Assert: 指定アドレスの candidate pair が選ばれ、データが届く
      expect(a.nominated?.localCandidate.host).toBe("127.0.0.1");
      expect(b.nominated?.localCandidate.host).toBe("127.0.0.1");
      const received = new Promise<Buffer>((resolve) =>
        b.onData.subscribe(resolve),
      );
      await a.send(Buffer.from("ping"));
      expect((await received).toString()).toBe("ping");
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("resolveHostAddresses", () => {
  const enumerated = ["192.0.2.10", "198.51.100.20", "2001:db8::1"];

  test("an additional address assigned locally but not enumerated is bound to itself; an unassigned one uses wildcard", () => {
    // Arrange: 127.0.0.2 は列挙から除外された割り当て済みアドレス
    // Act: 解決する
    const addresses = resolveHostAddresses({
      enumerated: ["192.0.2.1"],
      assigned: ["192.0.2.1", { address: "127.0.0.2" }],
      additionalHostAddresses: ["127.0.0.2", "203.0.113.10"],
      useIpv4: true,
      useIpv6: true,
    });

    // Assert: 割り当て済みは個別 bind、未割り当ての NAT 公開 IP は wildcard
    expect(addresses).toEqual([
      { address: "127.0.0.2", bind: "enumerated", bindAddress: "127.0.0.2" },
      { address: "203.0.113.10", bind: "wildcard" },
      { address: "192.0.2.1", bind: "enumerated", bindAddress: "192.0.2.1" },
    ]);
  });

  test("another notation of a locally assigned IPv6 address is bound to itself and not duplicated", () => {
    // Arrange: 列挙は短縮表記、追加アドレスは同じ IP の展開・大文字表記
    // Act: 解決する
    const addresses = resolveHostAddresses({
      enumerated: [{ address: "2001:db8::1" }],
      assigned: [{ address: "::1" }],
      additionalHostAddresses: ["2001:0DB8:0:0:0:0:0:1", "0:0:0:0:0:0:0:1"],
      useIpv4: true,
      useIpv6: true,
    });

    // Assert: どちらも個別 bind（wildcard にならず）、同一 IP は 1 件に重複排除される
    expect(addresses).toEqual([
      {
        address: "2001:db8::1",
        bind: "enumerated",
        bindAddress: "2001:db8::1",
      },
      { address: "::1", bind: "enumerated", bindAddress: "::1" },
    ]);
  });

  test("an expanded IPv6 wildcard is treated like `::` and is never advertised", () => {
    // Arrange: udp6 を `::` と展開表記で指定する 2 構成
    const resolve = (udp6: string) =>
      resolveHostAddresses({
        enumerated: [{ address: "2001:db8::1" }],
        interfaceAddresses: { udp6 },
        additionalHostAddresses: ["::1"],
        useIpv4: false,
        useIpv6: true,
      });

    // Act: それぞれ解決する
    const compressed = resolve("::");
    const expanded = resolve("0:0:0:0:0:0:0:0");

    // Assert: 同じ結果になり、wildcard 自体は広告されず列挙・追加アドレスが wildcard で収集される
    expect(expanded).toEqual(compressed);
    expect(expanded).toEqual([
      { address: "2001:db8::1", bind: "wildcard" },
      { address: "::1", bind: "wildcard" },
    ]);
  });

  test("without interfaceAddresses, enumerated addresses are bound and other additional addresses use wildcard", () => {
    // Act: 明示指定なしで解決する
    const addresses = resolveHostAddresses({
      enumerated,
      additionalHostAddresses: ["127.0.0.1", "192.0.2.10"],
      useIpv4: true,
      useIpv6: true,
    });

    // Assert: additional を先頭に重複排除してマージし、列挙済みアドレスは具体 bind、
    // 列挙にない追加アドレスだけ wildcard になる
    expect(addresses).toEqual([
      { address: "127.0.0.1", bind: "wildcard" },
      { address: "192.0.2.10", bind: "enumerated", bindAddress: "192.0.2.10" },
      {
        address: "198.51.100.20",
        bind: "enumerated",
        bindAddress: "198.51.100.20",
      },
      {
        address: "2001:db8::1",
        bind: "enumerated",
        bindAddress: "2001:db8::1",
      },
    ]);
  });

  test("an enumerated link-local address keeps its zone as the bind address", () => {
    // Act: zone 付き bind アドレスを持つ列挙結果で解決する
    const addresses = resolveHostAddresses({
      enumerated: [{ address: "fe80::1", bindAddress: "fe80::1%eth0" }],
      useIpv4: true,
      useIpv6: true,
    });

    // Assert: 広告アドレスは zone なし、bind アドレスは zone 付き
    expect(addresses).toEqual([
      { address: "fe80::1", bind: "enumerated", bindAddress: "fe80::1%eth0" },
    ]);
  });

  test("an empty interfaceAddresses object behaves as unspecified", () => {
    // Act: ファミリー指定のない空オブジェクトで解決する
    const addresses = resolveHostAddresses({
      enumerated,
      interfaceAddresses: {},
      useIpv4: true,
      useIpv6: true,
    });

    // Assert: 列挙アドレスがそのまま具体 bind で使われる
    expect(addresses.map((a) => [a.address, a.bind])).toEqual(
      enumerated.map((address) => [address, "enumerated"]),
    );
  });

  test("an explicit address not in the enumeration is used without fallback", () => {
    // Act: 列挙に含まれない udp4 を指定して解決する
    const addresses = resolveHostAddresses({
      enumerated,
      interfaceAddresses: { udp4: "100.64.0.1" },
      useIpv4: true,
      useIpv6: true,
    });

    // Assert: 指定アドレスだけになり、未指定の IPv6 列挙アドレスも除外される
    expect(addresses).toEqual([{ address: "100.64.0.1", bind: "explicit" }]);
  });

  test("partial specification keeps additional addresses of the unspecified family", () => {
    // Arrange: 指定ファミリーと未指定ファミリーの追加アドレスを混ぜる
    const logs: unknown[][] = [];

    // Act: udp4 だけを指定して解決する
    const addresses = resolveHostAddresses({
      enumerated,
      interfaceAddresses: { udp4: "100.64.0.1" },
      additionalHostAddresses: ["100.64.0.1", "10.0.0.1", "::1"],
      useIpv4: true,
      useIpv6: true,
      log: (...args) => logs.push(args),
    });

    // Assert: 指定ファミリーは指定アドレスのみ、未指定ファミリーの追加分は残る
    expect(addresses).toEqual([
      { address: "100.64.0.1", bind: "explicit" },
      { address: "::1", bind: "wildcard" },
    ]);
    // Assert: 無視した追加アドレスはログに残る
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("10.0.0.1");
  });

  test("both families specified use exactly the two explicit addresses", () => {
    // Act: udp4 / udp6 を両方指定して解決する
    const addresses = resolveHostAddresses({
      enumerated,
      interfaceAddresses: { udp4: "100.64.0.1", udp6: "fd7a::1" },
      useIpv4: true,
      useIpv6: true,
    });

    // Assert: 各ファミリーの指定アドレスだけになる
    expect(addresses).toEqual([
      { address: "100.64.0.1", bind: "explicit" },
      { address: "fd7a::1", bind: "explicit" },
    ]);
  });

  test("an explicit address of a disabled family is not used", () => {
    // Act: useIpv6 を無効にして udp6 を指定する
    const addresses = resolveHostAddresses({
      enumerated,
      interfaceAddresses: { udp4: "100.64.0.1", udp6: "fd7a::1" },
      useIpv4: true,
      useIpv6: false,
    });

    // Assert: 無効なファミリーの指定アドレスは含まれない
    expect(addresses).toEqual([{ address: "100.64.0.1", bind: "explicit" }]);
  });

  test("an explicit wildcard address gathers the family's enumerated addresses over wildcard sockets", () => {
    // Act: udp4 に 0.0.0.0 を明示して解決する
    const addresses = resolveHostAddresses({
      enumerated,
      interfaceAddresses: { udp4: "0.0.0.0" },
      additionalHostAddresses: ["203.0.113.10"],
      useIpv4: true,
      useIpv6: true,
    });

    // Assert: 0.0.0.0 自体は広告せず、IPv4 の列挙・追加アドレスを wildcard で収集する
    expect(addresses).toEqual([
      { address: "192.0.2.10", bind: "wildcard" },
      { address: "198.51.100.20", bind: "wildcard" },
      { address: "203.0.113.10", bind: "wildcard" },
    ]);
  });
});
