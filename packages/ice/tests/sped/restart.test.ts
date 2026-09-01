import { CandidatePair, CandidatePairState } from "../../src";
import { Candidate } from "../../src/candidate";
import { TransactionTimeout } from "../../src/exceptions";
import { attachSpedToConnection } from "../../src/internal/sped";
import { encodeSpedAck, spedDataCrc32 } from "../../src/sped/draft00";
import {
  DTLS_IN_STUN_ACK,
  DTLS_IN_STUN_DATA,
} from "../../src/sped/draft00/constants";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { getRawAttributeValue } from "../../src/stun/rawAttributeValue";
import { createTestConnection } from "../utils";
import { SpedProtocolMock, spedPair, tcpSpedPair } from "./helpers";

describe("ICE restart と SPED carry", () => {
  it("await 後の旧 generation 応答は pair / role / nomination を更新しない", async () => {
    // Arrange: checkStart が STUN 応答待ちのまま restart する
    const connection = createTestConnection(true);
    connection.remoteUsername = "remote";
    connection.remotePassword = "remotepw";
    const protocol = new SpedProtocolMock();
    (connection as any).ensureProtocol(protocol);
    const pair = new CandidatePair(
      protocol,
      new Candidate("r", 1, "udp", 1, "9.9.9.9", 9, "host"),
      true,
    );
    pair.updateState(CandidatePairState.WAITING);
    connection.checkList.push(pair);
    let release!: (value: [Message, [string, number]]) => void;
    protocol.request = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const controlling = connection.iceControlling;

    // Act: 旧 transaction の応答を restart 後に渡す
    const pending = (connection as any).checkStart(pair);
    await new Promise((r) => setTimeout(r, 10));
    await connection.restart();
    const response = new Message(methods.BINDING, classes.RESPONSE);
    release([response, ["9.9.9.9", 9]]);
    await pending.awaitable;

    // Assert: 旧 pair の副作用は捨て、現行 generation の role は維持
    expect(pair.state).not.toBe(CandidatePairState.SUCCEEDED);
    expect(pair.nominated).toBe(false);
    expect(pair.responsesReceived).toBe(0);
    expect(connection.iceControlling).toBe(controlling);
    expect(connection.nominated).toBeUndefined();
    expect(connection.checkList).toHaveLength(0);
  });

  it("handshake 中の reset は current flight を新 generation の L1 に戻す", async () => {
    // Arrange
    const connection = createTestConnection(true);
    const flight = [Buffer.from([22, 1, 2, 3])];
    const handle = attachSpedToConnection(connection, {
      inject: async () => {},
      onFallbackFlight: async () => {},
      onSessionReset: () => {
        handle.session.replaceL1(flight);
      },
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });
    handle.onFlightCreated(flight);

    // Act
    await connection.restart();

    // Assert: L1 は消えたままにせず reseed される
    expect(handle.session.generation).toBe(connection.generation);
    expect(handle.session.hasL1).toBe(true);
    expect(handle.session.l1Datagrams[0]!.equals(flight[0]!)).toBe(true);
    expect(handle.session.state).toBe("probing");
  });

  it("inject 実行中の restart は carrier flight を新 L1 に載せない", async () => {
    // Arrange: inject が DTLS 処理相当で止まっているあいだに restart する
    let release!: () => void;
    const connection = createTestConnection(true);
    const original = Buffer.from([22, 1, 1, 1]);
    const stale = Buffer.from([22, 9, 9, 9]);
    const handle = attachSpedToConnection(connection, {
      inject: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      onFallbackFlight: async () => {},
      onSessionReset: () => {
        handle.onFlightCreated([original]);
      },
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });
    handle.onFlightCreated([original]);
    const protocol = new SpedProtocolMock();
    const pair = spedPair(protocol, "host");
    const generation = connection.generation;
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.setAttribute("USERNAME", "a:b").setAttribute("PRIORITY", 1);
    request.appendRawAttribute(DTLS_IN_STUN_DATA, original);

    // Act: inject 待ちのまま restart し、古い ServerHello 相当を carrier から載せる
    const pending = handle.runtime.handleAuthenticatedStun(
      request,
      ["9.9.9.9", 9],
      generation,
      pair,
    );
    await new Promise((r) => setTimeout(r, 10));
    await connection.restart();
    handle.onFlightCreated([stale], { fromCarrier: true });
    release();
    await pending;

    // Assert: 新 generation の L1 は reseed した original のまま
    expect(handle.session.generation).toBe(connection.generation);
    expect(handle.session.l1Datagrams[0]!.equals(original)).toBe(true);
    expect(
      handle.session.l1Datagrams.some((packet) => packet.equals(stale)),
    ).toBe(false);
  });

  it("ICE restart は前 generation の RTT sample を捨てる", async () => {
    // Arrange: generation 0 の path RTT を carrier 相当へ渡す
    const connection = createTestConnection(true);
    let rttMs: number | undefined;
    const handle = attachSpedToConnection(connection, {
      inject: async () => {},
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: (ms) => {
        rttMs = ms;
      },
      resetRtt: () => {
        rttMs = undefined;
      },
      setMtu: () => {},
    });
    const protocol = new SpedProtocolMock() as any;
    const pair = new CandidatePair(
      protocol,
      new Candidate("f", 1, "udp", 1, "1.2.3.4", 1, "host"),
      true,
    );
    pair.rtt = 0.05;
    handle.runtime.syncRtt(pair);
    expect(rttMs).toBe(50);

    // Act
    await connection.restart();

    // Assert: 旧 path の 50ms は残らず、新 pair の sample で上書きできる
    expect(rttMs).toBeUndefined();
    const next = new CandidatePair(
      protocol,
      new Candidate("g", 1, "udp", 1, "1.2.3.5", 1, "host"),
      true,
    );
    next.rtt = 0.08;
    handle.runtime.syncRtt(next);
    expect(rttMs).toBe(80);
  });

  it("handshake 完了後の reset は SPED を complete にする", async () => {
    // Arrange
    const connection = createTestConnection(true);
    let mode: "internal" | "external" = "external";
    const handle = attachSpedToConnection(connection, {
      inject: async () => {},
      onFallbackFlight: async () => {},
      onSessionReset: () => {
        handle.runtime.completeHandshake();
      },
      setRetransmissionMode: (next) => {
        mode = next;
      },
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });
    handle.onFlightCreated([Buffer.from([22, 9])]);
    handle.onHandshakeComplete();
    expect(handle.session.state).toBe("complete");

    // Act: DTLS connected 相当。completeHandshake が probing 埋め込みを止める
    await connection.restart();

    // Assert
    expect(handle.session.state).toBe("complete");
    expect(handle.session.embedding).toBe(false);
    expect(handle.session.hasL1).toBe(false);
    expect(mode).toBe("internal");
  });

  it("ICE-Lite は flight 生成でも Binding Request を送らない", async () => {
    // Arrange
    const connection = createTestConnection(false, { iceLite: true });
    connection.remoteUsername = "remote";
    connection.remotePassword = "remotepw";
    const protocol = new SpedProtocolMock();
    let requests = 0;
    protocol.request = async () => {
      requests++;
      return [new Message(methods.BINDING, classes.RESPONSE), ["9.9.9.9", 9]];
    };
    (connection as any).ensureProtocol(protocol);
    const handle = attachSpedToConnection(connection, {
      inject: async () => {},
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });

    // Act
    handle.onFlightCreated([Buffer.from([22, 1, 2])]);
    await new Promise((r) => setTimeout(r, 20));

    // Assert
    expect(requests).toBe(0);
    expect(handle.session.hasL1).toBe(true);
  });

  it("carry の timeout は自己再実行しない", async () => {
    // Arrange
    const connection = createTestConnection(true);
    connection.remoteUsername = "remote";
    connection.remotePassword = "remotepw";
    const protocol = new SpedProtocolMock();
    let requests = 0;
    protocol.request = async () => {
      requests++;
      throw new TransactionTimeout();
    };
    (connection as any).ensureProtocol(protocol);
    const pair = new CandidatePair(
      protocol,
      new Candidate("r", 1, "udp", 1, "9.9.9.9", 9, "host"),
      true,
    );
    pair.updateState(CandidatePairState.SUCCEEDED);
    connection.checkList.push(pair);
    (connection as any).nominated = pair;
    const handle = attachSpedToConnection(connection, {
      inject: async () => {},
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });

    // Act
    handle.onFlightCreated([Buffer.from([22, 1, 2, 3])]);
    await new Promise((r) => setTimeout(r, 50));

    // Assert: timeout 1 回で止まり、L1 は consent / check に残す
    expect(requests).toBe(1);
    expect(handle.session.hasL1).toBe(true);
  });

  it("inbound Binding 中に L1 が増えても処理後に carry する", async () => {
    // Arrange: 認証済み Request の inject で server flight 相当の L1 を載せる
    const connection = createTestConnection(true);
    connection.remoteUsername = "remote";
    connection.remotePassword = "remotepw";
    const protocol = new SpedProtocolMock();
    const requests: Message[] = [];
    protocol.request = async (message: Message) => {
      requests.push(message);
      const response = new Message(methods.BINDING, classes.RESPONSE);
      const data = getRawAttributeValue(message, DTLS_IN_STUN_DATA);
      if (data && data.length > 0) {
        response.appendRawAttribute(
          DTLS_IN_STUN_ACK,
          encodeSpedAck([spedDataCrc32(data)]).value,
        );
      }
      return [response, ["9.9.9.9", 9]];
    };
    (connection as any).ensureProtocol(protocol);
    const pair = new CandidatePair(
      protocol,
      new Candidate("r", 1, "udp", 1, "9.9.9.9", 9, "host"),
      true,
    );
    pair.updateState(CandidatePairState.SUCCEEDED);
    connection.checkList.push(pair);
    (connection as any).nominated = pair;
    const handle = attachSpedToConnection(connection, {
      inject: async () => {
        handle.onFlightCreated([
          Buffer.from([22, 1, 2, 3]),
          Buffer.from([22, 4, 5, 6]),
        ]);
      },
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });
    const request = new Message(methods.BINDING, classes.REQUEST);
    request
      .setAttribute("USERNAME", `${connection.localUsername}:remote`)
      .setAttribute("PRIORITY", 1)
      .setAttribute("ICE-CONTROLLED", 1n)
      .appendRawAttribute(DTLS_IN_STUN_DATA, Buffer.from([22, 9, 8, 7]))
      .addMessageIntegrity(Buffer.from(connection.localPassword))
      .addFingerprint();

    // Act: 受信処理中の flush はキューし、抜けたあと残 L1 を Binding で送る
    await (connection as any).handleBindingRequest(
      protocol,
      request,
      ["9.9.9.9", 9],
      request.bytes,
    );
    await new Promise((r) => setTimeout(r, 20));

    // Assert: inbound 中に捨てず、Response 後に残 L1 を Binding で送る
    expect(protocol.sentMessage).toBeDefined();
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.some((message) => {
        const data = getRawAttributeValue(message, DTLS_IN_STUN_DATA);
        return data != null && data.length > 0;
      }),
    ).toBe(true);
  });

  it("受信 DATA のあとローカル L1 が空でも peer 用 Binding を 1 本出す", async () => {
    // Arrange: Full 側は CH を送り済みで L1 が空。Lite の残り L1 を引き出す
    const connection = createTestConnection(true);
    connection.remoteUsername = "remote";
    connection.remotePassword = "remotepw";
    const protocol = new SpedProtocolMock();
    const requests: Message[] = [];
    protocol.request = async (message: Message) => {
      requests.push(message);
      return [new Message(methods.BINDING, classes.RESPONSE), ["9.9.9.9", 9]];
    };
    (connection as any).ensureProtocol(protocol);
    const pair = new CandidatePair(
      protocol,
      new Candidate("r", 1, "udp", 1, "9.9.9.9", 9, "host"),
      true,
    );
    pair.updateState(CandidatePairState.SUCCEEDED);
    connection.checkList.push(pair);
    (connection as any).nominated = pair;
    const handle = attachSpedToConnection(connection, {
      inject: async () => {},
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: () => {},
    });
    handle.session.noteAuthenticatedBindingHasData(true);
    const response = new Message(methods.BINDING, classes.RESPONSE);
    response.appendRawAttribute(DTLS_IN_STUN_DATA, Buffer.from([22, 1, 2, 3]));

    // Act: 空 L1 でも DATA 受信をきっかけに Binding を 1 本送る
    await (connection as any).consumeSpedStun(
      response,
      ["9.9.9.9", 9],
      protocol,
      pair,
      connection.generation,
    );
    await new Promise((r) => setTimeout(r, 20));

    // Assert: Lite が次の L1 を Response に載せられる
    expect(requests).toHaveLength(1);
    expect(handle.session.hasL1).toBe(false);
  });
});

