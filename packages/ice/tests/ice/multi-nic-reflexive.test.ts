import * as dgram from "node:dgram";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { UdpTransport } from "../../../common/src";
import type { Candidate } from "../../src/candidate";
import type { Connection } from "../../src/ice";
import { HostLocalPreference } from "../../src/internal/hostPreference";
import {
  canBindAddress,
  createInterfaceBoundConnection,
  createSelectiveStunServer,
  createTestConnection,
  fakeNetworkInterfaces,
  inviteAccept,
} from "../utils";

// 疑似 NIC と既定経路: テストごとに差し替える
const env = vi.hoisted(() => ({
  nics: undefined as Record<string, unknown> | undefined,
  defaultRoutes: undefined as string[] | undefined,
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    networkInterfaces: () => env.nics ?? actual.networkInterfaces(),
  };
});
vi.mock("../../src/internal/defaultRoute", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/internal/defaultRoute")>();
  return {
    ...actual,
    getDefaultRouteAddresses: async (
      ...args: Parameters<typeof actual.getDefaultRouteAddresses>
    ) => env.defaultRoutes ?? actual.getDefaultRouteAddresses(...args),
  };
});

const useNics = (map: Record<string, string[]>) => {
  env.nics = fakeNetworkInterfaces(map);
};

const srflxOf = (connection: Connection) =>
  connection.localCandidates.filter((c) => c.type === "srflx");
const hostsOf = (connection: Connection) =>
  connection.localCandidates.filter(
    (c) => c.type === "host" && c.transport === "udp",
  );
const localPreferenceOf = (candidate: Candidate) =>
  (candidate.priority >> 8) & 0xffff;

/** Shared Arrange: 127.0.0.2 からの問い合わせには応答しない STUN server */
const stunUnreachableFrom127002 = () =>
  createSelectiveStunServer("127.0.0.1", ["127.0.0.2"]);

