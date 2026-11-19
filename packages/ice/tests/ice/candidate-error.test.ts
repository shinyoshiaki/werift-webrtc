import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, vi } from "vitest";
import type { Address } from "../../../common/src";
import {
  classifyGatherError,
  gatherErrorReasonText,
  IceCandidateErrorCode,
  isServerAnswer,
  MASKED_REASON_TEXT,
  MissingMappedAddressError,
  pickReportedGatherError,
} from "../../src/candidateError";
import {
  AddressFamilyMismatch,
  TransactionCancelled,
  TransactionFailed,
  TransactionIntegrityViolation,
  TransactionTimeout,
} from "../../src/exceptions";
import { Connection, DEFAULT_STUN_SERVER_URL } from "../../src/ice";
import {
  normalizeIceServerOptions,
  queryServerReflexiveCandidate,
  serverReflexiveCandidate,
} from "../../src/iceBase";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { StunProtocol } from "../../src/stun/protocol";
import {
  createCountingTurnServer,
  createFixedMappingStunServer,
  createLocalTurnServer,
  createSilentUdpServer,
  fakeNetworkInterfaces,
  localReflexiveCandidates,
  localRelayCandidates,
  localTurnServerEntry,
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
} from "../utils";
import {
  candidateErrorHost,
  createCodelessErrorServer,
  createErrorStunServer,
  createFakeStunProtocol,
  createFirstPortOnlyStunServer,
  createNoMappingStunServer,
  createRecordingAgent,
  createRejectingUdpTurnServer,
  createScriptedUdpServer,
  errnoError,
  errorResponse,
  failDnsLookup,
  hangDnsLookup,
  hostCandidate,
  ipv4AndIpv6Sockets,
  recordCandidateErrors,
  recordServerReached,
  singleIpv4Socket,
  twoIpv4Sockets,
} from "./candidateErrorUtils";

// candidate-error テストでは NIC を 1 つに固定し、明示した loopback socket を追加する。
const networkInterfaces = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    networkInterfaces: () =>
      networkInterfaces.current ?? actual.networkInterfaces(),
  };
});

beforeEach(() => {
  networkInterfaces.current = fakeNetworkInterfaces({
    eth0: [candidateErrorHost],
  });
});
afterEach(() => {
  networkInterfaces.current = undefined;
  vi.restoreAllMocks();
});

const NOT_REACHED = IceCandidateErrorCode.SERVER_NOT_REACHED;

