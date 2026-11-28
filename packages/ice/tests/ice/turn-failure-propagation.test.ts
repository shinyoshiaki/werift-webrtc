import { setTimeout as delay } from "node:timers/promises";

import { vi } from "vitest";

import type { Address } from "../../../common/src";
import { TransactionCancelled } from "../../src/exceptions";
import { Connection } from "../../src/ice";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { TcpActiveProtocol } from "../../src/stun/tcpProtocol";
import {
  createTurnClient,
  StunOverTurnProtocol,
  type TurnProtocol,
} from "../../src/turn/protocol";
import {
  activeResourceCount,
  addClosingProtocol,
  createFaultyTurnTcpServer,
  createHangingTlsServer,
  holdLookup,
  recordTurnRequests,
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
  watchProcessErrors,
} from "../utils";
import { createScriptedUdpServer, errorResponse } from "./candidateErrorUtils";

const credentials = {
  username: TURN_TEST_USERNAME,
  password: TURN_TEST_PASSWORD,
};

/** Settle `promise` into its outcome without letting it reject. */
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: Error & { code?: string }) => ({ ok: false as const, error }),
  );

let processErrors: ReturnType<typeof watchProcessErrors>;

beforeEach(() => {
  processErrors = watchProcessErrors();
});

afterEach(async () => {
  // 遅れて settle した rejection も含め、process レベルの未処理エラーが 0 件であること。
  await processErrors.flush();
  processErrors.dispose();
  expect(processErrors.errors).toEqual([]);
});

describe("createTurnClient over TCP/TLS fails into a catchable rejection", () => {
  test("ECONNREFUSED rejects with its code and leaves no socket", async () => {
    // Arrange: 何も listen していない TCP port。
    const server = await createFaultyTurnTcpServer("refuse");
    const socketsBefore = activeResourceCount("TCPSocketWrap");

    // Act: 拒否される server へ TCP で割り当てを試みる。
    const result = await outcome(
      createTurnClient(
        { address: server.address, ...credentials },
        { transport: "tcp" },
      ),
    );

    // Assert: ECONNREFUSED で reject し、client socket は残らない。
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("ECONNREFUSED");
    await vi.waitFor(() =>
      expect(activeResourceCount("TCPSocketWrap")).toBeLessThanOrEqual(
        socketsBefore,
      ),
    );
  });

  test("a stream that never connects rejects with the connect timeout", async () => {
    // Arrange: TCP は受け付けるが TLS handshake を返さない server。
    const server = await createHangingTlsServer();
    try {
      // Act: 短い connectTimeoutMs で TLS の割り当てを試みる。
      const result = await outcome(
        createTurnClient(
          { address: server.address, ...credentials },
          {
            transport: "tls",
            tlsOptions: { rejectUnauthorized: false },
            connectTimeoutMs: 100,
          },
        ),
      );

      // Assert: connect timeout で reject し、server 側の接続も閉じられる。
      expect(!result.ok && result.error.message).toBe(
        "tls connect timed out after 100ms",
      );
      await vi.waitFor(() => expect(server.sockets.size).toBe(0));
    } finally {
      await server.close();
    }
  });

  test("a reset right after connect rejects promptly and starts no refresh", async () => {
    // Arrange: accept 直後に RST する server。
    const server = await createFaultyTurnTcpServer("rstOnConnect");
    const timersBefore = activeResourceCount("Timeout");
    try {
      // Act: 割り当てを試み、settle するまでの時間を測る。
      const startedAt = Date.now();
      const result = await outcome(
        createTurnClient(
          { address: server.address, ...credentials },
          { transport: "tcp" },
        ),
      );
      const elapsed = Date.now() - startedAt;
      await delay(20);

      // Assert: Allocate の再送上限を待たずに reject し、refresh の timer も残らない。
      expect(result.ok).toBe(false);
      expect(elapsed).toBeLessThan(2_000);
      expect(activeResourceCount("Timeout")).toBeLessThanOrEqual(timersBefore);
    } finally {
      await server.close();
    }
  });

  test("abort while the Allocate is unanswered cancels and releases the socket", async () => {
    // Arrange: 接続は受けるが応答しない server と、ICE close 相当の signal。
    const server = await createFaultyTurnTcpServer("blackhole");
    const closing = new AbortController();
    try {
      const pending = outcome(
        createTurnClient(
          { address: server.address, ...credentials },
          { transport: "tcp", signal: closing.signal },
        ),
      );
      await vi.waitFor(() => expect(server.requests.length).toBe(1));

      // Act: Allocate の応答待ちの間に abort する。
      closing.abort();
      const result = await pending;

      // Assert: TransactionCancelled で終わり、server 側の接続も閉じられる。
      expect(!result.ok && result.error).toBeInstanceOf(TransactionCancelled);
      await vi.waitFor(() => expect(server.sockets.size).toBe(0));
    } finally {
      await server.close();
    }
  });

  test("abort while the TLS connection is being established cancels at once (R2)", async () => {
    // Arrange: TLS handshake を返さない server と、長い connectTimeoutMs。
    const server = await createHangingTlsServer();
    const closing = new AbortController();
    try {
      const pending = outcome(
        createTurnClient(
          { address: server.address, ...credentials },
          {
            transport: "tls",
            tlsOptions: { rejectUnauthorized: false },
            connectTimeoutMs: 5_000,
            signal: closing.signal,
          },
        ),
      );
      await vi.waitFor(() => expect(server.sockets.size).toBe(1));

      // Act: handshake の途中で abort し、settle するまでの時間を測る。
      const startedAt = Date.now();
      closing.abort();
      const result = await pending;
      const elapsed = Date.now() - startedAt;

      // Assert: connectTimeoutMs を待たずに TransactionCancelled で終わり、接続も閉じられる。
      expect(!result.ok && result.error).toBeInstanceOf(TransactionCancelled);
      expect(elapsed).toBeLessThan(1_000);
      await vi.waitFor(() => expect(server.sockets.size).toBe(0));
    } finally {
      await server.close();
    }
  });

  test("an Allocate response arriving after abort starts nothing", async () => {
    // Arrange: 応答を 100ms 遅らせる server。
    const server = await createFaultyTurnTcpServer({ delayedResponse: 100 });
    const closing = new AbortController();
    const timersBefore = activeResourceCount("Timeout");
    try {
      const pending = outcome(
        createTurnClient(
          { address: server.address, ...credentials },
          { transport: "tcp", signal: closing.signal },
        ),
      );
      await vi.waitFor(() => expect(server.requests.length).toBe(1));

      // Act: 応答が届く前に abort し、遅れた応答が届くまで待つ。
      closing.abort();
      const result = await pending;
      await delay(200);

      // Assert: TransactionCancelled で終わり、refresh の timer は作られない。
      expect(!result.ok && result.error).toBeInstanceOf(TransactionCancelled);
      expect(activeResourceCount("Timeout")).toBeLessThanOrEqual(timersBefore);
    } finally {
      await server.close();
    }
  });
});

