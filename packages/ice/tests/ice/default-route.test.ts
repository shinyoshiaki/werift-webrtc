import * as dgram from "node:dgram";
import { describe, expect, test } from "vitest";

import {
  getDefaultRouteAddress,
  getDefaultRouteAddresses,
  getServerRouteAddress,
} from "../../src/internal/defaultRoute";

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
  test("probes the route to the configured server without sending to it", async () => {
    // Arrange: ループバック上の server
    const server = await countingUdpServer("127.0.0.1");

    try {
      // Act: server への経路の送信元を調べる
      const [address] = await getDefaultRouteAddresses(true, false, [
        "127.0.0.1",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Assert: server への経路の送信元 (ループバック) が既定経路になり、パケットは送らない
      expect(address).toBe("127.0.0.1");
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

    // Assert: 別ファミリーの server は対象にならない
    expect(address).toBeUndefined();
  });

  test("without a usable server the Internet route is used", async () => {
    // Act: 解決できない server だけを指定して調べる
    const [addresses, internet] = await Promise.all([
      getDefaultRouteAddresses(true, false, ["werift-route-probe.invalid"]),
      getDefaultRouteAddress(4),
    ]);

    // Assert: 公開アドレスへの経路 (なければ空) にフォールバックする
    expect(addresses).toEqual(internet ? [internet] : []);
  });
});