describe("onIceCandidateError: STUN", () => {
  test("存在しない DNS 名の STUN は 701 で通知され、host candidate のアドレスを持つ (名前解決の失敗)", async () => {
    // Arrange: 名前解決の失敗をすぐ返すよう注入し、gather timeout は十分長くして競合させない
    const lookup = failDnsLookup("stun.invalid");
    const server: Address = ["stun.invalid", 3478];
    const { connection, errors } = createRecordingAgent({
      stunServers: [server],
      stunServerUrls: [{ address: server, url: "stun:stun.invalid" }],
      stunGatherTimeout: 60,
    });
    try {
      // Act: 候補収集を完了まで待つ
      await connection.gatherCandidates();

      // Assert: DNS 失敗が 701 で 1 件通知され、サーバー・URL・ローカルアドレスが一致する
      const [host] = connection.localCandidates.filter(
        (candidate) => candidate.type === "host",
      );
      expect(errors).toEqual([
        {
          server: {
            kind: "stun",
            address: server,
            urls: ["stun:stun.invalid"],
          },
          address: host.host,
          port: host.port,
          errorCode: NOT_REACHED,
          errorText: "Address resolution failed",
          generation: connection.generation,
        },
      ]);
      expect(lookup).toHaveBeenCalledWith("stun.invalid", expect.anything());
      expect(connection.state).toBe("completed");
    } finally {
      await connection.close();
    }
  });

  test("名前解決が gather timeout までに終わらない STUN は、timeout の 701 で 1 回だけ通知される", async () => {
    // Arrange: 名前解決が返らないよう注入し、gather timeout を短くする
    const lookup = hangDnsLookup("stun.slow.invalid");
    const server: Address = ["stun.slow.invalid", 3478];
    const { connection, errors } = createRecordingAgent({
      stunServers: [server],
      stunServerUrls: [{ address: server, url: "stun:stun.slow.invalid" }],
      stunGatherTimeout: 0.2,
    });
    try {
      // Act: 候補収集を完了まで待つ
      await connection.gatherCandidates();

      // Assert: 名前解決の途中で満了し、timeout の文言の 701 が 1 件
      expect(lookup).toHaveBeenCalledWith(
        "stun.slow.invalid",
        expect.anything(),
      );
      expect(
        errors.map(({ errorCode, errorText, server }) => [
          errorCode,
          errorText,
          server.urls,
        ]),
      ).toEqual([
        [
          NOT_REACHED,
          "STUN binding request timed out",
          ["stun:stun.slow.invalid"],
        ],
      ]);
      expect(connection.state).toBe("completed");
    } finally {
      await connection.close();
    }
  });

  test("応答しない STUN は stunGatherTimeout の満了で 701 が 1 回だけ出て、遅れた応答は無視される", async () => {
    // Arrange: タイムアウト (100ms) より後 (400ms) にエラー応答を返す STUN
    const server = await createScriptedUdpServer(
      (request) => errorResponse(request, 500, "Server Error"),
      { delayMs: 400 },
    );
    const { connection, errors } = createRecordingAgent({
      stunServers: [server.address],
      stunGatherTimeout: 0.1,
    });
    try {
      // Act: 候補収集を完了させ、遅れた応答が届くまで待つ
      await connection.gatherCandidates();
      await delay(600);

      // Assert: タイムアウトの 701 だけが 1 件。遅れたエラー応答は通知されない
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        server: { kind: "stun", address: server.address },
        errorCode: NOT_REACHED,
        errorText: "STUN binding request timed out",
      });
      expect(errors[0].server.urls).toBeUndefined();
      expect(server.requests.length).toBeGreaterThan(0);
    } finally {
      await connection.close();
      await server.close();
    }
  });

  test("STUN の理由句はそのまま errorText になり、応答の REALM / NONCE は伏せられ、空なら登録済みの文言になる", async () => {
    // Arrange: 独自の理由句、REALM / NONCE を含む理由句、空の理由句 (未登録コード) を返す STUN
    const custom = await createErrorStunServer(400, "Missing fingerprint");
    const withRealm = await createScriptedUdpServer((request) =>
      errorResponse(request, 420, "Bad realm=werift.test nonce=nonce-1", [
        ["REALM", "werift.test"],
        ["NONCE", Buffer.from("nonce-1")],
      ]),
    );
    const empty = await createErrorStunServer(499, "");
    const { connection, errors } = createRecordingAgent({
      stunServers: [custom.address, withRealm.address, empty.address],
    });
    try {
      // Act: 候補収集を完了まで待つ
      await connection.gatherCandidates();

      // Assert: サーバーの理由句を診断情報として残し、realm / nonce は伏せ、空ならコードの文言
      expect(
        errors.map(({ errorCode, errorText }) => [errorCode, errorText]).sort(),
      ).toEqual([
        [400, "Missing fingerprint"],
        [420, `Bad realm=${MASKED_REASON_TEXT} nonce=${MASKED_REASON_TEXT}`],
        [499, "STUN error 499"],
      ]);
      expect(JSON.stringify(errors)).not.toContain("werift.test");
      expect(JSON.stringify(errors)).not.toContain("nonce-1");
    } finally {
      await connection.close();
      await custom.close();
      await withRealm.close();
      await empty.close();
    }
  });

  test("STUN Binding のエラー応答はそのエラーコードと reason phrase で通知される", async () => {
    // Arrange
    const server = await createErrorStunServer(400, "Bad Request");
    const { connection, errors } = createRecordingAgent({
      stunServers: [server.address],
    });
    try {
      // Act
      await connection.gatherCandidates();

      // Assert: 400 / "Bad Request" が 1 件
      expect(
        errors.map(({ errorCode, errorText }) => [errorCode, errorText]),
      ).toEqual([[400, "Bad Request"]]);
      expect(localReflexiveCandidates(connection)).toHaveLength(0);
    } finally {
      await connection.close();
      await server.close();
    }
  });

  test("送信時の socket error (EHOSTUNREACH) は 701 と errno の説明で通知される", async () => {
    // Arrange: STUN request が EHOSTUNREACH で失敗するよう注入する
    vi.spyOn(StunProtocol.prototype, "request").mockRejectedValue(
      errnoError("EHOSTUNREACH"),
    );
    const server: Address = ["192.0.2.1", 3478];
    const { connection, errors } = createRecordingAgent({
      stunServers: [server],
    });
    try {
      // Act
      await connection.gatherCandidates();

      // Assert
      expect(
        errors.map(({ errorCode, errorText }) => [errorCode, errorText]),
      ).toEqual([[NOT_REACHED, "Host unreachable"]]);
    } finally {
      await connection.close();
    }
  });

  test("リスナーが throw しても候補収集は止まらない", async () => {
    // Arrange
    const server = await createErrorStunServer(400, "Bad Request");
    const { connection } = createRecordingAgent({
      stunServers: [server.address],
    });
    connection.onIceCandidateError.subscribe(() => {
      throw new Error("listener failure");
    });
    try {
      // Act
      await connection.gatherCandidates();

      // Assert: gathering は完了し end-of-candidates に到達する
      expect(connection.localCandidatesEnd).toBe(true);
      expect(connection.state).toBe("completed");
    } finally {
      await connection.close();
      await server.close();
    }
  });

  test("一方のソケットだけがサーバーに届いたときは 701 を通知しない", async () => {
    // Arrange: 2 つの IPv4 ソケットのうち最初に問い合わせたポートにだけ応答する STUN
    const server = await createFirstPortOnlyStunServer();
    const { connection, errors } = createRecordingAgent({
      ...twoIpv4Sockets,
      stunServers: [server.address],
      stunGatherTimeout: 0.3,
    });
    try {
      // Act: 候補収集を完了まで待つ
      await connection.gatherCandidates();

      // Assert: ソケットは 2 つ、srflx は 1 つ得られ、701 は出ない
      expect(
        connection.localCandidates.filter(
          (candidate) => candidate.type === "host",
        ),
      ).toHaveLength(2);
      expect(
        connection.localCandidates.filter(
          (candidate) => candidate.type === "srflx",
        ),
      ).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await connection.close();
      await server.close();
    }
  });

  test("どのソケットもサーバーに届かないときは 701 をサーバーごとに 1 件だけ通知する", async () => {
    // Arrange: 2 つの IPv4 ソケットと応答しない STUN
    const silent = await createSilentUdpServer(candidateErrorHost);
    const { connection, errors } = createRecordingAgent({
      ...twoIpv4Sockets,
      stunServers: [silent.address],
      stunGatherTimeout: 0.3,
    });
    try {
      // Act: 候補収集を完了まで待つ
      await connection.gatherCandidates();

      // Assert: ソケットは 2 つ、701 は 1 件で、そのソケットの一方のアドレスを持つ
      const hosts = connection.localCandidates.filter(
        (candidate) => candidate.type === "host",
      );
      expect(hosts).toHaveLength(2);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        server: { kind: "stun", address: silent.address },
        errorCode: NOT_REACHED,
      });
      expect(hosts.map((host) => host.port)).toContain(errors[0].port);
    } finally {
      await connection.close();
      await silent.close();
    }
  });

  test("STUN を問い合わせない IPv6 ソケットがあっても、IPv4 ソケットが届かなければ 701 を 1 件通知する", async () => {
    // Arrange: IPv4 と IPv6 (問い合わせない) のソケットと、応答しない STUN
    const silent = await createSilentUdpServer(candidateErrorHost);
    const { connection, errors } = createRecordingAgent({
      ...ipv4AndIpv6Sockets,
      stunServers: [silent.address],
      stunGatherTimeout: 0.3,
    });
    try {
      // Act: 候補収集を完了まで待つ
      await connection.gatherCandidates();
      await delay(100);

      // Assert: IPv6 のホスト候補もあり、701 は IPv4 ソケットのアドレスで 1 件
      const hosts = connection.localCandidates.filter(
        (candidate) => candidate.type === "host",
      );
      expect(hosts.map(({ host }) => host).sort()).toEqual(
        ["::1", candidateErrorHost].sort(),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        errorCode: NOT_REACHED,
        address: candidateErrorHost,
      });
    } finally {
      await connection.close();
      await silent.close();
    }
  });

  test("開けなかったソケットがあっても、他のソケットが届かなければ 701 を 1 件通知する", async () => {
    // Arrange: このホストにない IPv6 アドレス (bind が失敗する) と、応答しない STUN を使う
    const silent = await createSilentUdpServer(candidateErrorHost);
    const { connection, errors } = createRecordingAgent({
      useIpv6: true,
      interfaceAddresses: { udp4: candidateErrorHost, udp6: "2001:db8::1" },
      stunServers: [silent.address],
      stunGatherTimeout: 0.3,
    });
    try {
      // Act: 候補収集を完了まで待つ
      await connection.gatherCandidates();
      await delay(100);

      // Assert: 開けたのは IPv4 ソケットだけで、その 701 が 1 件
      expect(
        connection.localCandidates
          .filter((candidate) => candidate.type === "host")
          .map(({ host }) => host),
      ).toEqual([candidateErrorHost]);
      expect(errors).toHaveLength(1);
      expect(errors[0].errorCode).toBe(NOT_REACHED);
    } finally {
      await connection.close();
      await silent.close();
    }
  });

  test("サーバーのエラー応答 (701 以外) はソケットごとに通知する", async () => {
    // Arrange: 2 つの IPv4 ソケットと 400 を返す STUN
    const server = await createErrorStunServer(400, "Bad Request");
    const { connection, errors } = createRecordingAgent({
      ...twoIpv4Sockets,
      stunServers: [server.address],
    });
    try {
      // Act: 候補収集を完了まで待つ
      await connection.gatherCandidates();

      // Assert: 2 host sockets と wildcard socket から 400 が届く
      expect(errors.map((error) => error.errorCode)).toEqual([400, 400, 400]);
      expect(new Set(errors.map((error) => error.port)).size).toBe(3);
    } finally {
      await connection.close();
      await server.close();
    }
  });

  test("STUN を設定しないときの既定 STUN の失敗は合成した URL で通知される", async () => {
    // Arrange: 既定の STUN を使い、応答より先に満了するほど短くする
    // (ネットワークの有無によらず、満了または DNS 失敗の 701 になる)
    const connection = new Connection(true, {
      ...singleIpv4Socket,
      stunGatherTimeout: 0.001,
    });
    const errors = recordCandidateErrors(connection);
    try {
      // Act: 候補収集を完了まで待つ
      await connection.gatherCandidates();

      // Assert: 既定サーバーを合成 URL で指す 701 が 1 件
      expect(errors).toHaveLength(1);
      expect(errors[0].server).toEqual({
        kind: "stun",
        address: ["stun.l.google.com", 19302],
        urls: [DEFAULT_STUN_SERVER_URL],
      });
      expect(DEFAULT_STUN_SERVER_URL).toBe("stun:stun.l.google.com:19302");
      expect(errors[0].errorCode).toBe(NOT_REACHED);
    } finally {
      await connection.close();
    }
  });

  test("useDefaultStunServer: false では既定 STUN を使わず通知もない", async () => {
    // Arrange
    const connection = new Connection(true, {
      ...singleIpv4Socket,
      useDefaultStunServer: false,
      stunGatherTimeout: 0.001,
    });
    const errors = recordCandidateErrors(connection);
    try {
      // Act
      await connection.gatherCandidates();

      // Assert
      expect(connection.stunServers).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await connection.close();
    }
  });
});

