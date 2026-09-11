import { CandidatePairState } from "../../src";
import { DTLS_IN_STUN_DATA } from "../../src/sped/draft00/constants";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { createTestConnection } from "../utils";
import { SpedProtocolMock, attachTestSped, spedPair } from "./helpers";

function bindingResponse(data?: Buffer) {
  const response = new Message(methods.BINDING, classes.RESPONSE);
  if (data) {
    response.appendRawAttribute(DTLS_IN_STUN_DATA, data);
  }
  return response;
}

function incomingCheck(
  connection: ReturnType<typeof createTestConnection>,
  options: { useCandidate: boolean },
) {
  const request = new Message(methods.BINDING, classes.REQUEST);
  request
    .setAttribute("USERNAME", `${connection.localUsername}:remote`)
    .setAttribute("PRIORITY", 1)
    .setAttribute("ICE-CONTROLLING", 1n);
  if (options.useCandidate) {
    request.setAttribute("USE-CANDIDATE", null);
  }
  return request;
}

function arrangeFullCheck(options?: { remoteType?: string }) {
  const connection = createTestConnection(true);
  connection.remoteUsername = "remote";
  connection.remotePassword = "remotepw";
  const protocol = new SpedProtocolMock();
  (connection as any).ensureProtocol(protocol);
  const pair = spedPair(protocol, options?.remoteType ?? "host");
  pair.updateState(CandidatePairState.WAITING);
  connection.checkList.push(pair);
  return { connection, protocol, pair };
}

function arrangeLiteCheck() {
  const connection = createTestConnection(false, { iceLite: true });
  connection.remoteUsername = "remote";
  connection.remotePassword = "remotepw";
  const protocol = new SpedProtocolMock();
  (connection as any).ensureProtocol(protocol);
  const pair = spedPair(protocol, "host");
  pair.iceControlling = false;
  pair.updateState(CandidatePairState.WAITING);
  connection.remoteCandidates = [pair.remoteCandidate];
  connection.checkList.push(pair);
  return { connection, protocol, pair };
}