describe("a TURN TCP allocation whose connection goes away (R1)", () => {
  test.each(["rstAfterAllocate", "endAfterAllocate"] as const)(
    "%s stops the refresh loop and fails later requests at once",
    async (mode) => {
      // Arrange: lifetime 1 秒 (refresh は約 0.83 秒ごと) で割り当てた直後に切断する server。
      const server = await createFaultyTurnTcpServer(mode, { lifetime: 1 });
      let turn: TurnProtocol | undefined;
      try {
        turn = await createTurnClient(
          { address: server.address, ...credentials },
          { transport: "tcp" },
        );
        const requests = recordTurnRequests(turn);
        const lost = turn.onAllocationLost.asPromise();

        // Act: 切断の通知を待ち、refresh の周期を過ぎてから peer へ送信する。
        const [error] = await lost;
        await delay(1_200);
        const startedAt = Date.now();
        const sent = await outcome(
          turn.sendData(Buffer.from("payload"), ["127.0.0.1", 9]),
        );
        const elapsed = Date.now() - startedAt;

        // Assert: 割り当ての喪失が通知され、refresh は送られず、送信は再送を待たずに失敗する。
        expect(error.message).toMatch(/connection to the TURN server closed/);
        expect(requests.calls(methods.REFRESH)).toEqual([]);
        expect(sent.ok).toBe(false);
        expect(elapsed).toBeLessThan(500);
      } finally {
        await turn?.close();
        await server.close();
      }
    },
    10_000,
  );
});

