import { setTimeout as delay } from "node:timers/promises";
import type { Address } from "../../../common/src";
import {
  classifyGatherError,
  IceCandidateErrorCode,
  MissingMappedAddressError,
  pickReportedGatherError,
} from "../../src/candidateError";
import {
  AddressFamilyMismatch,
  TransactionCancelled,
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
  localReflexiveCandidates,
  localRelayCandidates,
  localTurnServerEntry,
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
} from "../utils";
import {
  candidateErrorHost,
  createErrorStunServer,
  createFakeStunProtocol,
  createNoMappingStunServer,
  createRecordingAgent,
  createRejectingUdpTurnServer,
  createScriptedUdpServer,
  errnoError,
  errorResponse,
  hostCandidate,
  recordCandidateErrors,
  singleIpv4Socket,
} from "./candidateErrorUtils";

const NOT_REACHED = IceCandidateErrorCode.SERVER_NOT_REACHED;

describe("onIceCandidateError: STUN", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("存在しない DNS 名の STUN は 701 で通知され、host candidate のアドレスを持つ", async () => {
    // Arrange
    const server: Address = ["stun.invalid", 3478];
    const { connection, errors } = createRecordingAgent({
      stunServers: [server],
      stunServerUrls: [{ address: server, url: "stun:stun.invalid" }],
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

describe("onIceCandidateError: TURN", () => {
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