describe("multi-NIC server-reflexive gathering", () => {
  beforeEach(async (context) => {
    if (!(await canBindAddress("127.0.0.2"))) {
      context.skip();
    }
    // 既定経路はどの疑似 NIC にもない (テストごとに上書きする)
    env.defaultRoutes = [];
  });
  afterEach(() => {
    env.nics = undefined;
    env.defaultRoutes = undefined;
    vi.restoreAllMocks();
  });

  test("a wildcard socket maps the route the OS picks and advertises no host candidate", async () => {
    // Arrange: 列挙される NIC (127.0.0.2) からは STUN に届かず、実際の出口は
    // 列挙されないアドレス (127.0.0.1) だけ
    useNics({ eth1: ["127.0.0.2"] });
    const stun = await stunUnreachableFrom127002();
    const connection = createTestConnection(true, {
      stunServer: stun.address,
      stunGatherTimeout: 1,
      useIpv6: false,
    });

    try {
      // Act: candidate を収集し、バックグラウンドの問い合わせも終わらせる
      await connection.gatherCandidates();
      await connection.waitForLocalCandidatesEnd();

      // Assert: host は列挙アドレスだけで、wildcard アドレスは広告しない
      expect(hostsOf(connection).map((c) => c.host)).toEqual(["127.0.0.2"]);
      // Assert: wildcard socket の srflx が 1 つ取れ、base は 0.0.0.0 として広告される
      const srflx = srflxOf(connection);
      expect(srflx).toHaveLength(1);
      expect(srflx[0].host).toBe("127.0.0.1");
      expect(srflx[0].relatedAddress).toBe("0.0.0.0");
      expect(hostsOf(connection).map((c) => c.port)).not.toContain(
        srflx[0].relatedPort,
      );
    } finally {
      await connection.close();
      await stun.close();
    }
  });

  test("gathering waits only for the representative sockets; the other sockets trickle before end-of-candidates", async () => {
    // Arrange: eth1 (127.0.0.2) からは STUN に届かない疑似マルチ NIC
    useNics({ eth0: ["127.0.0.1"], eth1: ["127.0.0.2"] });
    const stun = await stunUnreachableFrom127002();
    const connection = createTestConnection(true, {
      stunServer: stun.address,
      stunGatherTimeout: 2,
      useIpv6: false,
    });
    const emitted: Candidate[] = [];
    connection.onIceCandidate.subscribe((candidate) => {
      emitted.push(candidate);
    });

    try {
      // Act: candidate を収集する
      const started = Date.now();
      await connection.gatherCandidates();
      const gathered = Date.now() - started;

      // Assert: 届かない NIC の timeout を待たずに返り、end-of-candidates はまだ
      expect(gathered).toBeLessThan(1500);
      expect(connection.localCandidatesEnd).toBe(false);
      expect(srflxOf(connection).map((c) => c.relatedAddress)).toContain(
        "0.0.0.0",
      );

      // Act: バックグラウンドの問い合わせが終わるのを待つ
      await connection.waitForLocalCandidatesEnd();
      const ended = Date.now() - started;

      // Assert: end-of-candidates は届かない NIC の timeout の後
      expect(connection.localCandidatesEnd).toBe(true);
      expect(ended).toBeGreaterThanOrEqual(1900);
      // Assert: 届く NIC の srflx は trickle され、届かない NIC の srflx はない
      const bases = srflxOf(connection).map((c) => c.relatedAddress);
      expect(bases).toContain("127.0.0.1");
      expect(bases).not.toContain("127.0.0.2");
      expect(emitted).toEqual(connection.localCandidates);
    } finally {
      await connection.close();
      await stun.close();
    }
  });

  test("the default-route socket is waited for too, so a host whose NICs all reach STUN ends gathering at once", async () => {
    // Arrange: 既定経路は eth0 (127.0.0.1) で、どの NIC からも STUN に届く
    useNics({ eth0: ["127.0.0.1"] });
    env.defaultRoutes = ["127.0.0.1"];
    const stun = await createSelectiveStunServer("127.0.0.1");
    const connection = createTestConnection(true, {
      stunServer: stun.address,
      stunGatherTimeout: 2,
      useIpv6: false,
    });

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: wildcard socket と既定経路の socket の srflx が揃い、end-of-candidates も済んでいる
      expect(
        srflxOf(connection)
          .map((c) => c.relatedAddress)
          .sort(),
      ).toEqual(["0.0.0.0", "127.0.0.1"]);
      expect(connection.localCandidatesEnd).toBe(true);
    } finally {
      await connection.close();
      await stun.close();
    }
  });

  test("without a wildcard socket the default-route socket stands for the family", async () => {
    // Arrange: wildcard socket の bind が失敗し、既定経路は eth0 (127.0.0.1)
    useNics({ eth0: ["127.0.0.1"], eth1: ["127.0.0.2"] });
    env.defaultRoutes = ["127.0.0.1"];
    const init = UdpTransport.init.bind(UdpTransport);
    vi.spyOn(UdpTransport, "init").mockImplementation(async (type, options) => {
      if (!options?.bindAddress && !options?.interfaceAddresses) {
        throw new Error("wildcard bind failed (test)");
      }
      return init(type, options);
    });
    const stun = await stunUnreachableFrom127002();
    const connection = createTestConnection(true, {
      stunServer: stun.address,
      stunGatherTimeout: 2,
      useIpv6: false,
    });

    try {
      // Act: candidate を収集する
      const started = Date.now();
      await connection.gatherCandidates();
      const gathered = Date.now() - started;

      // Assert: 既定経路の socket の srflx を待って返り、届かない NIC は待たない
      expect(gathered).toBeLessThan(1500);
      expect(srflxOf(connection).map((c) => c.relatedAddress)).toEqual([
        "127.0.0.1",
      ]);
      expect(connection.localCandidatesEnd).toBe(false);

      // Act: バックグラウンドの問い合わせが終わるのを待つ
      await connection.waitForLocalCandidatesEnd();

      // Assert: end-of-candidates になる
      expect(connection.localCandidatesEnd).toBe(true);
    } finally {
      await connection.close();
      await stun.close();
    }
  });

  test("the default-route address gets the highest host priority and a costly network the lowest", async (context) => {
    if (!(await canBindAddress("127.0.0.3"))) {
      context.skip();
    }
    // Arrange: 既定経路は eth1、tun0 は VPN (costly) の疑似 NIC
    useNics({
      eth0: ["127.0.0.1"],
      eth1: ["127.0.0.2"],
      tun0: ["127.0.0.3"],
    });
    env.defaultRoutes = ["127.0.0.2"];
    const connection = createTestConnection(true, { useIpv6: false });

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: costly な NIC も host candidate に含まれる
      const hosts = hostsOf(connection);
      const byHost = Object.fromEntries(hosts.map((c) => [c.host, c]));
      expect(Object.keys(byHost).sort()).toEqual([
        "127.0.0.1",
        "127.0.0.2",
        "127.0.0.3",
      ]);
      // Assert: 既定経路 > 通常 NIC > costly の順に local preference が下がる
      expect(localPreferenceOf(byHost["127.0.0.2"])).toBe(
        HostLocalPreference.defaultRoute,
      );
      expect(localPreferenceOf(byHost["127.0.0.1"])).toBe(
        HostLocalPreference.normal,
      );
      expect(localPreferenceOf(byHost["127.0.0.3"])).toBe(
        HostLocalPreference.costly,
      );
    } finally {
      await connection.close();
    }
  });

  test("the default route is the route to the configured STUN server", async () => {
    // Arrange: STUN server (127.0.0.1) への経路の送信元は eth1 のアドレス。
    // 既定経路の判定は差し替えず、実際の経路を調べる
    useNics({ eth0: ["127.0.0.2"], eth1: ["127.0.0.1"] });
    env.defaultRoutes = undefined;
    const stun = await createSelectiveStunServer("127.0.0.1");
    const connection = createTestConnection(true, {
      stunServer: stun.address,
      stunGatherTimeout: 1,
      useIpv6: false,
    });

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: STUN server への経路の送信元 (eth1) の host candidate が最優先になる
      const byHost = Object.fromEntries(
        hostsOf(connection).map((c) => [c.host, c]),
      );
      expect(localPreferenceOf(byHost["127.0.0.1"])).toBe(
        HostLocalPreference.defaultRoute,
      );
      expect(localPreferenceOf(byHost["127.0.0.2"])).toBe(
        HostLocalPreference.normal,
      );
      // Assert: その socket は代表として待たれ、srflx が揃った状態で返る
      expect(srflxOf(connection).map((c) => c.relatedAddress)).toContain(
        "127.0.0.1",
      );
    } finally {
      await connection.close();
      await stun.close();
    }
  });

  test("checks through the wildcard socket learn no prflx and a host pair is selected", async () => {
    // Arrange: STUN 付きの疑似マルチ NIC の agent A と、127.0.0.1 に明示 bind した agent B
    useNics({ eth0: ["127.0.0.1"], eth1: ["127.0.0.2"] });
    env.defaultRoutes = ["127.0.0.1"];
    const stun = await createSelectiveStunServer("127.0.0.1");
    const a = createTestConnection(true, {
      stunServer: stun.address,
      stunGatherTimeout: 1,
      useIpv6: false,
    });
    const b = createInterfaceBoundConnection(false, { udp4: "127.0.0.1" });

    try {
      await a.gatherCandidates();
      await a.waitForLocalCandidatesEnd();
      await inviteAccept(a, b);

      // Act: 接続する
      await Promise.all([a.connect(), b.connect()]);

      // Assert: B は A の check の送信元をすべて広告済みの candidate として知っている (prflx なし)
      expect(b.remoteCandidates.filter((c) => c.type === "prflx")).toEqual([]);
      // Assert: B への経路は host socket (127.0.0.1) が覆うので wildcard socket は check しない
      expect(
        a.checkList.filter((pair) => pair.localCandidate.type === "srflx"),
      ).toEqual([]);
      // Assert: 優先度の最も高い host 同士の pair が選ばれる
      expect(a.nominated?.localCandidate.type).toBe("host");
      expect(a.nominated?.localCandidate.host).toBe("127.0.0.1");
    } finally {
      await a.close();
      await b.close();
      await stun.close();
    }
  });

  test("the wildcard socket checks a path no host socket covers, from the srflx it advertised", async () => {
    // Arrange: A の列挙 NIC は 127.0.0.2 だけで、B (127.0.0.1) への経路の送信元は
    // 列挙されないアドレス (127.0.0.1)
    useNics({ eth1: ["127.0.0.2"] });
    const stun = await createSelectiveStunServer("127.0.0.1");
    const a = createTestConnection(true, {
      stunServer: stun.address,
      stunGatherTimeout: 1,
      useIpv6: false,
    });
    const b = createInterfaceBoundConnection(false, { udp4: "127.0.0.1" });

    try {
      await a.gatherCandidates();
      await a.waitForLocalCandidatesEnd();
      await inviteAccept(a, b);

      // Act: 接続する
      await Promise.all([a.connect(), b.connect()]);

      // Assert: wildcard socket の pair が check され、B は prflx を学習しない
      const wildcardPairs = a.checkList.filter(
        (pair) => pair.localCandidate.type === "srflx",
      );
      expect(wildcardPairs.length).toBeGreaterThan(0);
      expect(b.remoteCandidates.filter((c) => c.type === "prflx")).toEqual([]);
    } finally {
      await a.close();
      await b.close();
      await stun.close();
    }
  });

  test("an explicit interface address opens no wildcard socket", async () => {
    // Arrange: udp4 を明示した agent
    useNics({ eth0: ["127.0.0.1"], eth1: ["127.0.0.2"] });
    const stun = await createSelectiveStunServer("127.0.0.1");
    const connection = createTestConnection(true, {
      stunServer: stun.address,
      stunGatherTimeout: 1,
      interfaceAddresses: { udp4: "127.0.0.1" },
      useIpv6: false,
    });

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();
      await connection.waitForLocalCandidatesEnd();

      // Assert: srflx の base は明示したアドレスだけ (wildcard socket はない)
      expect(srflxOf(connection).map((c) => c.relatedAddress)).toEqual([
        "127.0.0.1",
      ]);
    } finally {
      await connection.close();
      await stun.close();
    }
  });

  test("an ICE restart keeps the wildcard socket and close() releases it", async () => {
    // Arrange: wildcard socket の srflx を得た agent
    useNics({ eth0: ["127.0.0.1"], eth1: ["127.0.0.2"] });
    const stun = await createSelectiveStunServer("127.0.0.1");
    const connection = createTestConnection(true, {
      stunServer: stun.address,
      stunGatherTimeout: 1,
      useIpv6: false,
    });
    const wildcardSrflx = () =>
      srflxOf(connection).filter((c) => c.relatedAddress === "0.0.0.0");
    let wildcardPort: number | undefined;

    try {
      await connection.gatherCandidates();
      await connection.waitForLocalCandidatesEnd();
      const before = wildcardSrflx();
      expect(before).toHaveLength(1);
      wildcardPort = before[0].relatedPort;

      // Act: ICE restart して再収集する
      await connection.restart();
      await connection.gatherCandidates();
      await connection.waitForLocalCandidatesEnd();

      // Assert: 同じ wildcard socket の srflx が新 generation に 1 つだけ載る
      const after = wildcardSrflx();
      expect(after).toHaveLength(1);
      expect(after[0].relatedPort).toBe(wildcardPort);
      expect(after[0].generation).toBe(connection.generation);
    } finally {
      // Act: close する
      await connection.close();
      await stun.close();
    }

    // Assert: wildcard socket の port は解放されている
    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(wildcardPort, "0.0.0.0", () => resolve());
    });
    socket.close();
  });
});
