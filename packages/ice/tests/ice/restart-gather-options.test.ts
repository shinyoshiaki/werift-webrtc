import { Candidate } from "../../src/candidate";
import {
  isCandidateAllowedByGatherOptions,
  isRelayOnlyGathering,
} from "../../src/iceBase";
import {
  connectionProtocols,
  createConnectedPair,
  createGatheredConnectionWithLocalServers,
  localCandidateKinds,
  restartWithIceServers,
  stageProvisionalGeneration,
} from "../utils";

describe("isCandidateAllowedByGatherOptions", () => {
  const turn = {
    turnServer: ["127.0.0.1", 3478] as [string, number],
    turnUsername: "user",
    turnPassword: "pass",
  };

  test.each([
    // [candidate, options, allowed]
    [{ type: "relay", transport: "udp" }, { ...turn, forceTurn: true }, true],
    [{ type: "host", transport: "udp" }, { ...turn, forceTurn: true }, false],
    [{ type: "srflx", transport: "udp" }, { ...turn, forceTurn: true }, false],
    [{ type: "host", transport: "tcp" }, { ...turn, forceTurn: true }, false],
    // TURN が無い relay ポリシーは従来どおり host / srflx に fallback する
    [{ type: "host", transport: "udp" }, { forceTurn: true }, true],
    [{ type: "srflx", transport: "udp" }, { forceTurn: true }, true],
    [{ type: "host", transport: "udp" }, { ...turn, forceTurn: false }, true],
    [{ type: "host", transport: "tcp" }, { useTcp: false }, false],
    [{ type: "host", transport: "tcp" }, { useTcp: true }, true],
    // ICE-lite は relay-only にならない
    [
      { type: "host", transport: "udp" },
      { ...turn, forceTurn: true, iceLite: true },
      true,
    ],
  ])("%o with %o → %s", (candidate, options, allowed) => {
    // Act / Assert: 新規 gathering と同じ条件で可否が決まる
    expect(isCandidateAllowedByGatherOptions(candidate, options)).toBe(allowed);
  });

  test("isRelayOnlyGathering は TURN server / credential が揃うときだけ真", () => {
    // Act / Assert: forceTurn と TURN 設定がすべて揃ったときだけ relay-only
    expect(isRelayOnlyGathering({ ...turn, forceTurn: true })).toBe(true);
    expect(isRelayOnlyGathering({ ...turn, forceTurn: false })).toBe(false);
    expect(
      isRelayOnlyGathering({
        ...turn,
        turnPassword: undefined,
        forceTurn: true,
      }),
    ).toBe(false);
  });
});

