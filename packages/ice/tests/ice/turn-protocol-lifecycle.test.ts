import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const debugState = vi.hoisted(() => {
  const log = vi.fn();
  const debug = vi.fn(() => log);
  return { debug, log };
});

vi.mock("debug", () => ({
  default: { debug: debugState.debug },
}));

vi.mock("timers/promises", () => ({
  setTimeout: (
    delay: number,
    value?: unknown,
    options?: { signal?: AbortSignal },
  ) =>
    new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        options?.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      }, delay);
      const onAbort = () => {
        globalThis.clearTimeout(timer);
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
    }),
}));

import type { Address, Transport } from "../../../common/src";
import { TransactionFailed } from "../../src/exceptions";
import { classes, methods } from "../../src/stun/const";
import { Message, parseMessage } from "../../src/stun/message";
import { TurnProtocol } from "../../src/turn/protocol";
import type { TransactionRequestOptions } from "../../src/types/model";

interface TurnLifecycleHarness {
  sentMethods: number[];
  transport: Transport;
  turn: TurnProtocol;
}

function createTurnLifecycleHarness(): TurnLifecycleHarness {
  const sentMethods: number[] = [];
  const transport: Transport = {
    type: "udp",
    closed: false,
    onData: () => {},
    address: { address: "127.0.0.1", port: 0, family: "IPv4" },
    send: async (data) => {
      sentMethods.push(parseMessage(data)!.messageMethod);
    },
    close: async () => {},
  };
  const turn = new TurnProtocol(
    ["127.0.0.1", 3478],
    "user",
    "pass",
    600,
    transport,
  );

  return { sentMethods, transport, turn };
}

function startRefresh(turn: TurnProtocol, lifetime: number) {
  (turn as unknown as { refresh: (exp: number) => void }).refresh(lifetime);
}

function refreshResponse(lifetime: number) {
  return new Message(methods.REFRESH, classes.RESPONSE).setAttribute(
    "LIFETIME",
    lifetime,
  );
}

describe("TurnProtocol refresh lifecycle", () => {
  const turns: TurnProtocol[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    debugState.log.mockClear();
  });

  afterEach(async () => {
    await Promise.all(turns.splice(0).map((turn) => turn.close()));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("refresh sleep 中の close は REFRESH を開始しない", async () => {
    // Arrange: transport が close 後も送信可能な状態を維持する protocol を作る
    const { sentMethods, transport, turn } = createTurnLifecycleHarness();
    turns.push(turn);
    const requestWithRetry = vi.spyOn(turn, "requestWithRetry");
    startRefresh(turn, 0.12);
    expect(vi.getTimerCount()).toBe(1);

    // Act: refresh delay の途中で close し、元の満了時刻より先まで進める
    await turn.close();
    await vi.advanceTimersByTimeAsync(1_000);

    // Assert: transport.closed に頼らず request、packet、timer が全て残らない
    expect(transport.closed).toBe(false);
    expect(requestWithRetry).not.toHaveBeenCalled();
    expect(sentMethods).not.toContain(methods.REFRESH);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("実行中の REFRESH transaction を close が即座に停止する", async () => {
    // Arrange: 応答しない transport で refresh transaction を開始する
    const { sentMethods, transport, turn } = createTurnLifecycleHarness();
    turns.push(turn);
    startRefresh(turn, 0.12);
    await vi.advanceTimersByTimeAsync(100);
    expect(
      sentMethods.filter((method) => method === methods.REFRESH),
    ).toHaveLength(1);
    expect(Object.keys(turn.transactions)).toHaveLength(1);

    // Act: retry 待機中に close し、その後も十分に時刻を進める
    await turn.close();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    // Assert: transaction と retry timer が消え、close 後の再送も発生しない
    expect(transport.closed).toBe(false);
    expect(Object.keys(turn.transactions)).toHaveLength(0);
    expect(
      sentMethods.filter((method) => method === methods.REFRESH),
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(debugState.log).not.toHaveBeenCalledWith(
      "refresh error",
      expect.anything(),
    );
  });

  test("response の LIFETIME を次回 refresh delay に採用する", async () => {
    // Arrange: 1 回目の応答で lifetime を 2 倍に更新する
    const { turn } = createTurnLifecycleHarness();
    turns.push(turn);
    const requestWithRetry = vi
      .spyOn(turn, "requestWithRetry")
      .mockResolvedValueOnce([refreshResponse(0.24), turn.server])
      .mockResolvedValue([refreshResponse(0.24), turn.server]);
    startRefresh(turn, 0.12);

    // Act: 初回 100ms と、更新後の次回 200ms の境界まで進める
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(199);

    // Assert: 更新後 lifetime の満了前には 2 回目を開始しない
    expect(requestWithRetry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestWithRetry).toHaveBeenCalledTimes(2);
    expect(requestWithRetry.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  });

  test("一時的な refresh failure の後も loop を継続する", async () => {
    // Arrange: 最初の refresh だけ通常エラーで失敗させる
    const { turn } = createTurnLifecycleHarness();
    turns.push(turn);
    const requestWithRetry = vi
      .spyOn(turn, "requestWithRetry")
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue([refreshResponse(0.12), turn.server]);
    startRefresh(turn, 0.12);

    // Act: 2 回分の refresh delay を進める
    await vi.advanceTimersByTimeAsync(200);

    // Assert: 通常エラーでは lifecycle を終了せず次回 request を行う
    expect(requestWithRetry).toHaveBeenCalledTimes(2);
  });

  test.each([
    {
      errorCode: 401,
      reason: "Unauthorized",
      initialRealm: undefined,
      responseRealm: "test.local",
    },
    {
      errorCode: 438,
      reason: "Stale Nonce",
      initialRealm: "test.local",
      responseRealm: "test.local",
    },
  ])(
    "$errorCode nonce retry の両 request に同じ AbortSignal を渡す",
    async ({ errorCode, reason, initialRealm, responseRealm }) => {
      // Arrange: 401/438 challenge と nonce 付き retry が成功する protocol を作る
      const { turn } = createTurnLifecycleHarness();
      turns.push(turn);
      turn.realm = initialRealm;
      const challenge = new Message(methods.REFRESH, classes.ERROR)
        .setAttribute("ERROR-CODE", [errorCode, reason])
        .setAttribute("REALM", responseRealm)
        .setAttribute("NONCE", Buffer.from("nonce"));
      const request = new Message(methods.REFRESH, classes.REQUEST);
      const signal = new AbortController().signal;
      const requestSpy = vi
        .spyOn(turn, "request")
        .mockRejectedValueOnce(new TransactionFailed(challenge, turn.server))
        .mockResolvedValueOnce([refreshResponse(600), turn.server]);

      // Act: authentication challenge を処理して同じ request を再試行する
      await turn.requestWithRetry(request, turn.server, signal);

      // Assert: 初回と nonce retry の options に同一 signal が伝播する
      expect(requestSpy).toHaveBeenCalledTimes(2);
      const firstOptions = requestSpy.mock.calls[0]?.[3] as
        | TransactionRequestOptions
        | undefined;
      const retryOptions = requestSpy.mock.calls[1]?.[3] as
        | TransactionRequestOptions
        | undefined;
      expect(firstOptions?.signal).toBe(signal);
      expect(retryOptions?.signal).toBe(signal);
    },
  );
});
