import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { IceGatheringErrorReason } from "../../src/gatheringError";
import type { Connection } from "../../src/ice";
import {
  getAssignedInterfaceAddresses,
  getHostInterfaceAddresses,
  readNetworkInterfaces,
} from "../../src/internal/hostInterfaces";
import { getHostAddresses, nodeIpAddress } from "../../src/utils";
import {
  createFixedMappingStunServer,
  createLocalTurnServer,
  createSilentUdpServer,
  createTestConnection,
  fakeNetworkInterfaces,
  localTurnServerEntry,
} from "../utils";
import {
  reasonsOf,
  recordGatheringErrors,
  stubNetworkInterfaces,
  trackUncaught,
} from "./interfaceEnumerationUtils";

const { interfaceEnumerationFailed, noCandidates, gatheringFailed } =
  IceGatheringErrorReason;

// os.networkInterfaces() は各テストで stub する（既定は throw）。
let os: ReturnType<typeof stubNetworkInterfaces>;
let crash: ReturnType<typeof trackUncaught>;
const connections: Connection[] = [];
const cleanups: (() => Promise<void>)[] = [];

/** An IPv4-only agent closed after the test. */
const createAgent = (
  options: Parameters<typeof createTestConnection>[1] = {},
) => {
  const connection = createTestConnection(true, { useIpv6: false, ...options });
  connections.push(connection);
  return { connection, errors: recordGatheringErrors(connection) };
};

beforeEach(() => {
  os = stubNetworkInterfaces();
  crash = trackUncaught();
});
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  os.restore();
  crash.dispose();
  vi.restoreAllMocks();
});

describe("host interface helpers", () => {
  test("readNetworkInterfaces returns the error instead of throwing", () => {
    // Act: 列挙が throw する状態で読む。
    const enumeration = readNetworkInterfaces();

    // Assert: 例外は返り値に入り、インターフェースは空になる。
    expect(enumeration.error).toBe(os.error);
    expect(enumeration.interfaces).toEqual({});
  });

  test("getHostInterfaceAddresses alone returns no address when the enumeration throws", () => {
    // Act: 候補用アドレスの列挙だけを呼ぶ。
    const call = () => getHostInterfaceAddresses(true, true);

    // Assert: throw せず空配列になる。
    expect(call).not.toThrow();
    expect(call()).toEqual([]);
  });

  test("getAssignedInterfaceAddresses alone returns no address when the enumeration throws", () => {
    // Act: 割り当て済みアドレスの列挙だけを呼ぶ。
    const call = () => getAssignedInterfaceAddresses();

    // Assert: throw せず空配列になる（additionalHostAddresses は wildcard bind になる）。
    expect(call).not.toThrow();
    expect(call()).toEqual([]);
  });

  test("the public nodeIpAddress / getHostAddresses keep throwing (documented @throws)", () => {
    // Act / Assert: 公開 API は従来どおり呼び出し元へ例外を返す。
    expect(() => nodeIpAddress(4)).toThrow(os.error);
    expect(() => getHostAddresses(true, false)).toThrow(os.error);
  });
});

