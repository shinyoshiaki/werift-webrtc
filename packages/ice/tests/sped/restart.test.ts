import { CandidatePair, CandidatePairState } from "../../src";
import { Candidate } from "../../src/candidate";
import { TransactionTimeout } from "../../src/exceptions";
import { attachSpedToConnection } from "../../src/internal/sped";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { createTestConnection } from "../utils";
import { SpedProtocolMock } from "./helpers";

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
      setMtu: () => {},
    });

    // Act
    handle.onFlightCreated([Buffer.from([22, 1, 2, 3])]);
    await new Promise((r) => setTimeout(r, 50));

    // Assert: timeout 1 回で止まり、L1 は consent / check に残す
    expect(requests).toBe(1);
    expect(handle.session.hasL1).toBe(true);
  });
});