describe("SPED abort", () => {
  function hooks() {
    const calls = { reset: 0, abort: 0 };
    return {
      calls,
      hooks: {
        inject: async () => {},
        onFallbackFlight: async () => {},
        onSessionReset: () => {
          calls.reset++;
        },
        onSessionAbort: () => {
          calls.abort++;
        },
        setRetransmissionMode: () => {},
        updateRtt: () => {},
        resetRtt: () => {},
        setMtu: () => {},
      },
    };
  }

  it("ICE failed は session を disabled にし decorate しない", async () => {
    // Arrange
    const connection = createTestConnection(true);
    const { calls, hooks: spedHooks } = hooks();
    const handle = attachSpedToConnection(connection, spedHooks);
    handle.onFlightCreated([Buffer.from([22, 1, 2])]);
    const protocol = new SpedProtocolMock();
    (connection as any).ensureProtocol(protocol);
    const pair = spedPair(protocol, "host");
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.setAttribute("USERNAME", "a:b").setAttribute("PRIORITY", 1);

    // Act: failed は pending L1 を捨て embedding を止める
    (connection as any).setState("failed");
    expect(handle.runtime.decorateOutgoing(request, pair)).toBe(true);

    // Assert
    expect(handle.session.state).toBe("disabled");
    expect(handle.session.embedding).toBe(false);
    expect(handle.session.hasL1).toBe(false);
    expect(getRawAttributeValue(request, DTLS_IN_STUN_DATA)).toBeUndefined();
    expect(calls.abort).toBe(1);
    expect(calls.reset).toBe(0);
  });

  it("Connection.close は abort する", async () => {
    // Arrange
    const connection = createTestConnection(true);
    const { calls, hooks: spedHooks } = hooks();
    const handle = attachSpedToConnection(connection, spedHooks);
    handle.onFlightCreated([Buffer.from([22, 4])]);

    // Act
    await connection.close();

    // Assert
    expect(handle.session.state).toBe("disabled");
    expect(handle.session.embedding).toBe(false);
    expect(handle.session.hasL1).toBe(false);
    expect(calls.abort).toBeGreaterThanOrEqual(1);
    expect(calls.reset).toBe(0);
  });

  it("abort 後の ICE restart は probing に戻る", async () => {
    // Arrange
    const connection = createTestConnection(true);
    const handle = attachSpedToConnection(connection, hooks().hooks);
    handle.onFlightCreated([Buffer.from([22, 4])]);
    (connection as any).setState("failed");
    expect(handle.session.embedding).toBe(false);

    // Act
    await connection.restart();
    handle.session.replaceL1([Buffer.from([22, 5])]);

    // Assert
    expect(handle.session.state).toBe("probing");
    expect(handle.session.embedding).toBe(true);
    expect(handle.session.hasL1).toBe(true);
  });

  it("connect 失敗は Connection を failed にし SPED を abort する", async () => {
    // Arrange: gather 済みだが pair が無く ICE が成立しない
    const connection = createTestConnection(true);
    const { calls, hooks: spedHooks } = hooks();
    const handle = attachSpedToConnection(connection, spedHooks);
    handle.onFlightCreated([Buffer.from([22, 1])]);
    connection.localCandidatesEnd = true;
    connection.remoteCandidates = [];
    connection.remoteUsername = "foo";
    connection.remotePassword = "bar";

    // Act
    await expect(connection.connect()).rejects.toThrow(
      "ICE negotiation failed",
    );

    // Assert: Connection 自身が failed になり carrier/session を abort する
    expect(connection.state).toBe("failed");
    expect(handle.session.state).toBe("disabled");
    expect(handle.session.embedding).toBe(false);
    expect(calls.abort).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it("TCP connectivity check は接続確立を含む responseTimeout を使う", async () => {
    // Arrange: TCP は再送せず、50ms UDP RTO では connect が間に合わない
    const connection = createTestConnection(true);
    connection.remoteUsername = "remote";
    connection.remotePassword = "remotepw";
    const pair = tcpSpedPair({ localType: "active", remoteType: "passive" });
    let captured: { retransmissions?: number; responseTimeout?: number } = {};
    pair.protocol.request = async (_msg, _addr, _key, options) => {
      if (options && typeof options === "object") {
        captured = options;
      }
      throw new TransactionTimeout();
    };

    // Act
    await connection.checkStart(pair).awaitable;

    // Assert
    expect(captured.retransmissions).toBe(0);
    expect(captured.responseTimeout).toBeGreaterThan(50);
  });
});