describe("ICE restart follows the gather options of the new generation", () => {
  test("all → relay: 保持した host socket を閉じ、relay 候補だけを出してペアにする", async () => {
    // Arrange: STUN + TURN (relay ポリシーなし) で gather 済みの connection
    const arranged = await createGatheredConnectionWithLocalServers(
      ({ stunOptions, turnOptions }) => ({
        ...turnOptions,
        ...stunOptions,
        forceTurn: false,
      }),
    );
    const { connection, stunOptions, turnOptions } = arranged;
    try {
      expect(localCandidateKinds(connection)).toContain("udp/host");
      const hostSockets = connectionProtocols(connection).filter(
        (protocol) => protocol.localCandidate?.type === "host",
      );
      const closes = hostSockets.map((protocol) => vi.spyOn(protocol, "close"));

      // Act: relay ポリシーに変えて ICE restart し、gather し直す
      await restartWithIceServers(connection, {
        ...turnOptions,
        ...stunOptions,
        forceTurn: true,
      });

      // Assert: 新しい generation は relay 候補だけで、保持していた host socket は閉じて外す
      expect(localCandidateKinds(connection)).toEqual(["udp/relay"]);
      for (const close of closes) expect(close).toHaveBeenCalled();
      expect(
        connectionProtocols(connection).every(
          (protocol) => protocol.localCandidate?.type === "relay",
        ),
      ).toBe(true);

      // Act: 相手の host 候補を受け取る
      connection.setRemoteParams({
        iceLite: false,
        usernameFragment: "remote",
        password: "remote-password-remote",
      });
      await connection.addRemoteCandidate(
        new Candidate("1", 1, "udp", 100, "127.0.0.1", 50000, "host"),
      );

      // Assert: ペアの local 側は relay 候補だけ
      const checkList = (
        connection as unknown as {
          checkList: { localCandidate: Candidate }[];
        }
      ).checkList;
      expect(checkList.length).toBeGreaterThan(0);
      expect(
        checkList.every((pair) => pair.localCandidate.type === "relay"),
      ).toBe(true);
    } finally {
      await arranged.close();
    }
  });

  test("relay → all: restart で host / srflx を gather し直す", async () => {
    // Arrange: relay ポリシーで gather 済みの connection
    const arranged = await createGatheredConnectionWithLocalServers(
      ({ stunOptions, turnOptions }) => ({ ...turnOptions, ...stunOptions }),
    );
    const { connection, stunOptions, turnOptions } = arranged;
    try {
      expect(localCandidateKinds(connection)).toEqual(["udp/relay"]);

      // Act: relay ポリシーを外して ICE restart し、gather し直す
      await restartWithIceServers(connection, {
        ...turnOptions,
        ...stunOptions,
        forceTurn: false,
      });

      // Assert: host 候補と relay 候補が新しい generation に出る
      expect(localCandidateKinds(connection)).toEqual(
        expect.arrayContaining(["udp/host", "udp/relay"]),
      );
    } finally {
      await arranged.close();
    }
  });

  test("useTcp true → false → true: TCP host socket を閉じ、再び有効にすると gather し直す", async () => {
    // Arrange: TCP 有効・STUN のみで gather 済みの connection
    const arranged = await createGatheredConnectionWithLocalServers(
      ({ stunOptions }) => ({ ...stunOptions, useTcp: true }),
    );
    const { connection, stunOptions } = arranged;
    try {
      expect(localCandidateKinds(connection)).toContain("tcp/host");
      const tcpSockets = connectionProtocols(connection).filter(
        (protocol) => protocol.localCandidate?.transport === "tcp",
      );
      const closes = tcpSockets.map((protocol) => vi.spyOn(protocol, "close"));

      // Act: TCP を無効にして ICE restart し、gather し直す
      await restartWithIceServers(connection, {
        ...stunOptions,
        useTcp: false,
      });

      // Assert: TCP host 候補は出ず、保持していた TCP socket は閉じて外す
      expect(localCandidateKinds(connection)).not.toContain("tcp/host");
      expect(localCandidateKinds(connection)).toContain("udp/host");
      for (const close of closes) expect(close).toHaveBeenCalled();
      expect(
        connectionProtocols(connection).some(
          (protocol) => protocol.localCandidate?.transport === "tcp",
        ),
      ).toBe(false);

      // Act: TCP を再び有効にして ICE restart し、gather し直す
      await restartWithIceServers(connection, {
        ...stunOptions,
        useTcp: true,
      });

      // Assert: TCP host 候補が新しい generation に戻る
      expect(localCandidateKinds(connection)).toContain("tcp/host");
    } finally {
      await arranged.close();
    }
  });

  test("useTcp false → true: UDP socket を保持したアドレスにも TCP host 候補を gather する", async () => {
    // Arrange: TCP 無効・STUN のみで gather 済みの connection
    const arranged = await createGatheredConnectionWithLocalServers(
      ({ stunOptions }) => stunOptions,
    );
    const { connection, stunOptions } = arranged;
    try {
      expect(localCandidateKinds(connection)).not.toContain("tcp/host");

      // Act: TCP を有効にして ICE restart し、gather し直す
      await restartWithIceServers(connection, {
        ...stunOptions,
        useTcp: true,
      });

      // Assert: 新しい generation に TCP host 候補が出る
      expect(localCandidateKinds(connection)).toContain("tcp/host");
    } finally {
      await arranged.close();
    }
  });

  test("staged generation の gather options が relay-only なら provisional checks は host socket を使わない", async () => {
    // Arrange: host 候補だけで接続済みの 2 agent
    const { a, b } = await createConnectedPair();
    try {
      // Act: a の staged generation を relay-only の options で stage し、provisional checks を始める
      await stageProvisionalGeneration(a, b, {
        gatherOptionsA: {
          ...a.options,
          forceTurn: true,
          turnServer: ["127.0.0.1", 3478],
          turnUsername: "user",
          turnPassword: "pass",
        },
      });
      a.startProvisionalChecks();
      b.startProvisionalChecks();

      // Assert: a の provisional checklist に host socket のペアはできない
      const provisional = (a as unknown as { provisional?: { pairs: [] } })
        .provisional;
      expect(provisional).toBeDefined();
      expect(provisional!.pairs).toHaveLength(0);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});