describe("応答はあったが STUN エラーコードのないサーバー (到達済み)", () => {
  test.each([
    ["XOR-MAPPED-ADDRESS のない成功応答", createNoMappingStunServer],
    ["ERROR-CODE のないエラー応答", createCodelessErrorServer],
  ] as const)(
    "STUN: %s は 701 にせず通知もしないで、到達として扱う",
    async (_name, createServer) => {
      // Arrange: 2 ソケットとも応答を受けるが候補にならない STUN
      const server = await createServer();
      const { connection, errors } = createRecordingAgent({
        ...twoIpv4Sockets,
        stunServers: [server.address],
        stunGatherTimeout: 0.5,
      });
      const reached = recordServerReached(connection);
      try {
        // Act: 候補収集を完了まで待つ
        await connection.gatherCandidates();

        // Assert: 応答は届いたので 701 も他のエラーも出ず、到達として通知される
        expect(server.requests.length).toBeGreaterThan(0);
        expect(errors).toEqual([]);
        expect(reached.length).toBeGreaterThan(0);
        expect(reached[0].server.address).toEqual(server.address);
      } finally {
        await connection.close();
        await server.close();
      }
    },
  );

  test("TURN: UDP がエラーコードのない応答を受け、TCP フォールバックが接続できなくても 701 にしない", async () => {
    // Arrange: Allocate に ERROR-CODE のないエラー応答を返す UDP の TURN (TCP は待ち受けない)
    const server = await createCodelessErrorServer();
    const { connection, errors } = createRecordingAgent({
      turnServers: [
        {
          address: server.address,
          username: TURN_TEST_USERNAME,
          password: TURN_TEST_PASSWORD,
          transport: "udp",
          urls: ["turn:example.test:3478"],
        },
      ],
      forceTurn: true,
      turnConnectTimeout: 0.5,
    });
    const reached = recordServerReached(connection);
    try {
      // Act: UDP の失敗 → TCP フォールバックの失敗まで待つ
      await connection.gatherCandidates();

      // Assert: UDP で応答があったので到達。TCP の未到達は 701 にならない
      expect(server.requests.length).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      expect(reached.map(({ server }) => server.urls)).toEqual([
        ["turn:example.test:3478"],
      ]);
    } finally {
      await connection.close();
      await server.close();
    }
  });
});

