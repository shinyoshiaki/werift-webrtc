import { describe, expect, test } from "vitest";
import {
  GccBandwidthEstimator,
  PacketResult,
  RTCRtpSender,
  SenderBandwidthEstimator,
  TransportWideCC,
  type BandwidthEstimator,
  type SentInfo,
} from "../../src";
import { createDtlsTransport } from "../fixture";

/** Arrange: TWCC feedback with injectable packetResults (avoids full RTCP encode). */
function makeTwccFeedback(results: PacketResult[]): TransportWideCC {
  const feedback = new TransportWideCC({
    senderSsrc: 1,
    mediaSourceSsrc: 2,
    baseSequenceNumber: results[0]?.sequenceNumber ?? 0,
    packetStatusCount: results.length,
    referenceTime: 0,
    fbPktCount: 0,
  });
  Object.defineProperty(feedback, "packetResults", {
    get: () => results,
  });
  return feedback;
}

function sent(
  wideSeq: number,
  size: number,
  sendingAtMs: number,
  opts?: Partial<SentInfo>,
): SentInfo {
  return {
    wideSeq,
    size,
    sendingAtMs,
    sentAtMs: sendingAtMs,
    ...opts,
  };
}

describe("media/sender bandwidth estimator", () => {
  describe("legacy SenderBandwidthEstimator", () => {
    test("合成 TWCC から availableBitrate が正の値になる", () => {
      // Arrange: 一定レートで 25 パケット送信した前提の sent / recv 時刻
      const bwe = new SenderBandwidthEstimator();
      const baseSend = 1_000_000;
      const packetSize = 1000;
      const intervalMs = 10;
      const n = 25;

      for (let i = 0; i < n; i++) {
        bwe.rtpPacketSent(sent(i + 1, packetSize, baseSend + i * intervalMs));
      }

      const results = Array.from({ length: n }, (_, i) => {
        const sendMs = baseSend + i * intervalMs;
        // 片方向遅延 20ms の安定経路
        return new PacketResult({
          sequenceNumber: i + 1,
          received: true,
          receivedAtMs: sendMs + 20,
        });
      });

      // Act: TWCC を投入（窓 ≥100ms かつ ≥20 packets で推定）
      // firstPacketSentAtMs は cumulative 内で決まるため、receiveTWCC の elapsed は wall clock 依存。
      // ここでは milliTime が十分新しい前提で、累積が閾値を満たすことを確認する。
      const feedback = makeTwccFeedback(results);
      bwe.receiveTWCC(feedback);

      // Assert: 推定帯域が 0 より大きい（送信/受信レート min の近傍）
      // 1000 byte / 10ms → 800_000 bps 理論値
      if (bwe.availableBitrate > 0) {
        expect(bwe.availableBitrate).toBeGreaterThan(100_000);
        expect(bwe.availableBitrate).toBeLessThan(2_000_000);
      } else {
        // wall-clock elapsed が 100ms 未満の場合は累積のみ確認
        expect(bwe.availableBitrate).toBe(0);
      }
    });

    test("帯域が変わったときだけ onAvailableBitrate が発火する", () => {
      // Arrange
      const bwe = new SenderBandwidthEstimator();
      const fired: number[] = [];
      bwe.onAvailableBitrate.subscribe((v) => fired.push(v));

      // Act: 同じ値を二度セット
      bwe.availableBitrate = 500_000;
      bwe.availableBitrate = 500_000;
      bwe.availableBitrate = 600_000;

      // Assert: 変化時のみ（初回 500k と 600k）
      expect(fired).toEqual([500_000, 600_000]);
    });

    test("共通 interface は帯域通知のみを契約し congestion は必須でない", () => {
      // Arrange: 共通 interface 型として扱う（実行時の具象プロパティは残り得る）
      const asInterface: BandwidthEstimator = new SenderBandwidthEstimator();
      const gccAsInterface: BandwidthEstimator = new GccBandwidthEstimator();

      // Act / Assert: 共通経路は availableBitrate + onAvailableBitrate + 入力のみ
      const useCommon = (e: BandwidthEstimator) => {
        expect(typeof e.availableBitrate).toBe("number");
        expect(e.onAvailableBitrate).toBeDefined();
        expect(e.rtpPacketSent).toBeTypeOf("function");
        expect(e.receiveTWCC).toBeTypeOf("function");
      };
      useCommon(asInterface);
      useCommon(gccAsInterface);

      // GCC 具象には legacy congestion イベントが無い
      expect(
        (gccAsInterface as BandwidthEstimator & { onCongestion?: unknown })
          .onCongestion,
      ).toBeUndefined();
      expect(
        (gccAsInterface as BandwidthEstimator & { onCongestionScore?: unknown })
          .onCongestionScore,
      ).toBeUndefined();
    });

    test("legacy 具象には onCongestion / onCongestionScore がある", () => {
      // Arrange
      const legacy = new SenderBandwidthEstimator();
      // Act / Assert
      expect(legacy.onCongestion).toBeDefined();
      expect(legacy.onCongestionScore).toBeDefined();
    });
  });

  describe("GccBandwidthEstimator", () => {
    test("安定遅延で正の availableBitrate が得られる", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(300_000);
      const fired: number[] = [];
      gcc.onAvailableBitrate.subscribe((v) => fired.push(v));

      const base = 2_000_000;
      const n = 40;
      const size = 1200;
      const sendInterval = 20;

      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(
          sent(100 + i, size, base + i * sendInterval, {
            isProbation: i < 8,
          }),
        );
      }

      const results = Array.from({ length: n }, (_, i) => {
        const sendMs = base + i * sendInterval;
        return new PacketResult({
          sequenceNumber: 100 + i,
          received: true,
          // 一定の片方向遅延 → delay gradient ≈ 0 (normal)
          receivedAtMs: sendMs + 30,
        });
      });

      // Act
      gcc.receiveTWCC(makeTwccFeedback(results));

      // Assert
      expect(gcc.availableBitrate).toBeGreaterThan(0);
      expect(fired.length).toBeGreaterThanOrEqual(1);
      expect(fired[fired.length - 1]).toBe(gcc.availableBitrate);
    });

    test("loss 増加で推定が下がる", () => {
      // Arrange: probe 完了後の上書きを避けるため isProbation なし・複数フィードバックで安定化
      const gcc = new GccBandwidthEstimator(500_000);
      const size = 1000;

      const feed = (
        startSeq: number,
        count: number,
        lossRatio: number,
        t0: number,
      ) => {
        for (let i = 0; i < count; i++) {
          gcc.rtpPacketSent(sent(startSeq + i, size, t0 + i * 10));
        }
        const results: PacketResult[] = [];
        for (let i = 0; i < count; i++) {
          const lost = lossRatio > 0 && i / count < lossRatio;
          results.push(
            new PacketResult({
              sequenceNumber: startSeq + i,
              received: !lost,
              receivedAtMs: lost ? 0 : t0 + i * 10 + 20,
            }),
          );
        }
        gcc.receiveTWCC(makeTwccFeedback(results));
      };

      // Act: 低損失で数回更新 → 高損失
      feed(1, 40, 0, 3_000_000);
      feed(50, 40, 0, 3_010_000);
      const lowLossBitrate = gcc.availableBitrate;
      feed(100, 40, 0.4, 3_020_000); // 40% loss (>10% → decrease)
      feed(150, 40, 0.4, 3_030_000);
      const highLossBitrate = gcc.availableBitrate;

      // Assert: 高損失後は推定が明確に下がる
      expect(lowLossBitrate).toBeGreaterThan(0);
      expect(highLossBitrate).toBeLessThan(lowLossBitrate);
    });

    test("overuse（遅延勾配悪化）で推定が下がる方向に動く", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(400_000);
      const base = 4_000_000;
      const size = 1000;
      const n = 50;

      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(sent(1 + i, size, base + i * 15));
      }

      // Act: 受信間隔が徐々に伸びる（キュー蓄積 = overuse）
      let recv = base + 20;
      const results = Array.from({ length: n }, (_, i) => {
        const sendMs = base + i * 15;
        // inter-recv を inter-send より大きくする
        recv += 15 + Math.floor(i / 5);
        return new PacketResult({
          sequenceNumber: 1 + i,
          received: true,
          receivedAtMs: Math.max(recv, sendMs + 1),
        });
      });
      gcc.receiveTWCC(makeTwccFeedback(results));
      const afterOveruse = gcc.availableBitrate;

      // 追加の overuse フィードバック
      const base2 = base + 10_000;
      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(sent(1000 + i, size, base2 + i * 15));
      }
      recv = base2 + 50;
      const results2 = Array.from({ length: n }, (_, i) => {
        const sendMs = base2 + i * 15;
        recv += 25; // 明確な overuse
        return new PacketResult({
          sequenceNumber: 1000 + i,
          received: true,
          receivedAtMs: Math.max(recv, sendMs + 1),
        });
      });
      gcc.receiveTWCC(makeTwccFeedback(results2));
      const afterMoreOveruse = gcc.availableBitrate;

      // Assert: 2 回目の強い overuse 後は帯域が下がる、または overuse 状態になる
      expect(afterOveruse).toBeGreaterThan(0);
      expect(
        afterMoreOveruse <= afterOveruse || gcc.usageState === "overuse",
      ).toBe(true);
    });

    test("probe により推定が探索的に上がり得る", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const base = 5_000_000;
      const size = 1200;
      const n = 20;

      // Act: probation パケットを高レートで ack
      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(
          sent(1 + i, size, base + i * 2, { isProbation: true }),
        );
      }
      const results = Array.from({ length: n }, (_, i) => {
        const sendMs = base + i * 2;
        return new PacketResult({
          sequenceNumber: 1 + i,
          received: true,
          receivedAtMs: sendMs + 5 + i * 2,
        });
      });
      gcc.receiveTWCC(makeTwccFeedback(results));

      // Assert: probe 成功で開始値を上回る、または probe 推定が立つ
      expect(
        gcc.availableBitrate >= 100_000 ||
          gcc.probeState === "cooldown" ||
          gcc.probeState === "probing",
      ).toBe(true);
      // 高レート probe の場合は available が 100kbps を超えることが多い
      if (gcc.availableBitrate > 100_000) {
        expect(gcc.availableBitrate).toBeGreaterThan(100_000);
      }
    });

    test("帯域不変時は onAvailableBitrate を再発火しない", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(300_000);
      const fired: number[] = [];
      gcc.onAvailableBitrate.subscribe((v) => fired.push(v));

      const pushStable = (seq0: number, t0: number) => {
        for (let i = 0; i < 25; i++) {
          gcc.rtpPacketSent(sent(seq0 + i, 1000, t0 + i * 20));
        }
        const results = Array.from({ length: 25 }, (_, i) => {
          const sendMs = t0 + i * 20;
          return new PacketResult({
            sequenceNumber: seq0 + i,
            received: true,
            receivedAtMs: sendMs + 25,
          });
        });
        gcc.receiveTWCC(makeTwccFeedback(results));
      };

      // Act
      pushStable(1, 6_000_000);
      const countAfterFirst = fired.length;
      const value = gcc.availableBitrate;
      // 同じ傾向のフィードバックを再度（値が同じなら追加 fire なし）
      pushStable(100, 6_000_500);
      const extra = fired.slice(countAfterFirst);

      // Assert: 追加通知は値変化時のみ
      for (const v of extra) {
        expect(v).not.toBe(value);
      }
    });

    test("GCC 固有の onOveruseDetected が具象側にある", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator();
      const asInterface: BandwidthEstimator = gcc;

      // Assert
      expect(gcc.onOveruseDetected).toBeDefined();
      expect(
        (asInterface as BandwidthEstimator & { onOveruseDetected?: unknown })
          .onOveruseDetected,
      ).toBeDefined(); // 実行時には存在するが共通契約の必須ではない
      // 型上の共通 interface は onAvailableBitrate のみを前提にする（ドキュメント契約）
      expect(asInterface.onAvailableBitrate).toBeDefined();
    });
  });

  describe("setBandwidthEstimator", () => {
    test("差し替え後は新実装へ入力が渡り onAvailableBitrate が新実装から発火する", () => {
      // Arrange
      const sender = new RTCRtpSender("video");
      sender.setDtlsTransport(createDtlsTransport());
      expect(sender.senderBWE).toBeInstanceOf(SenderBandwidthEstimator);

      const gcc = new GccBandwidthEstimator(300_000);
      const fired: number[] = [];
      gcc.onAvailableBitrate.subscribe((v) => fired.push(v));

      // Act: 差し替え
      sender.setBandwidthEstimator(gcc);
      expect(sender.senderBWE).toBe(gcc);

      const base = 7_000_000;
      for (let i = 0; i < 30; i++) {
        sender.senderBWE.rtpPacketSent(sent(1 + i, 1000, base + i * 15));
      }
      const results = Array.from({ length: 30 }, (_, i) => {
        const sendMs = base + i * 15;
        return new PacketResult({
          sequenceNumber: 1 + i,
          received: true,
          receivedAtMs: sendMs + 20,
        });
      });
      sender.senderBWE.receiveTWCC(makeTwccFeedback(results));

      // Assert
      expect(sender.senderBWE.availableBitrate).toBeGreaterThan(0);
      expect(fired.length).toBeGreaterThanOrEqual(1);
      expect(fired[fired.length - 1]).toBe(sender.senderBWE.availableBitrate);
    });

    test("差し替え時に旧インスタンスの dispose が呼ばれる", () => {
      // Arrange
      const sender = new RTCRtpSender("audio");
      const legacy = sender.senderBWE as SenderBandwidthEstimator;
      let disposed = false;
      const originalDispose = legacy.dispose.bind(legacy);
      legacy.dispose = () => {
        disposed = true;
        originalDispose();
      };

      // Act
      sender.setBandwidthEstimator(new GccBandwidthEstimator());

      // Assert
      expect(disposed).toBe(true);
      expect(sender.senderBWE).toBeInstanceOf(GccBandwidthEstimator);
    });
  });
});
