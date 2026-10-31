import { Candidate } from "../../src/candidate";
import type { IceOptions } from "../../src/iceBase";
import {
  isCandidateAllowedByGatherOptions,
  isRelayOnlyGathering,
} from "../../src/iceBase";
import {
  connectionProtocols,
  createConnectedPair,
  createGatheredConnectionWithLocalServers,
  deliverProvisionalCheck,
  localCandidateKinds,
  provisionalPairs,
  restartWithIceServers,
  stageProvisionalGeneration,
  stageProvisionalWithKeptRelay,
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
    [{ type: "relay", transport: "udp" }, { ...turn, forceTurn: false }, true],
    // TURN が無い・資格情報が欠けた世代は relay を使わない
    [{ type: "relay", transport: "udp" }, { forceTurn: false }, false],
    [{ type: "relay", transport: "udp" }, { forceTurn: true }, false],
    [
      { type: "relay", transport: "udp" },
      { ...turn, turnUsername: undefined, forceTurn: false },
      false,
    ],
    [{ type: "host", transport: "udp" }, { ...turn, forceTurn: true }, false],
    [{ type: "srflx", transport: "udp" }, { ...turn, forceTurn: true }, false],
    [{ type: "host", transport: "tcp" }, { ...turn, forceTurn: true }, false],
    // TURN 未設定・資格情報欠落でも relay ポリシーは host / srflx に fallback しない
    [{ type: "host", transport: "udp" }, { forceTurn: true }, false],
    [{ type: "srflx", transport: "udp" }, { forceTurn: true }, false],
    [
      { type: "host", transport: "udp" },
      { ...turn, turnPassword: undefined, forceTurn: true },
      false,
    ],
    [{ type: "host", transport: "udp" }, { ...turn, forceTurn: false }, true],
    [{ type: "host", transport: "tcp" }, { useTcp: false }, false],
    [{ type: "host", transport: "tcp" }, { useTcp: true }, true],
    // ICE-lite でも relay ポリシーなら host 候補を出さない
    [
      { type: "host", transport: "udp" },
      { ...turn, forceTurn: true, iceLite: true },
      false,
    ],
  ])("%o with %o → %s", (candidate, options, allowed) => {
    // Act / Assert: 新規 gathering と同じ条件で可否が決まる
    expect(isCandidateAllowedByGatherOptions(candidate, options)).toBe(allowed);
  });

  test("isRelayOnlyGathering は TURN 設定の有無にかかわらず forceTurn で決まる", () => {
    // Act / Assert: forceTurn なら TURN 設定が揃っていなくても relay-only
    expect(isRelayOnlyGathering({ ...turn, forceTurn: true })).toBe(true);
    expect(isRelayOnlyGathering({ ...turn, forceTurn: false })).toBe(false);
    expect(isRelayOnlyGathering({ forceTurn: true })).toBe(true);
    const withoutPassword = {
      ...turn,
      turnPassword: undefined,
      forceTurn: true,
    };
    expect(isRelayOnlyGathering(withoutPassword)).toBe(true);
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

  test.each([
    ["TURN 未設定", () => ({})],
    [
      "TURN 資格情報欠落",
      (turnOptions: Partial<IceOptions>) => ({
        ...turnOptions,
        turnPassword: undefined,
      }),
    ],
  ])(
    "all → relay (%s): 直接候補へ fallback せず候補なしで host socket も閉じる",
    async (_label, turnUpdate) => {
      // Arrange: STUN のみ (relay ポリシーなし) で gather 済みの connection
      const arranged = await createGatheredConnectionWithLocalServers(
        ({ stunOptions }) => stunOptions,
      );
      const { connection, stunOptions, turnOptions } = arranged;
      try {
        expect(localCandidateKinds(connection)).toEqual(
          expect.arrayContaining(["udp/host", "udp/srflx"]),
        );

        // Act: 使える TURN が無いまま relay ポリシーに変えて ICE restart する
        await restartWithIceServers(connection, {
          ...stunOptions,
          ...turnUpdate(turnOptions),
          forceTurn: true,
        });

        // Assert: 新しい generation に host / srflx は出ず、直接通信用の socket も残らない
        expect(connection.localCandidates).toEqual([]);
        expect(connectionProtocols(connection)).toEqual([]);

        // Act: 相手の host 候補を受け取る
        connection.setRemoteParams({
          iceLite: false,
          usernameFragment: "remote",
          password: "remote-password-remote",
        });
        await connection.addRemoteCandidate(
          new Candidate("1", 1, "udp", 100, "127.0.0.1", 50000, "host"),
        );

        // Assert: 直接経路のペアはできない
        const checkList = (connection as unknown as { checkList: unknown[] })
          .checkList;
        expect(checkList).toEqual([]);
      } finally {
        await arranged.close();
      }
    },
  );

  test.each([
    ["TURN 未設定", {}],
    [
      "TURN 資格情報欠落",
      {
        turnServer: ["127.0.0.1", 3478] as [string, number],
        turnUsername: "user",
      },
    ],
  ])(
    "relay ポリシーの新規 gathering (%s) は host / srflx を gather しない",
    async (_label, turnOptions) => {
      // Arrange: STUN を持ち、使える TURN が無い relay ポリシーの connection
      const arranged = await createGatheredConnectionWithLocalServers(
        ({ stunOptions }) => ({
          ...stunOptions,
          ...turnOptions,
          forceTurn: true,
        }),
      );
      const { connection } = arranged;
      try {
        // Assert: 候補も socket も無く、gathering は完了している
        expect(connection.localCandidates).toEqual([]);
        expect(connectionProtocols(connection)).toEqual([]);
        expect(connection.state).toBe("completed");
      } finally {
        await arranged.close();
      }
    },
  );

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

describe("staged generation は保持中の TURN allocation を新しい TURN 設定でだけ使う", () => {
  test.each([
    // [label, staged generation の TURN 設定, 旧 allocation を使うか]
    ["TURN A → STUN のみ", () => ({}), false],
    [
      "TURN A → 別 credential (B)",
      (turn: Partial<IceOptions>) => ({
        ...turn,
        turnUsername: "user-b",
        turnPassword: "password-b",
      }),
      false,
    ],
    ["TURN A のまま", (turn: Partial<IceOptions>) => turn, true],
  ])(
    "%s: provisional checklist と着信 check での旧 relay socket の扱い",
    async (_label, stagedTurn, usesKeptRelay) => {
      // Arrange: STUN + TURN A で gather 済みの connection と、新しい設定で stage した世代
      const arranged = await createGatheredConnectionWithLocalServers(
        ({ stunOptions, turnOptions }) => ({ ...turnOptions, ...stunOptions }),
      );
      const { connection, stunOptions, turnOptions } = arranged;
      try {
        const staged = await stageProvisionalWithKeptRelay(connection, {
          ...stunOptions,
          ...stagedTurn(turnOptions),
          forceTurn: false,
        });

        // Assert: provisional checklist に旧 relay socket のペアができるのは TURN A を使い続けるときだけ
        expect(
          provisionalPairs(connection).some(
            (pair) => pair.protocol === staged.relay,
          ),
        ).toBe(usesKeptRelay);

        // Act: staged generation 宛ての着信 check が旧 relay socket に届く
        const responded = await deliverProvisionalCheck(staged.relay, staged);

        // Assert: 応答もペア作成も TURN A を使い続けるときだけ行う
        expect(responded).toBe(usesKeptRelay);
        expect(
          provisionalPairs(connection).filter(
            (pair) => pair.protocol === staged.relay,
          ).length > 0,
        ).toBe(usesKeptRelay);
      } finally {
        await arranged.close();
      }
    },
  );
});
