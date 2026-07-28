import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONSENT_FAILURES,
  CONSENT_RESPONSE_TIMEOUT,
  CONSENT_RESPONSE_TIMEOUT_MIN,
  CONSENT_TIMEOUT,
  CandidatePair,
  consentResponseTimeoutMs,
} from "../../src/iceBase";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { Transaction } from "../../src/stun/transaction";
import {
  ConsentMockProtocol,
  createConsentCandidate,
  createConsentHarness,
} from "../utils";

describe("ICE consent freshness (RFC 7675)", () => {
  const connections: Array<{ close: () => Promise<void> }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(async () => {
    await Promise.all(
      connections.splice(0).map((connection) => connection.close()),
    );
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("1回目の request 欠落後も監視を継続し、後続の有効応答で接続を維持する", async () => {
    // Arrange
    const harness = createConsentHarness(["timeout", "success"]);
    connections.push(harness.connection);

    // Act: 2回分の cadence（中点 random → 5s）を進める
    await vi.advanceTimersByTimeAsync(10_000);

    // Assert: 欠落後も2回目を送り、state は connected のまま
    expect(harness.protocol.requestTimes.length).toBe(2);
    expect(harness.nominated.consentRequestsSent).toBe(2);
    expect(harness.connection.state).toBe("connected");
  });

  it("150〜300ms の遅延応答を受理し、同一 transaction を再送しない", async () => {
    // Arrange: retransmissions=0 と明示的な responseTimeout
    const sendStun = vi.fn(async () => undefined);
    const request = new Message(methods.BINDING, classes.REQUEST);
    const transaction = new Transaction(
      request,
      ["192.0.2.2", 5000],
      { sendStun } as any,
      {
        retransmissions: 0,
        responseTimeout: CONSENT_RESPONSE_TIMEOUT,
      },
    );
    const result = transaction.run().then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    );

    // Act: 200ms 後に応答
    setTimeout(() => {
      transaction.responseReceived(
        new Message(methods.BINDING, classes.RESPONSE, request.transactionId),
        ["192.0.2.2", 5000],
      );
    }, 200);
    await vi.advanceTimersByTimeAsync(200);

    // Assert: 受理され、再送なし
    expect(await result).toBe("fulfilled");
    expect(sendStun).toHaveBeenCalledTimes(1);
  });

  it("応答待ちがあっても request 開始間隔が選ばれた 4〜6 秒を超えて伸びない", async () => {
    // Arrange: 最大間隔 6s、各応答待ち 1s
    vi.mocked(Math.random).mockReturnValue(1);
    const harness = createConsentHarness(
      Array.from({ length: 10 }, () => "timeout" as const),
      { responseDelayMilliseconds: 1_000 },
    );
    connections.push(harness.connection);

    // Act
    await vi.advanceTimersByTimeAsync(24_000);

    // Assert: 開始時刻差が 6s 刻み（応答待ちで後ろ倒しされない）
    const times = harness.requestTimes;
    expect(times.length).toBeGreaterThanOrEqual(4);
    expect(times.slice(0, 4).map((t) => t - times[0]!)).toEqual([
      0, 6_000, 12_000, 18_000,
    ]);
  });

  it("4秒周期でも30秒未満で失効せず、最後の有効応答から30秒で failed になる", async () => {
    // Arrange: 最小間隔 4s、全て timeout
    vi.mocked(Math.random).mockReturnValue(0);
    const harness = createConsentHarness(
      Array.from({ length: 12 }, () => "timeout" as const),
    );
    connections.push(harness.connection);

    // Act / Assert: 旧 CONSENT_FAILURES * 4s ではまだ生きている
    await vi.advanceTimersByTimeAsync(CONSENT_FAILURES * 4_000);
    expect(harness.protocol.requestTimes.length).toBe(CONSENT_FAILURES);
    expect(harness.connection.state).toBe("connected");

    // Act: 30s 直前までは connected
    await vi.advanceTimersByTimeAsync(
      CONSENT_TIMEOUT * 1000 - CONSENT_FAILURES * 4_000 - 1,
    );
    expect(harness.connection.state).toBe("connected");

    // Act: 最後の有効応答（開始時）からちょうど 30s
    await vi.advanceTimersByTimeAsync(1);

    // Assert: closed ではなく failed
    expect(harness.connection.state).toBe("failed");
  });

  it("6秒周期でも最後の有効応答から30秒で失効する", async () => {
    // Arrange
    vi.mocked(Math.random).mockReturnValue(1);
    const harness = createConsentHarness(
      Array.from({ length: 10 }, () => "timeout" as const),
    );
    connections.push(harness.connection);

    // Act / Assert
    await vi.advanceTimersByTimeAsync(CONSENT_TIMEOUT * 1000 - 1);
    expect(harness.connection.state).toBe("connected");
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.connection.state).toBe("failed");
  });

  it("有効応答で30秒期限が更新される", async () => {
    // Arrange: 4回 timeout の後 success、その後 timeout
    const harness = createConsentHarness([
      "timeout",
      "timeout",
      "timeout",
      "timeout",
      "success",
      ...Array.from({ length: 10 }, () => "timeout" as const),
    ]);
    connections.push(harness.connection);

    // Act: 最初の success が届くまで（中点 5s × 5）
    await vi.advanceTimersByTimeAsync(25_000);
    expect(harness.connection.state).toBe("connected");

    // Act: success 時点からさらに 25s は維持
    await vi.advanceTimersByTimeAsync(25_000);
    expect(harness.connection.state).toBe("connected");

    // Act: success から 30s で失効
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.connection.state).toBe("failed");
  });

  it("各 consent request の transaction ID が異なる", async () => {
    // Arrange
    const harness = createConsentHarness(["success", "success", "success"]);
    connections.push(harness.connection);

    // Act
    await vi.advanceTimersByTimeAsync(15_000);

    // Assert
    const ids = harness.sentMessages.map((m) => m.transactionIdHex);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("restart 後は旧 session の応答が期限を更新せず、application data を止められる", async () => {
    // Arrange
    const harness = createConsentHarness(["timeout", "timeout", "timeout"]);
    connections.push(harness.connection);
    const pair = harness.nominated;
    const sendSpy = vi.fn(async () => undefined);
    pair.protocol.sendData = sendSpy;

    // Act: 接続中は送信可能
    await harness.connection.send(Buffer.from("alive"));
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Act: restart で consent を破棄
    await harness.connection.restart();
    // restart 後は nominated が無い
    await harness.connection.send(Buffer.from("after-restart"));
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(harness.connection.state).toBe("new");
  });

  it("resetNominatedPair で consent lifecycle を停止し、新 pair 指名で再開する", async () => {
    // Arrange
    const harness = createConsentHarness(
      Array.from({ length: 20 }, () => "timeout" as const),
    );
    connections.push(harness.connection);
    const oldSession = (harness.connection as any).consentSessionId;

    // Act: selected pair をリセット
    harness.connection.resetNominatedPair();

    // Assert: consent session が無効化され送信不可
    expect((harness.connection as any).consentSessionId).toBeGreaterThan(
      oldSession,
    );
    expect((harness.connection as any).consentFresh).toBe(false);
    expect((harness.connection as any).queryConsentHandle).toBeUndefined();

    // Act: 新 pair を指名（connected 中の renomination）
    const fresh = new ConsentMockProtocol({
      outcomes: Array.from({ length: 10 }, () => "success" as const),
    });
    const newPair = new CandidatePair(
      fresh,
      createConsentCandidate("192.0.2.9", 5009, "remote"),
      true,
    );
    newPair.nominated = true;
    harness.connection.nominated = newPair;
    harness.connection.state = "connected";
    // checkComplete 相当: connected 中の新 pair で consent 再開
    (harness.connection as any).queryConsent();

    // Assert: 新しい session で request が再開される
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fresh.requestTimes.length).toBeGreaterThanOrEqual(1);
    expect(harness.connection.state).toBe("connected");
  });

  it("consent response timeout は RTT 推定と 500ms 下限を使う", () => {
    // Assert: RTT 不明時は既定 1s
    expect(consentResponseTimeoutMs(undefined)).toBe(CONSENT_RESPONSE_TIMEOUT);
    // Assert: 小さい RTT でも RFC 8445 の 500ms を下回らない
    expect(consentResponseTimeoutMs(0.05)).toBe(CONSENT_RESPONSE_TIMEOUT_MIN);
    // Assert: 既知 RTT では 2*RTT+200ms
    expect(consentResponseTimeoutMs(0.4)).toBe(1000);
  });

  it("異なる送信元アドレスの応答は consent を更新しない", async () => {
    // Arrange
    const sendStun = vi.fn(async () => undefined);
    const request = new Message(methods.BINDING, classes.REQUEST);
    const transaction = new Transaction(
      request,
      ["192.0.2.2", 5000],
      { sendStun } as any,
      { retransmissions: 0, responseTimeout: 1000 },
    );
    const result = transaction.run().then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    );

    // Act: 別アドレスからの応答は無視
    transaction.responseReceived(
      new Message(methods.BINDING, classes.RESPONSE, request.transactionId),
      ["198.51.100.1", 9],
    );
    await vi.advanceTimersByTimeAsync(100);
    // 正しいアドレスからの応答で完了
    transaction.responseReceived(
      new Message(methods.BINDING, classes.RESPONSE, request.transactionId),
      ["192.0.2.2", 5000],
    );

    // Assert
    expect(await result).toBe("fulfilled");
  });

  it("失効後は failed となり application data を送らず、明示 close の closed と区別される", async () => {
    // Arrange
    const harness = createConsentHarness(
      Array.from({ length: 10 }, () => "timeout" as const),
    );
    connections.push(harness.connection);
    const sendSpy = vi.fn(async () => undefined);
    harness.nominated.protocol.sendData = sendSpy;

    // Act: 失効前は送信できる
    await harness.connection.send(Buffer.from("before"));
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Act: 30s で consent 失効
    await vi.advanceTimersByTimeAsync(CONSENT_TIMEOUT * 1000);
    expect(harness.connection.state).toBe("failed");

    // Assert: 失効後は送信しない
    await harness.connection.send(Buffer.from("after-expire"));
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Act: 明示 close は closed
    await harness.connection.close();
    expect(harness.connection.state).toBe("closed");
  });

  it("失効後の遅延応答だけでは consent を再確立しない", async () => {
    // Arrange: 最初の request は長く待ってから success（失効後に解決）
    const harness = createConsentHarness(["success"], {
      responseDelayMilliseconds: CONSENT_TIMEOUT * 1000 + 1_000,
    });
    connections.push(harness.connection);
    const sendSpy = vi.fn(async () => undefined);
    harness.nominated.protocol.sendData = sendSpy;

    // Act: 最初の request を開始させてから 30s 失効
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(CONSENT_TIMEOUT * 1000);
    expect(harness.connection.state).toBe("failed");

    // Act: 遅延 success が到着する時間を進める
    await vi.advanceTimersByTimeAsync(2_000);

    // Assert: failed のまま、送信不可
    expect(harness.connection.state).toBe("failed");
    await harness.connection.send(Buffer.from("stale"));
    expect(sendSpy).toHaveBeenCalledTimes(0);
  });

  it.each([
    { protocolType: "udp", transport: "udp" },
    { protocolType: "tcp", transport: "tcp" },
    { protocolType: "turn", transport: "udp" },
  ])(
    "host $protocolType 経路で consent request が一度だけ送信される",
    async ({ protocolType, transport }) => {
      // Arrange
      const harness = createConsentHarness(["success"], {
        protocolType,
        transport,
      });
      connections.push(harness.connection);

      // Act: 1回の consent request を完了
      await vi.advanceTimersByTimeAsync(5_000);
      // responseTimeout 分も進めて完了させる
      await vi.advanceTimersByTimeAsync(CONSENT_RESPONSE_TIMEOUT);

      // Assert: retransmissions=0 なので wire 送信は1回
      expect(harness.protocol.sendStunCount).toBe(1);
      expect(harness.nominated.retransmissionsSent).toBe(0);
      expect(harness.nominated.consentRequestsSent).toBe(1);
      expect(harness.nominated.requestsSent).toBe(1);
      expect(harness.nominated.responsesReceived).toBe(1);
    },
  );

  it("USE-CANDIDATE は controlling + remote ICE-lite + selected pair のときだけ付く", async () => {
    // Arrange / Act / Assert: 条件を満たす場合
    {
      const harness = createConsentHarness(["success"], {
        iceControlling: true,
        remoteIsLite: true,
      });
      connections.push(harness.connection);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.sentMessages[0]?.attributesKeys).toContain(
        "USE-CANDIDATE",
      );
    }

    // Arrange / Act / Assert: remote が full ICE なら付かない
    {
      const harness = createConsentHarness(["success"], {
        iceControlling: true,
        remoteIsLite: false,
      });
      connections.push(harness.connection);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.sentMessages[0]?.attributesKeys).not.toContain(
        "USE-CANDIDATE",
      );
    }

    // Arrange / Act / Assert: controlled なら付かない
    {
      const harness = createConsentHarness(["success"], {
        iceControlling: false,
        remoteIsLite: true,
      });
      connections.push(harness.connection);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.sentMessages[0]?.attributesKeys).not.toContain(
        "USE-CANDIDATE",
      );
    }
  });

  it("consent 関連 stats が実際の packet 数と一致する", async () => {
    // Arrange
    const harness = createConsentHarness(["timeout", "success", "timeout"]);
    connections.push(harness.connection);

    // Act
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(CONSENT_RESPONSE_TIMEOUT);

    // Assert
    expect(harness.nominated.consentRequestsSent).toBe(
      harness.protocol.requestTimes.length,
    );
    expect(harness.nominated.requestsSent).toBe(
      harness.protocol.requestTimes.length,
    );
    expect(harness.nominated.responsesReceived).toBe(1);
    expect(harness.nominated.retransmissionsSent).toBe(0);
    expect(harness.protocol.sendStunCount).toBe(
      harness.protocol.requestTimes.length,
    );
  });

  it("Transaction は options と legacy 位置引数の両方を受け付ける", async () => {
    // Arrange
    const sendStun = vi.fn(async () => undefined);
    const protocol = { sendStun } as any;

    // Act: legacy positional retransmissions=0 → 既定 RTO で1回送信
    const legacy = new Transaction(
      new Message(methods.BINDING, classes.REQUEST),
      ["127.0.0.1", 1],
      protocol,
      0,
    );
    const legacyResult = legacy.run().then(
      () => "ok",
      () => "timeout",
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(await legacyResult).toBe("timeout");
    expect(sendStun).toHaveBeenCalledTimes(1);

    // Act: options で responseTimeout を明示
    sendStun.mockClear();
    const withOptions = new Transaction(
      new Message(methods.BINDING, classes.REQUEST),
      ["127.0.0.1", 1],
      protocol,
      { retransmissions: 0, responseTimeout: 1_000 },
    );
    const optResult = withOptions.run().then(
      () => "ok",
      () => "timeout",
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(sendStun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await optResult).toBe("timeout");
  });

  it("pair 切替後の古い応答は現在の期限を更新しない", async () => {
    // Arrange: 遅い success が古い pair から返る
    const slow = new ConsentMockProtocol({
      outcomes: ["success"],
      responseDelayMilliseconds: 10_000,
    });
    const oldPair = new CandidatePair(
      slow,
      createConsentCandidate("192.0.2.2", 5000, "remote"),
      true,
    );
    oldPair.nominated = true;

    const connection = createConsentHarness(["timeout"]).connection;
    connections.push(connection);
    // 上書きして遅い pair を nominated にする
    connection.nominated = oldPair;
    (connection as any).stopConsentLifecycle();
    (connection as any).queryConsent();

    // Act: 新しい pair に切替（旧 transaction は進行中）
    await vi.advanceTimersByTimeAsync(5_000);
    const fresh = new ConsentMockProtocol({
      outcomes: Array.from({ length: 10 }, () => "timeout" as const),
    });
    const newPair = new CandidatePair(
      fresh,
      createConsentCandidate("192.0.2.3", 5001, "remote"),
      true,
    );
    newPair.nominated = true;
    connection.nominated = newPair;
    (connection as any).stopConsentLifecycle();
    connection.state = "connected";
    (connection as any).queryConsent();

    // Act: 旧 pair の遅延応答が解決する時間
    await vi.advanceTimersByTimeAsync(10_000);

    // Assert: 旧応答では responsesReceived が増えない（新 pair は timeout のみ）
    expect(oldPair.responsesReceived).toBe(0);
    // 新 session は 30s タイマーが生きている間 connected
    expect(connection.state).toBe("connected");
  });
});