describe("onIceCandidateError: TURN", () => {
  test("TURN の理由句に設定済みの username / password と realm / nonce があっても errorText では伏せられる", async () => {
    // Arrange: 理由句に設定済みの資格情報とチャレンジの realm / nonce を入れて 401 を返し続ける TURN
    const password = "turn-secret-password";
    const rejecting = await createRejectingUdpTurnServer(
      `Unauthorized ${TURN_TEST_USERNAME}:${password} realm=werift.test nonce=nonce-1`,
    );
    const { connection, errors } = createRecordingAgent({
      turnServers: [
        {
          address: rejecting.address,
          username: TURN_TEST_USERNAME,
          password,
          transport: "udp",
        },
      ],
      forceTurn: true,
      turnConnectTimeout: 0.5,
    });
    try {
      // Act: UDP の失敗 → TCP フォールバックの失敗まで待つ
      await connection.gatherCandidates();

      // Assert: 401 の理由句は残り、設定した資格情報と応答の realm / nonce だけが伏せられる
      const m = MASKED_REASON_TEXT;
      expect(
        errors.map(({ errorCode, errorText }) => [errorCode, errorText]),
      ).toEqual([[401, `Unauthorized ${m}:${m} realm=${m} nonce=${m}`]]);
      const serialized = JSON.stringify(errors);
      for (const secret of [
        TURN_TEST_USERNAME,
        password,
        "werift.test",
        "nonce-1",
      ]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      await connection.close();
      await rejecting.close();
    }
  });

  test("誤った credential (2 回目の 401) は 401 で 1 回通知され、errorText に credential を含まない", async () => {
    // Arrange: 正しい credential とは別の password を使う
    const server = await createLocalTurnServer(candidateErrorHost);
    const wrongPassword = "wrong-secret-password";
    const { connection, errors } = createRecordingAgent({
      turnServers: [
        {
          ...localTurnServerEntry(server, { password: wrongPassword }),
          urls: ["turn:example.test:3478"],
        },
      ],
      forceTurn: true,
    });
    try {
      // Act: UDP の失敗 → TCP フォールバックの失敗まで待つ
      await connection.gatherCandidates();

      // Assert: 1 サーバー 1 通知で 401。URL は渡したまま、credential は含まない
      expect(errors).toHaveLength(1);
      const [error] = errors;
      expect(error.errorCode).toBe(401);
      expect(error.server).toEqual({
        kind: "turn",
        address: server.address,
        transport: "udp",
        urls: ["turn:example.test:3478"],
      });
      expect(error.address).toBeUndefined();
      expect(error.port).toBeUndefined();
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(wrongPassword);
      expect(serialized).not.toContain(TURN_TEST_USERNAME);
      expect(localRelayCandidates(connection)).toHaveLength(0);
    } finally {
      await connection.close();
      await server.close();
    }
  });

  test("UDP が 401、TCP フォールバックが接続拒否のとき、通知は 1 回でサーバーのエラーコードが 701 より優先される", async () => {
    // Arrange: UDP だけで 401 を返し、同じポートの TCP は listen していない
    const server = await createRejectingUdpTurnServer();
    const { connection, errors } = createRecordingAgent({
      turnServers: [
        {
          address: server.address,
          username: TURN_TEST_USERNAME,
          password: TURN_TEST_PASSWORD,
        },
      ],
      forceTurn: true,
    });
    try {
      // Act
      await connection.gatherCandidates();

      // Assert: UDP で 2 回の Allocate (challenge と再送) があり、通知は 401 の 1 件
      expect(server.requests.length).toBe(2);
      expect(errors.map(({ errorCode }) => errorCode)).toEqual([401]);
      expect(errors[0].server).toMatchObject({
        kind: "turn",
        transport: "udp",
      });
    } finally {
      await connection.close();
      await server.close();
    }
  });

  test("正常な 401 → 再送 → 成功では通知されず relay candidate が出る", async () => {
    // Arrange
    const server = await createCountingTurnServer(candidateErrorHost);
    const { connection, errors } = createRecordingAgent({
      turnServers: [localTurnServerEntry(server)],
      forceTurn: true,
    });
    try {
      // Act
      await connection.gatherCandidates();

      // Assert: challenge 付きの 2 回の Allocate で成功し、エラーは 0 件
      expect(server.allocateRequests.length).toBe(2);
      expect(localRelayCandidates(connection)).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await connection.close();
      await server.close();
    }
  });
});

describe("onIceCandidateError: mixed and lifecycle", () => {
  test("正常なサーバーと失敗するサーバーが混在しても正常な候補が出て、失敗だけが通知される", async () => {
    // Arrange
    const goodStun = await createFixedMappingStunServer(candidateErrorHost, [
      "198.51.100.10",
      40000,
    ]);
    const badStun = await createErrorStunServer(500, "Server Error");
    const goodTurn = await createLocalTurnServer(candidateErrorHost);
    const badTurn = await createRejectingUdpTurnServer();
    const { connection, errors } = createRecordingAgent({
      stunServers: [goodStun.address, badStun.address],
      turnServers: [
        localTurnServerEntry(goodTurn),
        {
          address: badTurn.address,
          username: TURN_TEST_USERNAME,
          password: TURN_TEST_PASSWORD,
          urls: ["turn:bad.test"],
        },
      ],
    });
    try {
      // Act
      await connection.gatherCandidates();

      // Assert: srflx / relay は出て gathering は完了し、失敗した 2 サーバーだけ通知される
      expect(connection.localCandidatesEnd).toBe(true);
      expect(localReflexiveCandidates(connection)).toHaveLength(1);
      expect(localRelayCandidates(connection)).toHaveLength(1);
      expect(
        errors.map(({ server, errorCode }) => [server.kind, errorCode]).sort(),
      ).toEqual([
        ["stun", 500],
        ["turn", 401],
      ]);
    } finally {
      await connection.close();
      await Promise.all([
        goodStun.close(),
        badStun.close(),
        goodTurn.close(),
        badTurn.close(),
      ]);
    }
  });

  test("close() の後に満了したタイムアウトや失敗は通知されない", async () => {
    // Arrange: 応答しない STUN と TURN
    const silent = await createSilentUdpServer(candidateErrorHost);
    const { connection, errors } = createRecordingAgent({
      stunServers: [silent.address],
      turnServers: [
        {
          address: silent.address,
          username: TURN_TEST_USERNAME,
          password: TURN_TEST_PASSWORD,
        },
      ],
      stunGatherTimeout: 0.2,
    });
    try {
      const gathering = connection.gatherCandidates();
      await delay(50);

      // Act: タイムアウト前に close する
      await connection.close();
      await gathering;
      await delay(300);

      // Assert: 通知は 0 件で、Event は完了している
      expect(errors).toEqual([]);
      expect(connection.onIceCandidateError.ended).toBe(true);
    } finally {
      await silent.close();
    }
  });

  test("ICE restart で置き換えられた世代の失敗は通知されず、新しい世代の失敗だけが出る", async () => {
    // Arrange: 応答しない STUN で gather を始める
    const silent = await createSilentUdpServer(candidateErrorHost);
    const { connection, errors } = createRecordingAgent({
      stunServers: [silent.address],
      stunGatherTimeout: 0.2,
    });
    try {
      const first = connection.gatherCandidates();
      await delay(50);

      // Act: タイムアウト前に restart し、新しい世代の gather を完了させる
      await connection.restart();
      const generation = connection.generation;
      await connection.gatherCandidates();
      await first;
      await delay(300);

      // Assert: 通知はすべて新しい世代のもの (ソケット 1 つにつき 1 件)
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((error) => error.generation === generation)).toBe(
        true,
      );
      const keys = errors.map((error) => `${error.address}:${error.port}`);
      expect(new Set(keys).size).toBe(keys.length);
    } finally {
      await connection.close();
      await silent.close();
    }
  });
});

