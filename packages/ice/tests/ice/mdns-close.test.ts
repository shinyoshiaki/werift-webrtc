import { afterEach, describe, expect, test, vi } from "vitest";
import { MdnsLookup } from "../../src/dns/lookup";
import {
  addClosingProtocol,
  createFakeMdns,
  createTestConnection,
  installFakeMdnsLookup,
  provisionalGeneration,
  remoteHostCandidate,
} from "../utils";

afterEach(() => {
  vi.useRealTimers();
});

/** Every pending lookup is owned by MdnsLookup and released on close(). */
describe("MdnsLookup", () => {
  test("a response resolves the lookup and releases its timer and listener", async () => {
    vi.useFakeTimers();
    const mdns = createFakeMdns();
    const lookup = new MdnsLookup(mdns.factory);

    // Act: lookup を開始して A レコードで応答する。
    const resolving = lookup.lookup("peer.local");
    mdns.respond("peer.local", "192.0.2.1");

    // Assert: アドレスで resolve し、timer と listener が残らない。
    await expect(resolving).resolves.toBe("192.0.2.1");
    expect(mdns.queries).toEqual(["peer.local"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(mdns.listenerCount).toBe(0);
    expect(lookup.pendingCount).toBe(0);
  });

  test("a lookup without a response rejects after the timeout", async () => {
    vi.useFakeTimers();
    const mdns = createFakeMdns();
    const lookup = new MdnsLookup(mdns.factory);

    // Act: 応答がないまま 10 秒経過させる。
    const resolving = lookup.lookup("peer.local");
    const settled = expect(resolving).rejects.toThrow("No mDNS response");
    await vi.advanceTimersByTimeAsync(10000);

    // Assert: タイムアウトで reject し、listener も外れる。
    await settled;
    expect(mdns.listenerCount).toBe(0);
    expect(lookup.pendingCount).toBe(0);
  });

  test("close() rejects every pending lookup at once", async () => {
    vi.useFakeTimers();
    const mdns = createFakeMdns();
    const lookup = new MdnsLookup(mdns.factory);
    const first = lookup.lookup("a.local");
    const second = lookup.lookup("b.local");

    // Act: 未解決の lookup が 2 件ある状態で close する。
    lookup.close();

    // Assert: 両方が即座に reject し、timer / listener が残らず socket は破棄される。
    await expect(first).rejects.toThrow("mDNS lookup cancelled");
    await expect(second).rejects.toThrow("mDNS lookup cancelled");
    expect(vi.getTimerCount()).toBe(0);
    expect(mdns.listenerCount).toBe(0);
    expect(mdns.destroyCount).toBe(1);
  });

  test("a lookup after close() rejects without a query or timer", async () => {
    vi.useFakeTimers();
    const mdns = createFakeMdns();
    const lookup = new MdnsLookup(mdns.factory);
    lookup.close();

    // Act: close 後に lookup する。
    const resolving = lookup.lookup("peer.local");

    // Assert: 即 reject し、query も timer も listener も作られない。
    await expect(resolving).rejects.toThrow("mDNS lookup closed");
    expect(mdns.queries).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(mdns.listenerCount).toBe(0);
  });

  test("close() is idempotent", () => {
    const mdns = createFakeMdns();
    const lookup = new MdnsLookup(mdns.factory);

    // Act: close を 2 回呼ぶ。
    lookup.close();
    lookup.close();

    // Assert: socket の破棄は 1 回だけ。
    expect(mdns.destroyCount).toBe(1);
  });
});

/** Connection.close() ends the remote mDNS resolutions it owns. */
describe("Connection close with pending mDNS lookups", () => {
  test("close() releases pending lookups and adds no candidate", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const connection = createTestConnection(true);
    const { mdns } = installFakeMdnsLookup(connection);
    const first = connection.addRemoteCandidate(
      remoteHostCandidate(50000, "a.local"),
    );
    const second = connection.addRemoteCandidate(
      remoteHostCandidate(50001, "b.local"),
    );

    // Act: 未解決の .local 候補が 2 件ある状態で close する。
    await connection.close();
    await Promise.all([first, second]);

    // Assert: timer / listener が 0 件になり、候補は追加されない。
    expect(vi.getTimerCount()).toBe(0);
    expect(mdns.listenerCount).toBe(0);
    expect(connection.lookup).toBeUndefined();
    expect(connection.remoteCandidates).toEqual([]);
    expect(connection.checkList).toEqual([]);
  });

  test("a response arriving while close() awaits the protocols adds no candidate", async () => {
    const connection = createTestConnection(true);
    const { mdns } = installFakeMdnsLookup(connection);
    addClosingProtocol(connection, async () => {
      mdns.respond("peer.local");
      await new Promise((r) => setImmediate(r));
    });
    const resolving = connection.addRemoteCandidate(
      remoteHostCandidate(50000, "peer.local"),
    );

    // Act: protocol の close を待つ間に mDNS 応答が届く。
    await connection.close();
    await resolving;

    // Assert: 閉じた connection に候補は入らない。
    expect(connection.remoteCandidates).toEqual([]);
    expect(connection.checkList).toEqual([]);
  });

  test("a response just before close() adds no candidate", async () => {
    const connection = createTestConnection(true);
    const { mdns } = installFakeMdnsLookup(connection);
    const resolving = connection.addRemoteCandidate(
      remoteHostCandidate(50000, "peer.local"),
    );

    // Act: 応答直後、続きが走る前に close する。
    mdns.respond("peer.local");
    const closing = connection.close();
    await Promise.all([closing, resolving]);

    // Assert: 解決済みでも候補は追加されない。
    expect(connection.remoteCandidates).toEqual([]);
    expect(connection.checkList).toEqual([]);
  });

  test("a candidate after close() opens no lookup and is not added", async () => {
    const connection = createTestConnection(true);
    await connection.close();

    // Act: close 後に .local 候補と通常候補が届く。
    await connection.addRemoteCandidate(
      remoteHostCandidate(50000, "peer.local"),
    );
    await connection.addRemoteCandidate(remoteHostCandidate(50001));

    // Assert: MdnsLookup は生成されず、候補も追加されない。
    expect(connection.lookup).toBeUndefined();
    expect(connection.remoteCandidates).toEqual([]);
  });

  test("end-of-candidates waiting on a lookup does not complete after close()", async () => {
    const connection = createTestConnection(true);
    installFakeMdnsLookup(connection);
    const resolving = connection.addRemoteCandidate(
      remoteHostCandidate(50000, "peer.local"),
    );
    const end = connection.addRemoteCandidate(undefined);

    // Act: EOC が mDNS 解決を待っている間に close する。
    await connection.close();
    await Promise.all([resolving, end]);

    // Assert: 閉じた connection の generation は完了扱いにならない。
    expect(connection.remoteCandidatesEnd).toBe(false);
  });

  test("end-of-candidates after close() has no effect", async () => {
    const connection = createTestConnection(true);
    await connection.close();

    // Act: close 後に EOC が届く。
    await connection.addRemoteCandidate(undefined);

    // Assert: remoteCandidatesEnd は更新されない。
    expect(connection.remoteCandidatesEnd).toBe(false);
  });

  test("a provisional mDNS candidate is dropped by close()", async () => {
    const connection = createTestConnection(true);
    const { mdns } = installFakeMdnsLookup(connection);
    connection.stageLocalCredentials("staged", "staged-password-0123456789");
    connection.setProvisionalRemoteParams({
      usernameFragment: "remote",
      password: "remote-password-0123456789",
    });
    const generation = provisionalGeneration(connection)!;
    const resolving = connection.addProvisionalRemoteCandidate(
      remoteHostCandidate(50000, "peer.local"),
    );

    // Act: 応答直後に close する。
    mdns.respond("peer.local");
    await connection.close();
    await resolving;
    await connection.addProvisionalRemoteCandidate(
      remoteHostCandidate(50001, "late.local"),
    );

    // Assert: provisional は破棄され、候補も lookup も残らない。
    expect(provisionalGeneration(connection)).toBeUndefined();
    expect(generation.remoteCandidates).toEqual([]);
    expect(connection.lookup).toBeUndefined();
    expect(mdns.listenerCount).toBe(0);
  });

  test("close() twice destroys the lookup once", async () => {
    const connection = createTestConnection(true);
    const { mdns } = installFakeMdnsLookup(connection);

    // Act: close を 2 回呼ぶ。
    await connection.close();
    await connection.close();

    // Assert: 例外なく、mDNS socket の破棄は 1 回だけ。
    expect(mdns.destroyCount).toBe(1);
  });

  test("an mDNS candidate still resolves and is added before close()", async () => {
    const connection = createTestConnection(true);
    const { mdns } = installFakeMdnsLookup(connection);
    try {
      // Act: .local 候補に応答する。
      const resolving = connection.addRemoteCandidate(
        remoteHostCandidate(50000, "peer.local"),
      );
      mdns.respond("peer.local", "127.0.0.1");
      await resolving;

      // Assert: 解決後のアドレスで候補が追加される。
      expect(connection.remoteCandidates.map((c) => c.host)).toEqual([
        "127.0.0.1",
      ]);
      expect(mdns.listenerCount).toBe(0);
    } finally {
      await connection.close();
    }
  });
});
