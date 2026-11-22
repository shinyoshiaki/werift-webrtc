import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONSENT_MAX_OUTSTANDING_REQUESTS } from "../../src/consent";
import { CandidatePair, CONSENT_TIMEOUT } from "../../src/iceBase";
import {
  type ConsentNetworkHarness,
  createConsentCandidate,
  createConsentNetworkHarness,
  createFailoverHarness,
  lossyConsentPeer,
} from "../utils";

/**
 * Consent freshness (RFC 7675) over a real StunProtocol + Transaction with a
 * scripted peer (delay, loss, reordering, forged responses): a genuine
 * response that arrives while the consent is fresh keeps it, whatever the
 * RTT estimate or the request interval, and nothing else extends it.
 */
describe("consent freshness over a real StunProtocol (delay / loss)", () => {
  const harnesses: ConsentNetworkHarness[] = [];
  const build = (...args: Parameters<typeof createConsentNetworkHarness>) => {
    const harness = createConsentNetworkHarness(...args);
    harnesses.push(harness);
    return harness;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(async () => {
    const pending = harnesses.splice(0);
    await Promise.all(pending.map((harness) => harness.dispose()));
    for (const harness of pending) {
      expect(harness.unhandledRejections).toEqual([]);
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The agent is connected, consent is fresh and application data reaches the wire. */
  const expectAlive = async (harness: ConsentNetworkHarness) => {
    expect(harness.connection.state).toBe("connected");
    expect(harness.failedAt()).toBeUndefined();
    expect((harness.connection as any).consent.fresh).toBe(true);
    const before = harness.dataSent.length;
    await harness.connection.send(Buffer.from("payload"));
    expect(harness.dataSent.length).toBe(before + 1);
  };

  describe("真正な応答が続く経路では失効しない", () => {
    it("選択時 RTT 10ms から往復 1000ms に上がって 90 秒続いても connected のまま", async () => {
      // Arrange: 選択時の RTT 推定は 10ms（応答待ちの推定は 500ms）
      const harness = build(lossyConsentPeer(1000), { initialRtt: 0.01 });

      // Act: 90 秒進める
      await vi.advanceTimersByTimeAsync(90_000);

      // Assert: 推定を超えて届いた応答がすべて受理され、RTT 推定も追従する
      expect(harness.deliveries.length).toBeGreaterThan(10);
      expect(harness.deliveries.every((d) => d.accepted)).toBe(true);
      expect(harness.nominated.rtt).toBeCloseTo(1, 3);
      await expectAlive(harness);
    });

    it("RTT 不明（既定 1000ms）で往復 1500ms でも connected のまま", async () => {
      // Arrange
      const harness = build(lossyConsentPeer(1500));

      // Act: 90 秒進める
      await vi.advanceTimersByTimeAsync(90_000);

      // Assert: 全応答を受理
      expect(harness.deliveries.every((d) => d.accepted)).toBe(true);
      await expectAlive(harness);
    });

    it("往復 5500ms（送信間隔を超える）でも前の request への応答が受理される", async () => {
      // Arrange: 間隔 5s（random 0.5）より長い往復
      const harness = build(lossyConsentPeer(5500), { initialRtt: 5.5 });

      // Act: 90 秒進める
      await vi.advanceTimersByTimeAsync(90_000);

      // Assert: 応答は次の request が送られた後に届き、それでも受理される
      const late = harness.deliveries.filter(
        (d) =>
          harness.requests.filter((r) => r.sentAt < d.at).length - 1 >
          d.requestIndex,
      );
      expect(late.length).toBeGreaterThan(0);
      expect(harness.deliveries.every((d) => d.accepted)).toBe(true);
      await expectAlive(harness);
    });

    it.each([
      { name: "4a 相当（往復 1s・損失 20%）", rtt: 1000 },
      { name: "4b 相当（往復 4s・損失 20%）", rtt: 4000 },
    ])("下流 $name を 120 秒続けても connected のまま", async ({ rtt }) => {
      // Arrange: シード固定の 20% 損失（往復単位）
      const harness = build(lossyConsentPeer(rtt, 0.2, 7), {
        initialRtt: 0.01,
      });

      // Act: 120 秒進める
      await vi.advanceTimersByTimeAsync(120_000);

      // Assert: 損失はあったが届いた応答はすべて受理され、失効しない
      expect(harness.deliveries.length).toBeLessThan(harness.requests.length);
      expect(harness.deliveries.every((d) => d.accepted)).toBe(true);
      await expectAlive(harness);
    });

    it("単発の loss とジッタ（100〜3000ms）の下でも connected のまま", async () => {
      // Arrange: 3 番目の往復を落とし、残りは決定的なジッタ
      const jitter = lossyConsentPeer(
        (request) => [100, 3000, 1700, 250, 2900, 600][request.index % 6]!,
      );
      const harness = build((request) =>
        request.index === 2 ? { delay: 0, drop: true } : jitter(request),
      );

      // Act: 90 秒進める
      await vi.advanceTimersByTimeAsync(90_000);

      // Assert
      expect(harness.deliveries.every((d) => d.accepted)).toBe(true);
      await expectAlive(harness);
    });

    it("応答の順序が入れ替わっても受理し、古い request の RTT で新しい推定を上書きしない", async () => {
      // Arrange: 偶数番目は 7000ms、奇数番目は 500ms で返る（追い越しが起きる）
      const harness = build((request) => ({
        delay: request.index % 2 === 0 ? 7000 : 500,
      }));

      // Act: 2 本目（5s 送信）の応答 5.5s → 1 本目（0s 起点 5s 送信）の応答 12s を待つ
      await vi.advanceTimersByTimeAsync(12_100);

      // Assert: 2 本目の応答が 1 本目より先に届き、両方受理される
      expect(harness.deliveries.map((d) => d.requestIndex)).toEqual([1, 0]);
      expect(harness.deliveries.every((d) => d.accepted)).toBe(true);
      // Assert: 現在の RTT は新しい request（500ms）のもの、合計は両方を数える
      expect(harness.nominated.rtt).toBeCloseTo(0.5, 3);
      expect(harness.nominated.roundTripTimeMeasurements).toBe(2);
      expect(harness.nominated.totalRoundTripTime).toBeCloseTo(7.5, 3);

      // Act: 90 秒まで進める
      await vi.advanceTimersByTimeAsync(90_000 - 12_100);

      // Assert
      await expectAlive(harness);
    });

    it("25 秒の損失バーストの後に回復すれば connected のまま", async () => {
      // Arrange: 最初の応答の後、25 秒間すべて落ちる
      let burstEndsAt = Number.POSITIVE_INFINITY;
      const harness = build((request) => {
        if (request.index === 0) return { delay: 1_000 };
        return request.sentAt < burstEndsAt
          ? { delay: 0, drop: true }
          : { delay: 100 };
      });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(harness.deliveries).toHaveLength(1);
      burstEndsAt = harness.elapsed() + 25_000;

      // Act: バースト中とその後
      await vi.advanceTimersByTimeAsync(25_000);
      expect(harness.connection.state).toBe("connected");
      await vi.advanceTimersByTimeAsync(60_000);

      // Assert: 回復後の応答で期限が延び、失効しない
      expect(harness.deliveries.length).toBeGreaterThan(5);
      await expectAlive(harness);
    });
  });

  describe("有効な応答がなければ失効する", () => {
    it("31 秒の blackhole で failed になり application data を送らない", async () => {
      // Arrange: すべて落ちる
      const harness = build(() => ({ delay: 0, drop: true }));
      await harness.connection.send(Buffer.from("before"));
      expect(harness.dataSent).toHaveLength(1);

      // Act: 31 秒進める
      await vi.advanceTimersByTimeAsync(31_000);

      // Assert: 最後の有効応答（選択）から 30 秒で failed、送信は transport に届かない
      expect(harness.failedAt()).toBe(CONSENT_TIMEOUT * 1000);
      expect(harness.connection.state).toBe("failed");
      await harness.connection.send(Buffer.from("after"));
      expect(harness.dataSent).toHaveLength(1);
      // Assert: 未完了の consent transaction は破棄されている
      expect(harness.openTransactions()).toBe(0);
    });

    it("失効後に届いた真正な遅延応答では再確立しない", async () => {
      // Arrange: 最初の request の応答は失効の後（送信 5s + 27s = 32s）に届く
      const harness = build((request) =>
        request.index === 0 ? { delay: 27_000 } : { delay: 0, drop: true },
      );

      // Act: 失効（30s）と遅延応答の到着（32s）を過ぎる
      await vi.advanceTimersByTimeAsync(33_000);

      // Assert: 応答は transaction 破棄後に届き、failed のまま
      expect(harness.deliveries).toHaveLength(1);
      expect(harness.deliveries[0]!.registered).toBe(false);
      expect(harness.deliveries[0]!.accepted).toBe(false);
      expect(harness.connection.state).toBe("failed");
      expect((harness.connection as any).consent.fresh).toBe(false);
      await harness.connection.send(Buffer.from("stale"));
      expect(harness.dataSent).toHaveLength(0);
    });
  });

  describe("期限を延長してはならない応答", () => {
    it.each([
      { name: "不正な MESSAGE-INTEGRITY", reply: { key: "wrong-password" } },
      { name: "署名なし", reply: { key: null } },
      {
        name: "別の送信元アドレス",
        reply: { from: ["198.51.100.9", 5000] as [string, number] },
      },
      { name: "未知の txid", reply: { unknownTransactionId: true } },
    ])("$name の応答だけでは 30 秒で failed になる", async ({ reply }) => {
      // Arrange: すべての request に偽の応答だけが返る
      const harness = build(() => ({ delay: 200, ...reply }));

      // Act: 31 秒進める
      await vi.advanceTimersByTimeAsync(31_000);

      // Assert: どれも受理されず失効する
      expect(harness.deliveries.length).toBeGreaterThan(0);
      expect(harness.deliveries.some((d) => d.accepted)).toBe(false);
      expect(harness.nominated.responsesReceived).toBe(0);
      expect(harness.failedAt()).toBe(CONSENT_TIMEOUT * 1000);
    });

    it("旧 remote generation の request への応答は期限を延長しない", async () => {
      // Arrange: 最初の request の応答は 8s 後に届く
      const harness = build((request) =>
        request.index === 0 ? { delay: 8_000 } : { delay: 0, drop: true },
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.requests).toHaveLength(1);

      // Act: 応答の到着前に remote generation が進む（consent session はそのまま）
      (harness.connection as any).remoteGeneration++;
      await vi.advanceTimersByTimeAsync(8_000);

      // Assert: transaction には届くが consent は受理しない
      expect(harness.deliveries).toHaveLength(1);
      expect(harness.deliveries[0]!.registered).toBe(true);
      expect(harness.deliveries[0]!.accepted).toBe(false);
      // Assert: 期限は選択時から 30 秒のまま
      await vi.advanceTimersByTimeAsync(CONSENT_TIMEOUT * 1000 - 13_000);
      expect(harness.failedAt()).toBe(CONSENT_TIMEOUT * 1000);
    });

    it("ICE restart 前の request への応答は破棄され、期限を延長しない", async () => {
      // Arrange: 応答は 8s 後
      const harness = build(() => ({ delay: 8_000 }));
      await vi.advanceTimersByTimeAsync(5_000);
      const before = harness.nominated.responsesReceived;

      // Act: restart（consent session と transaction を破棄）の後に応答が届く
      await harness.connection.restart();
      await vi.advanceTimersByTimeAsync(8_000);

      // Assert: transaction は残っておらず、応答は捨てられる
      expect(harness.openTransactions()).toBe(0);
      expect(harness.deliveries[0]!.registered).toBe(false);
      expect(harness.nominated.responsesReceived).toBe(before);
      expect((harness.connection as any).consent.fresh).toBe(false);
    });

    it("旧 selected pair の request への応答は新しい pair の期限を延長しない", async () => {
      // Arrange: 最初の request の応答は 8s 後、以降は落ちる
      const harness = build((request) =>
        request.index === 0 ? { delay: 8_000 } : { delay: 0, drop: true },
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const next = new CandidatePair(
        harness.protocol,
        createConsentCandidate("192.0.2.3", 5001, "remote"),
        true,
      );
      next.nominated = true;

      // Act: 応答の到着前に selection が別の pair へ移る（session はそのまま）
      harness.connection.nominated = next;
      await vi.advanceTimersByTimeAsync(8_000);

      // Assert: 旧 pair の応答は consent を更新しない
      expect(harness.deliveries[0]!.registered).toBe(true);
      expect(harness.nominated.responsesReceived).toBe(0);
      expect(next.responsesReceived).toBe(0);
      await vi.advanceTimersByTimeAsync(CONSENT_TIMEOUT * 1000 - 13_000);
      expect(harness.failedAt()).toBe(CONSENT_TIMEOUT * 1000);
    });
  });

  describe("lifecycle と資源", () => {
    /** Arrange: no response at all, so several consent transactions stay open. */
    const withOutstanding = async () => {
      const harness = build(() => ({ delay: 0, drop: true }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.openTransactions()).toBe(4);
      expect((harness.connection as any).consent.outstandingRequests).toBe(4);
      return harness;
    };

    it("close で未完了の transaction と consent の timer がすべて消える", async () => {
      // Arrange
      const harness = await withOutstanding();

      // Act: close（transaction の後始末の microtask まで進める）
      await harness.connection.close();
      await vi.advanceTimersByTimeAsync(0);

      // Assert: transaction・timer が残らない
      expect(harness.openTransactions()).toBe(0);
      expect((harness.connection as any).consent.outstandingRequests).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("ICE restart で未完了の transaction がすべて消える", async () => {
      // Arrange
      const harness = await withOutstanding();

      // Act: restart
      await harness.connection.restart();
      await vi.advanceTimersByTimeAsync(0);

      // Assert
      expect(harness.openTransactions()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("pair 切替（consent の再開）で旧 session の transaction がすべて消える", async () => {
      // Arrange
      const harness = await withOutstanding();

      // Act: 新しい pair で consent を開始し直す
      const consent = (harness.connection as any).consent;
      consent.stop();
      consent.start();
      await vi.advanceTimersByTimeAsync(0);

      // Assert: 旧 session の request は残らない（新 session はまだ送っていない）
      expect(harness.openTransactions()).toBe(0);
      expect(consent.outstandingRequests).toBe(0);
    });

    it("expiry で未完了の transaction と consent の timer がすべて消える", async () => {
      // Arrange
      const harness = await withOutstanding();

      // Act: 失効させる
      await vi.advanceTimersByTimeAsync(11_000);

      // Assert
      expect(harness.connection.state).toBe("failed");
      expect(harness.openTransactions()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("送信間隔は 4〜6 秒、request ごとに wire 送信 1 回・txid 一意、stats は実数と一致する", async () => {
      // Arrange: 間隔の乱数を変化させ、2 本に 1 本落とす
      const values = [0, 0.999, 0.3, 0.7];
      let i = 0;
      vi.spyOn(Math, "random").mockImplementation(
        () => values[i++ % values.length]!,
      );
      const harness = build((request) => ({
        delay: 2_000,
        drop: request.index % 2 === 1,
      }));

      // Act: 60 秒進める（失効しない）
      await vi.advanceTimersByTimeAsync(60_000);

      // Assert: 送信間隔
      const gaps = harness.requests
        .slice(1)
        .map((r, index) => r.sentAt - harness.requests[index]!.sentAt);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(4_000);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(6_000);
      // Assert: txid 一意・再送なし・stats 一致
      const ids = new Set(harness.requests.map((r) => r.transactionIdHex));
      expect(ids.size).toBe(harness.requests.length);
      const pair = harness.nominated;
      expect(pair.consentRequestsSent).toBe(harness.requests.length);
      expect(pair.requestsSent).toBe(harness.requests.length);
      expect(pair.retransmissionsSent).toBe(0);
      expect(pair.responsesReceived).toBe(
        harness.deliveries.filter((d) => d.accepted).length,
      );
      await expectAlive(harness);
    });
  });
});

describe("consent freshness with failover pacing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("応答のない間も未完了の consent request は上限を超えない", async () => {
    // Arrange: failover（semi-aggressive）の選択済み経路を切断する
    const harness = await createFailoverHarness({ locals: [harness0()] });
    harness.cut(0);
    const consent = (harness.connection as any).consent;
    let max = 0;

    // Act: 失効まで 100ms 刻みで観測する（weak 間隔 900ms で送られる）
    for (let t = 0; t < CONSENT_TIMEOUT * 1000; t += 100) {
      await vi.advanceTimersByTimeAsync(100);
      max = Math.max(max, consent.outstandingRequests);
    }

    // Assert: 上限で頭打ちになり、超えない
    expect(max).toBeGreaterThan(8);
    expect(max).toBeLessThanOrEqual(CONSENT_MAX_OUTSTANDING_REQUESTS);
    await harness.connection.close();
    expect(consent.outstandingRequests).toBe(0);
  });

  it("往復 7000ms（従来の 5 秒の保持を超える）の応答も consent を維持する", async () => {
    // Arrange: 選択後に往復が 7s に上がる
    const harness = await createFailoverHarness({ locals: [harness0()] });
    harness.protocols[0]!.responseDelayMs = 7_000;

    // Act: 90 秒進める
    await vi.advanceTimersByTimeAsync(90_000);

    // Assert: 失効しない
    expect(harness.connection.state).toBe("connected");
    expect((harness.connection as any).consent.fresh).toBe(true);
    await harness.connection.close();
  });

  it("往復 10000ms でも上限で要求を破棄せず consent を維持する", async () => {
    // Arrange: 選択後に往復が 10s に上がる（weak 間隔 900ms で 10 件超が未完了になる）
    const harness = await createFailoverHarness({ locals: [harness0()] });
    harness.protocols[0]!.responseDelayMs = 10_000;

    // Act: 90 秒進める
    await vi.advanceTimersByTimeAsync(90_000);

    // Assert: 失効せず接続が維持される
    expect(harness.connection.state).toBe("connected");
    expect((harness.connection as any).consent.fresh).toBe(true);
    await harness.connection.close();
  });

  it("往復 25000ms（期限内）でも失効しない", async () => {
    // Arrange: 往復が 30s 期限ぎりぎりの 29s
    const harness = await createFailoverHarness({ locals: [harness0()] });
    harness.protocols[0]!.responseDelayMs = 25_000;

    // Act: 120 秒進める
    await vi.advanceTimersByTimeAsync(120_000);

    // Assert: 失効しない
    expect(harness.connection.state).toBe("connected");
    await harness.connection.close();
  });
});

/** One host socket (no backup), so the selection cannot move away. */
const harness0 = () => ({
  type: "stun",
  candidateType: "host",
  priority: 2_000_000_000,
});