describe("peer-facing STUN over a TURN connection that went away (R1)", () => {
  // 応答待ちで終わると失敗が分かるよう、判定の上限より十分長い timeout にする。
  const slowTimeout = { responseTimeout: 5_000, retransmissions: 0 };
  const binding = () => new Message(methods.BINDING, classes.REQUEST);

  /** Shared Arrange: a TCP allocation that stays up until `disconnect()`. */
  async function createPeerRequestSetup() {
    const server = await createFaultyTurnTcpServer({ delayedResponse: 0 });
    const turn = await createTurnClient(
      { address: server.address, ...credentials },
      { transport: "tcp" },
    );
    return {
      turn,
      relay: new StunOverTurnProtocol(turn),
      disconnect: async () => {
        const lost = turn.onAllocationLost.asPromise();
        for (const socket of server.sockets) socket.destroy();
        const [error] = await lost;
        return error;
      },
      close: async () => {
        await turn.close();
        await server.close();
      },
    };
  }

  test("a request started after the loss rejects with the loss error", async () => {
    // Arrange: 切断が通知された後の割り当て。
    const setup = await createPeerRequestSetup();
    try {
      const lossError = await setup.disconnect();

      // Act: peer 向けの Binding を開始する。
      const startedAt = Date.now();
      const result = await outcome(
        setup.relay.request(
          binding(),
          ["127.0.0.1", 9],
          undefined,
          slowTimeout,
        ),
      );
      const elapsed = Date.now() - startedAt;

      // Assert: timeout を待たずに喪失のエラーで失敗し、transaction は残らない。
      expect(!result.ok && result.error).toBe(lossError);
      expect(elapsed).toBeLessThan(500);
      expect(Object.keys(setup.turn.transactions)).toEqual([]);
    } finally {
      await setup.close();
    }
  });

  test("a loss during the peer address lookup rejects with the loss error", async () => {
    // Arrange: peer のアドレス解決が終わらない状態で Binding を開始する。
    const setup = await createPeerRequestSetup();
    const lookup = holdLookup("127.0.0.1");
    try {
      const pending = outcome(
        setup.relay.request(
          binding(),
          ["peer.test", 9],
          undefined,
          slowTimeout,
        ),
      );

      // Act: 解決中に切断させてから、解決を完了させる。
      const lossError = await setup.disconnect();
      const startedAt = Date.now();
      lookup.release();
      const result = await pending;
      const elapsed = Date.now() - startedAt;

      // Assert: timeout を待たずに喪失のエラーで失敗し、transaction は残らない。
      expect(!result.ok && result.error).toBe(lossError);
      expect(elapsed).toBeLessThan(500);
      expect(Object.keys(setup.turn.transactions)).toEqual([]);
    } finally {
      lookup.restore();
      await setup.close();
    }
  });

  test("a request started after close() is cancelled at once", async () => {
    // Arrange: close() 済みの割り当て。
    const setup = await createPeerRequestSetup();
    try {
      await setup.turn.close();

      // Act: peer 向けの Binding を開始する。
      const startedAt = Date.now();
      const result = await outcome(
        setup.relay.request(
          binding(),
          ["127.0.0.1", 9],
          undefined,
          slowTimeout,
        ),
      );
      const elapsed = Date.now() - startedAt;

      // Assert: timeout を待たずに TransactionCancelled で終わる。
      expect(!result.ok && result.error).toBeInstanceOf(TransactionCancelled);
      expect(elapsed).toBeLessThan(500);
    } finally {
      await setup.close();
    }
  });
});