describe("onIceServerReached", () => {
  test("STUN の成功応答とエラー応答は到達として通知され、無応答は通知されない", async () => {
    // Arrange: 成功を返す STUN、400 を返す STUN、応答しない STUN
    const good = await createFixedMappingStunServer(candidateErrorHost, [
      "203.0.113.1",
      40000,
    ]);
    const failing = await createErrorStunServer(400, "Bad Request");
    const silent = await createSilentUdpServer(candidateErrorHost);
    const { connection } = createRecordingAgent({
      stunServers: [good.address, failing.address, silent.address],
      stunGatherTimeout: 0.3,
    });
    const reached = recordServerReached(connection);
    try {
      // Act: 候補収集を完了まで待つ
      await connection.gatherCandidates();

      // Assert: 応答した 2 サーバーだけが現在の世代で到達として通知される
      expect(
        reached.map(({ server, generation }) => [server.address, generation]),
      ).toEqual(
        expect.arrayContaining([
          [good.address, connection.generation],
          [failing.address, connection.generation],
        ]),
      );
      expect(reached).toHaveLength(2);
    } finally {
      await connection.close();
      await good.close();
      await failing.close();
      await silent.close();
    }
  });

  test("TURN の割り当て成功は到達として通知される", async () => {
    // Arrange
    const server = await createLocalTurnServer(candidateErrorHost);
    const { connection } = createRecordingAgent({
      turnServers: [
        { ...localTurnServerEntry(server), urls: ["turn:example.test:3478"] },
      ],
      forceTurn: true,
    });
    const reached = recordServerReached(connection);
    try {
      // Act: 候補収集を完了まで待つ
      await connection.gatherCandidates();

      // Assert: TURN サーバーが URL 付きで 1 回通知される
      expect(reached.map(({ server }) => server)).toEqual([
        {
          kind: "turn",
          address: server.address,
          transport: "udp",
          urls: ["turn:example.test:3478"],
        },
      ]);
    } finally {
      await connection.close();
      await server.close();
    }
  });
});

