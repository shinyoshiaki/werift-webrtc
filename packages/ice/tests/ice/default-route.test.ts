import * as dgram from "node:dgram";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  getDefaultRouteAddresses,
  getServerRouteAddress,
} from "../../src/internal/defaultRoute";
import { HostLocalPreference } from "../../src/internal/hostPreference";
import { createSelectiveStunServer, createTestConnection } from "../utils";

// UDP socket の connect() 先 (経路プローブの宛先) をすべて記録する
const probes = vi.hoisted(() => ({ targets: [] as string[] }));
vi.mock("node:dgram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dgram")>();
  const createSocket = ((...args: Parameters<typeof actual.createSocket>) => {
    const socket = actual.createSocket(...args);
    const connect = socket.connect.bind(socket) as (...a: unknown[]) => void;
    socket.connect = ((port: number, address?: unknown, ...rest: unknown[]) => {
      if (typeof address === "string") probes.targets.push(address);
      return connect(port, address, ...rest);
    }) as typeof socket.connect;
    return socket;
  }) as typeof actual.createSocket;
  return { ...actual, createSocket, default: { ...actual, createSocket } };
});

/** Shared Arrange: 受信したデータグラム数を数える UDP socket (STUN server の代わり) */
async function countingUdpServer(host: string) {
  const socket = dgram.createSocket("udp4");
  let received = 0;
  socket.on("message", () => {
    received++;
  });
  await new Promise<void>((resolve) => socket.bind(0, host, () => resolve()));
  return {
    received: () => received,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

describe("default-route probe", () => {
  beforeEach(() => {
    probes.targets = [];
  });

  test("probes the route to the configured server without sending to it", async () => {
    // Arrange: ループバック上の server
    const server = await countingUdpServer("127.0.0.1");

    try {
      // Act: server への経路の送信元を調べる
      const [address] = await getDefaultRouteAddresses(true, false, [
        "127.0.0.1",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Assert: server への経路の送信元 (ループバック) が既定経路になる
      expect(address).toBe("127.0.0.1");
      // Assert: プローブ先は server だけで、server にパケットは届かない
      expect(probes.targets).toEqual(["127.0.0.1"]);
      expect(server.received()).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("a hostname is resolved in the probed family", async () => {
    // Act: ホスト名の server への経路を調べる
    const address = await getServerRouteAddress(4, ["localhost"]);

    // Assert: IPv4 で解決したアドレスへの経路の送信元になる
    expect(address).toBe("127.0.0.1");
  });

  test("the first server that resolves and has a route wins, in priority order", async () => {
    // Act: 解決できない server を先頭に置いて調べる
    const address = await getServerRouteAddress(4, [
      "werift-route-probe.invalid",
      "127.0.0.1",
    ]);

    // Assert: 次の server への経路が使われる
    expect(address).toBe("127.0.0.1");
  });

  test("a server of the other family gives no route", async () => {
    // Act: IPv4 リテラルの server で IPv6 の経路を調べる
    const address = await getServerRouteAddress(6, ["127.0.0.1"]);

    // Assert: 別ファミリーの server は対象にならず、どこにもプローブしない
    expect(address).toBeUndefined();
    expect(probes.targets).toEqual([]);
  });

  test("without a usable server there is no default route and no other address is probed", async () => {
    // Act: server なし / 解決できない server だけで調べる
    const none = await getDefaultRouteAddresses(true, true, []);
    const unresolved = await getDefaultRouteAddresses(true, true, [
      "werift-route-probe.invalid",
    ]);

    // Assert: 既定経路はなく、公開アドレスなどへのフォールバックのプローブもしない
    expect(none).toEqual([]);
    expect(unresolved).toEqual([]);
    expect(probes.targets).toEqual([]);
  });

  test("gathering without STUN / TURN servers probes no route", async () => {
    // Arrange: STUN / TURN server のない agent
    const connection = createTestConnection(true, {});

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();

      // Assert: 経路プローブは一度も行わない
      expect(probes.targets).toEqual([]);
      // Assert: 既定経路の区分の host candidate はない
      for (const candidate of connection.localCandidates) {
        expect((candidate.priority >> 8) & 0xffff).toBeLessThan(
          HostLocalPreference.defaultRoute,
        );
      }
    } finally {
      await connection.close();
    }
  });

  test("gathering probes only the configured STUN server", async () => {
    // Arrange: ループバック上の STUN server を設定した agent
    const stun = await createSelectiveStunServer("127.0.0.1");
    const connection = createTestConnection(true, {
      stunServer: stun.address,
      stunGatherTimeout: 1,
    });

    try {
      // Act: candidate を収集する
      await connection.gatherCandidates();
      await connection.waitForLocalCandidatesEnd();

      // Assert: プローブ先は設定した STUN server だけ
      expect(new Set(probes.targets)).toEqual(new Set(["127.0.0.1"]));
    } finally {
      await connection.close();
      await stun.close();
    }
  });
});