describe("Connection.gatherCandidates when os.networkInterfaces() throws", () => {
  test("without servers or explicit addresses: ends with interface-enumeration-failed then no-candidates", async () => {
    const { connection, errors } = createAgent();

    // Act: 列挙が失敗する状態で収集する。
    await connection.gatherCandidates();

    // Assert: gathering は終了し、2 つの理由が 1 回ずつ現世代で通知される。
    expect(connection.localCandidatesEnd).toBe(true);
    expect(connection.localCandidates).toEqual([]);
    expect(reasonsOf(errors)).toEqual([
      interfaceEnumerationFailed,
      noCandidates,
    ]);
    expect(errors[0].cause).toBe(os.error);
    expect(errors[0].errorText).toContain("uv_interface_addresses");
    expect(errors.map(({ generation }) => generation)).toEqual([
      connection.generation,
      connection.generation,
    ]);
    // Assert: 列挙は 1 回だけ（host / assigned の両経路で結果を共有する）。
    expect(os.spy).toHaveBeenCalledTimes(1);
    expect(crash.uncaught).toEqual([]);
  });

  test("an explicit interfaceAddresses.udp4 still gives its host candidate", async () => {
    const { connection, errors } = createAgent({
      interfaceAddresses: { udp4: "127.0.0.1" },
    });

    // Act: explicit 指定ありで収集する。
    await connection.gatherCandidates();

    // Assert: explicit な host 候補が得られ、no-candidates は出ない。
    expect(connection.localCandidates.map(({ host }) => host)).toEqual([
      "127.0.0.1",
    ]);
    expect(reasonsOf(errors)).toEqual([interfaceEnumerationFailed]);
    expect(connection.localCandidatesEnd).toBe(true);
  });

  test("additionalHostAddresses are gathered on a wildcard socket", async () => {
    const { connection, errors } = createAgent({
      additionalHostAddresses: ["192.0.2.10"],
    });

    // Act: 追加アドレスだけで収集する。
    await connection.gatherCandidates();

    // Assert: 追加アドレスの host 候補が得られる（割り当て不明なので wildcard bind）。
    expect(
      connection.localCandidates.map(({ type, host }) => [type, host]),
    ).toEqual([["host", "192.0.2.10"]]);
    expect(reasonsOf(errors)).toEqual([interfaceEnumerationFailed]);
  });

  test("a STUN server still gives a server-reflexive candidate", async () => {
    const stun = await createFixedMappingStunServer("127.0.0.1", [
      "203.0.113.5",
      40000,
    ]);
    cleanups.push(stun.close);
    const { connection, errors } = createAgent({
      stunServers: [stun.address],
    });

    // Act: STUN ありで収集する。
    await connection.gatherCandidates();
    await connection.waitForLocalCandidatesEnd();

    // Assert: srflx が得られる部分成功で、no-candidates は出ない。
    expect(
      connection.localCandidates
        .filter(({ type }) => type === "srflx")
        .map(({ host, port }) => [host, port]),
    ).toEqual([["203.0.113.5", 40000]]);
    expect(reasonsOf(errors)).toEqual([interfaceEnumerationFailed]);
    expect(connection.localCandidatesEnd).toBe(true);
  });

  test("a TURN server still gives a relay candidate", async () => {
    const turn = await createLocalTurnServer("127.0.0.1");
    cleanups.push(() => turn.close());
    const { connection, errors } = createAgent({
      turnServers: [localTurnServerEntry(turn)],
    });

    // Act: TURN ありで収集する。
    await connection.gatherCandidates();
    await connection.waitForLocalCandidatesEnd();

    // Assert: relay 候補が得られ、no-candidates は出ない。
    expect(
      connection.localCandidates.filter(({ type }) => type === "relay"),
    ).toHaveLength(1);
    expect(reasonsOf(errors)).toEqual([interfaceEnumerationFailed]);
  });

  test("a second gatherCandidates() reports nothing more and the generation stays ended", async () => {
    const { connection, errors } = createAgent();
    await connection.gatherCandidates();

    // Act: 同じ世代でもう一度呼ぶ。
    await connection.gatherCandidates();

    // Assert: 追加の通知はなく、終了済みのまま（最初の呼び出しで no-candidates 済み）。
    expect(reasonsOf(errors)).toEqual([
      interfaceEnumerationFailed,
      noCandidates,
    ]);
    expect(connection.localCandidatesEnd).toBe(true);
    expect(os.spy).toHaveBeenCalledTimes(1);
  });

  test("an ICE restart keeps the re-advertised candidates and reaches end-of-candidates", async () => {
    os.succeed(fakeNetworkInterfaces({ eth0: ["127.0.0.1"] }));
    const { connection, errors } = createAgent();
    await connection.gatherCandidates();
    const firstGeneration = connection.generation;
    connection.restart();
    os.fail();

    // Act: 再起動後の世代を列挙失敗のまま収集する。
    await connection.gatherCandidates();

    // Assert: 保持ソケットの host 候補が新世代で残り、gathering は終わる。
    expect(connection.generation).not.toBe(firstGeneration);
    expect(
      connection.localCandidates.map(({ host, generation }) => [
        host,
        generation,
      ]),
    ).toEqual([["127.0.0.1", connection.generation]]);
    expect(connection.localCandidatesEnd).toBe(true);
    // Assert: 新世代の interface-enumeration-failed だけで、no-candidates は出ない。
    expect(errors).toEqual([
      expect.objectContaining({
        reason: interfaceEnumerationFailed,
        generation: connection.generation,
      }),
    ]);
  });

  test("a listener that throws does not stop the gathering or the later listeners", async () => {
    const connection = createAgent().connection;
    connection.onGatheringError.subscribe(() => {
      throw new Error("listener failure");
    });
    const later = recordGatheringErrors(connection);

    // Act: 最初の listener が throw する状態で収集する。
    await connection.gatherCandidates();

    // Assert: gathering は完了し、後続の listener も両方の通知を受ける。
    expect(connection.localCandidatesEnd).toBe(true);
    expect(reasonsOf(later)).toEqual([
      interfaceEnumerationFailed,
      noCandidates,
    ]);
    expect(crash.uncaught).toEqual([]);
  });

  test("nothing is reported after close", async () => {
    const silent = await createSilentUdpServer();
    cleanups.push(silent.close);
    const { connection, errors } = createAgent({
      stunServers: [silent.address],
      stunGatherTimeout: 60,
    });

    // Act: 応答しない STUN を待っている間に close する。
    const gathering = connection.gatherCandidates();
    await connection.close();
    await gathering;

    // Assert: 列挙失敗は同期で通知済みだが、close 後の no-candidates は出ない。
    expect(reasonsOf(errors)).toEqual([interfaceEnumerationFailed]);
  });

  test("nothing is reported for a generation an ICE restart replaced", async () => {
    const silent = await createSilentUdpServer();
    cleanups.push(silent.close);
    const { connection, errors } = createAgent({
      stunServers: [silent.address],
      stunGatherTimeout: 1,
    });
    const gathering = connection.gatherCandidates();
    const replaced = connection.generation;

    // Act: 収集中に ICE restart して旧世代の収集を終わらせる。
    connection.restart();
    await gathering;

    // Assert: 旧世代の no-candidates は出ない。
    expect(errors).toEqual([
      expect.objectContaining({
        reason: interfaceEnumerationFailed,
        generation: replaced,
      }),
    ]);
  });

  test("an unexpected exception reports gathering-failed, ends the generation and rejects", async () => {
    os.succeed(fakeNetworkInterfaces({ eth0: ["127.0.0.1"] }));
    const { connection, errors } = createAgent();
    const failure = new Error("unexpected");
    const gatherer = (
      connection as unknown as {
        gatherer: { candidatePromises: (...args: unknown[]) => unknown };
      }
    ).gatherer;
    vi.spyOn(gatherer, "candidatePromises").mockImplementation(() => {
      throw failure;
    });

    // Act: 収集の同期部分で想定外の例外を起こす。
    const gathering = connection.gatherCandidates();

    // Assert: reject は従来どおりで、gathering-failed → no-candidates が通知され世代は終了する。
    await expect(gathering).rejects.toBe(failure);
    expect(reasonsOf(errors)).toEqual([gatheringFailed, noCandidates]);
    expect(errors[0].cause).toBe(failure);
    expect(connection.localCandidatesEnd).toBe(true);

    // Act: 同じ世代でもう一度呼ぶ。
    await connection.gatherCandidates();

    // Assert: 黙って再収集も再通知もしない（失敗は通知済み）。
    expect(errors).toHaveLength(2);
  });
});

describe("Connection.gatherCandidates with a working enumeration", () => {
  test("onGatheringError is never fired", async () => {
    os.succeed(fakeNetworkInterfaces({ eth0: ["127.0.0.1"] }));
    const { connection, errors } = createAgent();

    // Act: 列挙が成功する通常構成で収集する。
    await connection.gatherCandidates();

    // Assert: host 候補が得られ、通知は一度もない。
    expect(connection.localCandidates.map(({ host }) => host)).toEqual([
      "127.0.0.1",
    ]);
    expect(errors).toEqual([]);
  });
});