describe("queryServerReflexiveCandidate / serverReflexiveCandidate", () => {
  const server: Address = ["192.0.2.1", 3478];
  const failures: [string, () => Promise<[Message, Address]>, unknown][] = [
    [
      "timeout",
      async () => {
        throw new TransactionTimeout();
      },
      TransactionTimeout,
    ],
    [
      "DNS failure",
      async () => {
        throw errnoError("ENOTFOUND");
      },
      Error,
    ],
    [
      "XOR-MAPPED-ADDRESS 欠落",
      async () => [new Message(methods.BINDING, classes.RESPONSE), server],
      MissingMappedAddressError,
    ],
  ];

  test.each(failures)(
    "%s で queryServerReflexiveCandidate は reject し、serverReflexiveCandidate は undefined を返す",
    async (_name, request, expected) => {
      // Arrange
      const { protocol } = createFakeStunProtocol(request);

      // Act / Assert: throw する版は reject する
      await expect(
        queryServerReflexiveCandidate(protocol, server),
      ).rejects.toBeInstanceOf(expected as never);
      // Act / Assert: 従来の版は reject せず undefined を返す (互換性)
      await expect(serverReflexiveCandidate(protocol, server)).resolves.toBe(
        undefined,
      );
    },
  );

  test("エラー応答で reject し、ローカル候補がなければ送信前に reject する", async () => {
    // Arrange
    const errorServer = await createErrorStunServer(400, "Bad Request");
    const noMapping = await createNoMappingStunServer();
    const protocol = new StunProtocol();
    await protocol.connectionMade(true);
    protocol.localCandidate = hostCandidate(protocol.getExtraInfo()[1]);
    const { protocol: bare, sent } = createFakeStunProtocol(
      async () => {
        throw new Error("unreachable");
      },
      { withLocalCandidate: false },
    );
    try {
      // Act / Assert: エラー応答はそのコードを持つ TransactionFailed で reject
      const failed = await queryServerReflexiveCandidate(
        protocol,
        errorServer.address,
      ).catch((error) => error);
      expect(classifyGatherError(failed, { kind: "stun" })).toEqual({
        errorCode: 400,
        errorText: "Bad Request",
      });
      // Act / Assert: XOR-MAPPED-ADDRESS のない成功応答
      await expect(
        queryServerReflexiveCandidate(protocol, noMapping.address),
      ).rejects.toBeInstanceOf(MissingMappedAddressError);
      // Act / Assert: ローカル候補のない protocol は送信せずに reject
      await expect(
        queryServerReflexiveCandidate(bare, server),
      ).rejects.toThrow();
      expect(sent).toHaveLength(0);
      await expect(serverReflexiveCandidate(bare, server)).resolves.toBe(
        undefined,
      );
    } finally {
      await protocol.close();
      await errorServer.close();
      await noMapping.close();
    }
  });
});

