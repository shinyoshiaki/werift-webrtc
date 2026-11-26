import * as dgram from "node:dgram";
import type { NetworkInterfaceInfo } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMulticastDns, MdnsLookup } from "../../src/dns/lookup";
import {
  createFakeMdns,
  createTestConnection,
  installFakeMdnsLookup,
  remoteHostCandidate,
} from "../utils";
import {
  stubNetworkInterfaces,
  trackUncaught,
} from "./interfaceEnumerationUtils";

// mDNS ソケット（multicast-dns）は 'listening' 時と 5 秒ごとに
// os.networkInterfaces() を呼ぶ。列挙が禁止された環境ではそこで throw し、
// uncaughtException でプロセスが終了していた。
let os: ReturnType<typeof stubNetworkInterfaces>;
let crash: ReturnType<typeof trackUncaught>;
const lookups: MdnsLookup[] = [];

/** Resolves once the mDNS socket of `lookup` has bound (and listens). */
const ready = (lookup: MdnsLookup) =>
  new Promise<void>((resolve) => lookup.mdnsInstance.once("ready", resolve));

beforeEach(() => {
  os = stubNetworkInterfaces();
  crash = trackUncaught();
});
afterEach(() => {
  for (const lookup of lookups.splice(0)) lookup.close();
  vi.useRealTimers();
  os.restore();
  crash.dispose();
});

describe("MdnsLookup when os.networkInterfaces() throws", () => {
  test("an enumeration failing at creation opens no socket and rejects lookups at once", async () => {
    // Act: 列挙が失敗する状態で既定の mDNS ソケットを作り、lookup する。
    const lookup = new MdnsLookup();
    lookups.push(lookup);
    const resolving = lookup.lookup("peer.local");

    // Assert: lookup は即座に reject し、待ち状態も残らない。
    await expect(resolving).rejects.toThrow("mDNS lookup unavailable");
    await expect(resolving.catch((error) => error.cause)).resolves.toBe(
      os.error,
    );
    expect(lookup.pendingCount).toBe(0);
    expect(crash.uncaught).toEqual([]);
  });

  test("an enumeration throwing when the socket starts listening does not crash", async () => {
    os.succeed();
    const lookup = new MdnsLookup();
    lookups.push(lookup);
    const callsAtCreation = os.spy.mock.calls.length;

    // Act: 作成後に列挙を失敗させ、ソケットの 'listening' を待つ。
    os.fail();
    await ready(lookup);

    // Assert: multicast-dns は列挙しなくなり、uncaught は起きない。
    expect(os.spy.mock.calls.length).toBe(callsAtCreation);
    expect(crash.uncaught).toEqual([]);
  });

  test("an enumeration throwing on the 5 second membership update only warns, and close() leaves no timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    os.succeed();
    const lookup = new MdnsLookup();
    lookups.push(lookup);
    const warnings: unknown[] = [];
    lookup.mdnsInstance.on("warning", (warning) => warnings.push(warning));
    await ready(lookup);
    // 'listening' のハンドラの後で interval が登録される。
    await new Promise((resolve) => setImmediate(resolve));

    // Act: 列挙を失敗させて、membership 更新の interval を 2 回走らせる。
    os.fail();
    vi.advanceTimersByTime(10000);

    // Assert: 列挙の失敗は warning になるだけで、uncaught は起きない。
    expect(warnings).toEqual([os.error, os.error]);
    expect(crash.uncaught).toEqual([]);

    // Act: close し、ソケットの 'close'（次の tick に出る）まで進める。
    lookup.close();
    await new Promise((resolve) => setImmediate(resolve));

    // Assert: interval は残らない。
    expect(vi.getTimerCount()).toBe(0);
  });

  test("multicast-dns never enumerates by itself: werift enumerates once at creation and once per 5 second update", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    os.succeed();
    const lookup = new MdnsLookup();
    lookups.push(lookup);
    await ready(lookup);
    await new Promise((resolve) => setImmediate(resolve));

    // Assert: 'listening' の後も、作成時の 1 回だけ（multicast-dns 自身は列挙しない）。
    expect(os.spy).toHaveBeenCalledTimes(1);

    // Act: membership 更新の interval を 2 回走らせる。
    vi.advanceTimersByTime(10000);

    // Assert: 列挙は werift の更新 1 回につき 1 回だけ増える。
    expect(os.spy).toHaveBeenCalledTimes(3);
  });

  test("an interface that appears after creation is joined by the 5 second update", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const iface = (
      address: string,
      family: "IPv4" | "IPv6" = "IPv4",
    ): NetworkInterfaceInfo[] => [
      {
        address,
        family,
        internal: false,
        netmask: "255.255.255.0",
        mac: "00:00:00:00:00:00",
        cidr: `${address}/24`,
      } as NetworkInterfaceInfo,
    ];
    os.succeed({ eth0: iface("192.0.2.1") });
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const addMembership = vi
      .spyOn(socket, "addMembership")
      .mockImplementation(() => {});
    const setMulticastInterface = vi
      .spyOn(socket, "setMulticastInterface")
      .mockImplementation(() => {});
    const lookup = new MdnsLookup(() =>
      createMulticastDns({ socket, port: 20000 + (process.pid % 20000) }),
    );
    lookups.push(lookup);
    await ready(lookup);
    await new Promise((resolve) => setImmediate(resolve));
    expect(addMembership.mock.calls.map(([, address]) => address)).toEqual([
      "192.0.2.1",
    ]);

    // Act: ネットワークが増えてから、5 秒ごとの更新が走る。
    os.succeed({
      eth0: iface("192.0.2.1"),
      wlan0: [
        ...iface("2001:db8::7", "IPv6"),
        ...iface("198.51.100.7"),
        ...iface("198.51.100.8"),
      ],
    });
    vi.advanceTimersByTime(5000);

    // Assert: 増えた interface だけが、その最初の IPv4 アドレスで join される。
    expect(addMembership.mock.calls.map(([, address]) => address)).toEqual([
      "192.0.2.1",
      "198.51.100.7",
    ]);
    // Assert: 送信 interface は配列ではなく文字列（外部向け IPv4 があれば 0.0.0.0）で指定される。
    expect(setMulticastInterface.mock.calls.length).toBeGreaterThan(0);
    for (const [value] of setMulticastInterface.mock.calls) {
      expect(value).toBe("0.0.0.0");
    }
    expect(crash.uncaught).toEqual([]);
  });

  test("a remote .local candidate is dropped without a crash", async () => {
    const connection = createTestConnection(true);

    // Act: 列挙が失敗する状態で .local の候補を受け取る（既定の MdnsLookup が作られる）。
    await connection.addRemoteCandidate(remoteHostCandidate(50000, "a.local"));

    // Assert: 候補は破棄され、uncaught は起きない。
    expect(connection.remoteCandidates).toEqual([]);
    expect(crash.uncaught).toEqual([]);
    await connection.close();
  });
});