describe("ICE gathering with a failing TURN server", () => {
  test("a UDP failure whose TCP fallback is refused is reported exactly once", async () => {
    // Arrange: UDP は 403 で拒否する TURN server (同じ port の TCP には誰も listen しない)。
    const server = await createScriptedUdpServer(
      (request) => errorResponse(request, 403, "Forbidden"),
      { host: "127.0.0.1" },
    );
    const connection = new Connection(true, {
      turnServer: server.address,
      turnUsername: TURN_TEST_USERNAME,
      turnPassword: TURN_TEST_PASSWORD,
      turnTransport: "udp",
      turnConnectTimeout: 1,
      useDefaultStunServer: false,
      useIpv4: false,
      useIpv6: false,
      additionalHostAddresses: ["127.0.0.1"],
    });
    const candidateErrors: unknown[] = [];
    connection.onIceCandidateError.subscribe((info) =>
      candidateErrors.push(info),
    );

    try {
      // Act: 候補収集を完了まで待つ。
      const gathered = await outcome(connection.gatherCandidates());

      // Assert: 収集は resolve し、失敗の通知は 1 回だけで、host 候補は残る。
      expect(gathered.ok).toBe(true);
      expect(candidateErrors).toHaveLength(1);
      expect(
        connection.localCandidates.some(({ type }) => type === "host"),
      ).toBe(true);
    } finally {
      await connection.close();
      await server.close();
    }
  });

  test.each([
    { label: "TCP with an unanswered Allocate", transport: "tcp" },
    { label: "TLS with a hanging handshake", transport: "tls" },
  ] as const)(
    "closing agents repeatedly while TURN $label connects settles promptly",
    async ({ transport }) => {
      // Arrange: 接続を完了させない TURN server (再接続ストームの置き換え対象)。
      const server =
        transport === "tcp"
          ? await createFaultyTurnTcpServer("blackhole")
          : await createHangingTlsServer();
      const candidateErrors: unknown[] = [];
      const durations: number[] = [];
      try {
        for (let round = 0; round < 5; round++) {
          const connection = new Connection(true, {
            turnServer: server.address,
            turnUsername: TURN_TEST_USERNAME,
            turnPassword: TURN_TEST_PASSWORD,
            turnTransport: transport,
            turnTlsOptions: { rejectUnauthorized: false },
            turnConnectTimeout: 5,
            useDefaultStunServer: false,
            useIpv4: false,
            useIpv6: false,
            additionalHostAddresses: ["127.0.0.1"],
          });
          connection.onIceCandidateError.subscribe((info) =>
            candidateErrors.push(info),
          );
          const gathering = outcome(connection.gatherCandidates());
          await vi.waitFor(() => expect(server.sockets.size).toBe(1));

          // Act: TURN が接続中の agent を close し、収集が settle するまでの時間を測る。
          const startedAt = Date.now();
          await connection.close();
          await gathering;
          durations.push(Date.now() - startedAt);
          await vi.waitFor(() => expect(server.sockets.size).toBe(0));
        }

        // Assert: どの close も turnConnectTimeout (5 秒) より十分短く終わり、失敗は通知されない。
        expect(Math.max(...durations)).toBeLessThan(1_000);
        expect(candidateErrors).toEqual([]);
      } finally {
        await server.close();
      }
    },
  );
});

describe("ICE-TCP active connect racing close (R3)", () => {
  test("close() during the connect settles the pending send", async () => {
    // Arrange: listen する TCP server と active protocol。
    const server = await createFaultyTurnTcpServer("blackhole");
    const protocol = new TcpActiveProtocol();
    await protocol.connectionMade("127.0.0.1");
    const pendingSockets = (
      protocol as unknown as { pendingSockets: Map<string, unknown> }
    ).pendingSockets;
    try {
      // Act: connect を始めた直後 (connect イベントより前) に close する。
      const sending = outcome(
        protocol.sendData(Buffer.from("data"), server.address as Address),
      );
      await protocol.close();
      const result = await Promise.race([
        sending,
        delay(1_000).then(() => "pending" as const),
      ]);

      // Assert: 保留中の送信は reject で settle し、pendingSockets も空になる。
      expect(result).not.toBe("pending");
      expect(result !== "pending" && result.ok).toBe(false);
      expect(pendingSockets.size).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("Connection.close() isolates protocols that fail to close (R4)", () => {
  test("closes the remaining protocols and resolves", async () => {
    // Arrange: close() が reject する protocol と、その後ろの正常な protocol。
    const connection = new Connection(true, {
      useIpv4: false,
      useIpv6: false,
      useDefaultStunServer: false,
    });
    const closed: string[] = [];
    addClosingProtocol(connection, () => {
      throw new Error("close failed");
    });
    addClosingProtocol(connection, () => {
      closed.push("second");
    });

    // Act: agent を close する。
    const result = await outcome(connection.close());

    // Assert: close() は resolve し、失敗した protocol の後ろも閉じられる。
    expect(result.ok).toBe(true);
    expect(closed).toEqual(["second"]);
  });
});
