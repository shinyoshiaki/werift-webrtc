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
    // Arrange: 明示指定なし (wildcard bind) の agent
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
        expect(host.candidate[1]).toBe(host.bound[1]);
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

  test("without interfaceAddresses, merges additional addresses with enumerated ones", () => {
    // Act: 明示指定なしで解決する
    const addresses = resolveHostAddresses({
      enumerated,
      additionalHostAddresses: ["127.0.0.1", "192.0.2.10"],
      useIpv4: true,
      useIpv6: true,
    });

    // Assert: 従来どおり additional を先頭に重複排除してマージする
    expect(addresses).toEqual([
      "127.0.0.1",
      "192.0.2.10",
      "198.51.100.20",
      "2001:db8::1",
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

    // Assert: 列挙アドレスがそのまま使われる
    expect(addresses).toEqual(enumerated);
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
    expect(addresses).toEqual(["100.64.0.1"]);
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
    expect(addresses).toEqual(["100.64.0.1", "::1"]);
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
    expect(addresses).toEqual(["100.64.0.1", "fd7a::1"]);
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
    expect(addresses).toEqual(["100.64.0.1"]);
  });
});