describe("MdnsLookup socket errors", () => {
  test.each(["EACCES", "EADDRINUSE"])(
    "an %s error rejects the pending lookups and the later ones",
    async (code) => {
      const mdns = createFakeMdns();
      const lookup = new MdnsLookup(mdns.factory);
      const pending = lookup.lookup("peer.local");
      const error = Object.assign(new Error(`bind ${code}`), { code });

      // Act: multicast-dns がソケットの error を再送出する。
      mdns.emitError(error);

      // Assert: 待ちの lookup は reject され、listener も外れる。
      await expect(pending).rejects.toThrow("mDNS lookup unavailable");
      expect(lookup.pendingCount).toBe(0);
      expect(mdns.listenerCount).toBe(0);
      // Assert: 以降の lookup も即座に reject する。
      await expect(lookup.lookup("other.local")).rejects.toThrow(
        "mDNS lookup unavailable",
      );
      expect(crash.uncaught).toEqual([]);

      // Act: close は冪等のまま。
      lookup.close();
      lookup.close();

      // Assert: socket の破棄は 1 回だけ。
      expect(mdns.destroyCount).toBe(1);
    },
  );

  test("a socket error while a remote .local candidate resolves drops it", async () => {
    const connection = createTestConnection(true);
    const { mdns } = installFakeMdnsLookup(connection);
    const adding = connection.addRemoteCandidate(
      remoteHostCandidate(50000, "a.local"),
    );

    // Act: 解決待ちの間に socket error が来る。
    mdns.emitError(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    await adding;

    // Assert: 候補は破棄され、uncaught は起きない。
    expect(connection.remoteCandidates).toEqual([]);
    expect(crash.uncaught).toEqual([]);
    await connection.close();
  });
});