describe("SPED hybrid direct-handshake readiness", () => {
  it("Full は source-symmetric な最初の authenticated Response のあとだけ ready になる", async () => {
    // Arrange
    const { connection, protocol, pair } = arrangeFullCheck();
    const modes: string[] = [];
    const readyEvents: boolean[] = [];
    let readyWhenInjected: boolean | undefined;
    const handle = attachTestSped(connection, {
      inject: async () => {
        readyWhenInjected = handle.runtime.isHandshakeDirectReady();
      },
      onDirectHandshakeReady: (readiness) => {
        readyEvents.push(readiness.ready);
      },
      setRetransmissionMode: (mode) => {
        modes.push(mode);
      },
    });
    protocol.request = async () => [
      bindingResponse(Buffer.from([22, 1, 2, 3])),
      ["9.9.9.9", 9],
    ];

    // Act: 最初の successful Binding Response を処理する
    await (connection as any).checkStart(pair).awaitable;

    // Assert: source symmetry のあとに ready し、inject より前に通知する
    expect(handle.runtime.isHandshakeDirectReady()).toBe(true);
    expect(readyWhenInjected).toBe(true);
    expect(readyEvents).toEqual([true]);
    expect(modes.at(-1)).toBe("internal");
    expect(pair.responsesReceived).toBeGreaterThan(0);
  });

  it("Response の source が pair.remoteAddr と違うと inject も ready もしない", async () => {
    // Arrange
    const { connection, protocol, pair } = arrangeFullCheck();
    let injected = 0;
    const handle = attachTestSped(connection, {
      inject: async () => {
        injected++;
      },
    });
    protocol.request = async () => [
      bindingResponse(Buffer.from([22, 1, 2, 3])),
      ["8.8.8.8", 8],
    ];

    // Act: RFC 8445 §7.2.5.2.1 の source mismatch を返す
    await (connection as any).checkStart(pair).awaitable;

    // Assert: symmetry 前に SPED DATA も direct も開かない
    expect(handle.runtime.isHandshakeDirectReady()).toBe(false);
    expect(injected).toBe(0);
    expect(pair.state).toBe(CandidatePairState.FAILED);
  });

  it("stale generation の Response では ready にしない", async () => {
    // Arrange: checkStart が応答待ちのまま restart する
    const { connection, protocol, pair } = arrangeFullCheck();
    const handle = attachTestSped(connection);
    let release!: (value: [Message, [string, number]]) => void;
    protocol.request = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = (connection as any).checkStart(pair);

    // Act: 旧 generation の成功応答を restart 後に渡す
    await new Promise((r) => setTimeout(r, 10));
    await connection.restart();
    release([bindingResponse(Buffer.from([22, 4])), ["9.9.9.9", 9]]);
    await pending.awaitable;

    // Assert: 新 generation の carrier は開かない
    expect(handle.runtime.isHandshakeDirectReady()).toBe(false);
    expect(handle.session.generation).toBe(connection.generation);
  });

  it("未認証 pair と relay pair は tryMark を拒否する", () => {
    // Arrange
    const connection = createTestConnection(true);
    const handle = attachTestSped(connection);
    const protocol = new SpedProtocolMock();
    const waiting = spedPair(protocol, "host");
    const relay = spedPair(protocol, "relay");
    relay.responsesReceived = 1;
    relay.updateState(CandidatePairState.SUCCEEDED);

    // Act
    const waitingMarked = handle.runtime.tryMarkDirectHandshakeReady(
      waiting,
      connection.generation,
    );
    const relayMarked = handle.runtime.tryMarkDirectHandshakeReady(
      relay,
      connection.generation,
    );

    // Assert
    expect(waitingMarked).toBe(false);
    expect(relayMarked).toBe(false);
    expect(handle.runtime.isHandshakeDirectReady()).toBe(false);
  });

  it("ICE-Lite は USE-CANDIDATE 受理後だけ ready になり Binding Request を出さない", async () => {
    // Arrange
    const { connection, protocol, pair } = arrangeLiteCheck();
    let requests = 0;
    protocol.request = async () => {
      requests++;
      return [bindingResponse(), ["9.9.9.9", 9]];
    };
    const handle = attachTestSped(connection);
    handle.onFlightCreated([Buffer.from([22, 1, 2])]);

    // Act: USE-CANDIDATE 無しの check を先に受ける
    connection.checkIncoming(
      incomingCheck(connection, { useCandidate: false }),
      ["9.9.9.9", 9],
      protocol,
    );

    // Assert: 最初の check だけでは Lite は direct しない
    expect(handle.runtime.isHandshakeDirectReady()).toBe(false);
    expect(pair.nominated).toBe(false);
    expect(pair.requestsSent).toBe(0);
    expect(requests).toBe(0);

    // Act: 認証済み USE-CANDIDATE を受理する
    connection.checkIncoming(
      incomingCheck(connection, { useCandidate: true }),
      ["9.9.9.9", 9],
      protocol,
    );

    // Assert: nominated 後だけ ready。Lite は Request を生成しない
    expect(pair.nominated).toBe(true);
    expect(pair.state).toBe(CandidatePairState.SUCCEEDED);
    expect(handle.runtime.isHandshakeDirectReady()).toBe(true);
    expect(pair.requestsSent).toBe(0);
    expect(requests).toBe(0);
    expect(handle.runtime.diagnosticsSnapshot()).toMatchObject({
      carrier: "direct",
    });
  });

  it("handshake 中の ICE restart は direct-ready を破棄して external に戻す", async () => {
    // Arrange
    const connection = createTestConnection(true);
    const modes: string[] = [];
    const handle = attachTestSped(connection, {
      setRetransmissionMode: (mode) => {
        modes.push(mode);
      },
    });
    const protocol = new SpedProtocolMock();
    const pair = spedPair(protocol, "host");
    pair.responsesReceived = 1;
    pair.updateState(CandidatePairState.SUCCEEDED);
    expect(
      handle.runtime.tryMarkDirectHandshakeReady(pair, connection.generation),
    ).toBe(true);

    // Act
    await connection.restart();

    // Assert: 新 generation は valid pair 前の probing / external から再開する
    expect(handle.runtime.isHandshakeDirectReady()).toBe(false);
    expect(handle.session.state).toBe("probing");
    expect(modes.at(-1)).toBe("external");
  });

  it("SPED 対応 peer の hybrid complete は fallback にせず carrier を direct のままにする", () => {
    // Arrange
    const connection = createTestConnection(true);
    const handle = attachTestSped(connection);
    const protocol = new SpedProtocolMock();
    const pair = spedPair(protocol, "host");
    pair.responsesReceived = 1;
    pair.updateState(CandidatePairState.SUCCEEDED);
    handle.runtime.tryMarkDirectHandshakeReady(pair, connection.generation);
    handle.session.noteAuthenticatedBindingHasData(true);

    // Act
    handle.runtime.completeHandshake();

    // Assert: non-SPED fallback と混同せず active/direct を公開する
    expect(handle.runtime.fallbackStarted).toBe(false);
    expect(handle.runtime.diagnosticsSnapshot()).toEqual({
      state: "active",
      carrier: "direct",
      retransmissions: 0,
      generation: connection.generation,
    });
  });
});