describe("classifyGatherError", () => {
  test.each([
    [
      new TransactionTimeout(),
      "stun",
      undefined,
      NOT_REACHED,
      "STUN binding request timed out",
    ],
    [
      new TransactionTimeout(),
      "turn",
      "udp",
      NOT_REACHED,
      "TURN allocate request timed out",
    ],
    [
      errnoError("ENOTFOUND"),
      "stun",
      undefined,
      NOT_REACHED,
      "Address resolution failed",
    ],
    [
      errnoError("EAI_AGAIN"),
      "turn",
      "tcp",
      NOT_REACHED,
      "Address resolution failed",
    ],
    [
      new AddressFamilyMismatch(["::1", 3478], 4),
      "stun",
      undefined,
      NOT_REACHED,
      "No address of the socket family",
    ],
    [
      errnoError("ECONNREFUSED"),
      "turn",
      "tcp",
      NOT_REACHED,
      "TCP connect failed",
    ],
    [
      new Error("tcp connect timed out after 8000ms"),
      "turn",
      "tcp",
      NOT_REACHED,
      "TCP connect failed",
    ],
    [
      errnoError("DEPTH_ZERO_SELF_SIGNED_CERT"),
      "turn",
      "tls",
      NOT_REACHED,
      "TLS handshake failed",
    ],
    [
      errnoError("EHOSTUNREACH"),
      "stun",
      undefined,
      NOT_REACHED,
      "Host unreachable",
    ],
    [
      errnoError("ENETUNREACH"),
      "turn",
      "udp",
      NOT_REACHED,
      "Network unreachable",
    ],
  ] as const)(
    "%s (%s/%s) は %i / %s",
    (error, kind, transport, errorCode, errorText) => {
      // Act
      const result = classifyGatherError(error, { kind, transport });

      // Assert
      expect(result).toEqual({ errorCode, errorText });
    },
  );

  test("STUN エラーコードのない応答は通知しない (到達済み)。応答のない失敗は到達ではない", () => {
    // Arrange: ERROR-CODE のないエラー応答、MESSAGE-INTEGRITY 失敗、XOR-MAPPED-ADDRESS 欠落
    const address: Address = ["192.0.2.1", 3478];
    const codeless = new TransactionFailed(
      new Message(methods.BINDING, classes.ERROR),
      address,
    );
    const integrity = new TransactionIntegrityViolation(address);
    const noMapping = new MissingMappedAddressError(address);

    // Act / Assert: 応答があったものは通知対象外で、到達として扱う
    for (const error of [codeless, integrity, noMapping]) {
      expect(classifyGatherError(error, { kind: "stun" })).toBeUndefined();
      expect(isServerAnswer(error)).toBe(true);
    }
    // Act / Assert: エラーコード付きの応答は到達かつ通知対象
    const withCode = new TransactionFailed(
      new Message(methods.BINDING, classes.ERROR).setAttribute("ERROR-CODE", [
        400,
        "x",
      ]),
      address,
    );
    expect(isServerAnswer(withCode)).toBe(true);
    // Act / Assert: 応答のない失敗は到達ではない
    expect(isServerAnswer(new TransactionTimeout())).toBe(false);
    expect(isServerAnswer(errnoError("ENOTFOUND"))).toBe(false);
  });

  test("gatherErrorReasonText: 既知の資格情報を伏せ、制御文字を除き、127 文字に切り、空なら登録済みの文言", () => {
    // Arrange: secret を部分文字列に含む長い secret と、USERNAME 属性を持つ応答
    const response = new Message(methods.ALLOCATE, classes.ERROR)
      .setAttribute("USERNAME", "alice")
      .setAttribute("REALM", "example.org");
    const m = MASKED_REASON_TEXT;

    // Act / Assert: 送った資格情報と応答の USERNAME / REALM が伏せられ、長い secret は丸ごと伏せられる
    expect(
      gatherErrorReasonText(
        401,
        "no alice@example.org pw=secret-long nonce?",
        response,
        ["secret", "secret-long"],
      ),
    ).toBe(`no ${m}@${m} pw=${m} nonce?`);
    // Act / Assert: 制御文字は除かれ、前後の空白は詰められる
    expect(gatherErrorReasonText(400, " bad\u0000\u001f\u007f text ")).toBe(
      "bad text",
    );
    // Act / Assert: 127 文字に切られる
    expect(gatherErrorReasonText(400, "x".repeat(300))).toHaveLength(127);
    // Act / Assert: 空・文字列でない・伏せた後の空白だけでも、登録済みの文言になる
    expect(gatherErrorReasonText(438, "")).toBe("Stale Nonce");
    expect(gatherErrorReasonText(499, undefined)).toBe("STUN error 499");
  });

  test("TransactionCancelled は通知しない", () => {
    // Act / Assert
    expect(
      classifyGatherError(new TransactionCancelled(), { kind: "turn" }),
    ).toBeUndefined();
  });

  test("サーバーのエラーコードは 701 より優先され、なければ最後の失敗", () => {
    // Act / Assert
    expect(
      pickReportedGatherError([
        { errorCode: 401, errorText: "Unauthorized" },
        { errorCode: 701, errorText: "TCP connect failed" },
      ]),
    ).toEqual({ errorCode: 401, errorText: "Unauthorized" });
    expect(
      pickReportedGatherError([
        { errorCode: 701, errorText: "TURN allocate request timed out" },
        { errorCode: 701, errorText: "TCP connect failed" },
      ]),
    ).toEqual({ errorCode: 701, errorText: "TCP connect failed" });
  });
});

describe("normalizeIceServerOptions: urls", () => {
  test("重複した TURN をまとめるとき urls が合わさり、credential は urls に入らない", () => {
    // Arrange
    const base = {
      address: ["turn.example.com", 3478] as Address,
      username: "user",
      password: "secret",
    };

    // Act
    const { turnServers } = normalizeIceServerOptions({
      turnServers: [
        { ...base, urls: ["turn:turn.example.com"] },
        {
          ...base,
          transport: "udp",
          urls: ["turn:turn.example.com:3478?transport=udp"],
        },
        { ...base, urls: ["turn:turn.example.com"] },
      ],
    });

    // Assert: 1 サーバーに URL が設定順で 1 回ずつ
    expect(turnServers).toHaveLength(1);
    expect(turnServers[0].urls).toEqual([
      "turn:turn.example.com",
      "turn:turn.example.com:3478?transport=udp",
    ]);
    expect(JSON.stringify(turnServers[0].urls)).not.toContain("secret");
  });
});
