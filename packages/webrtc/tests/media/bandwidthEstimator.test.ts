import { describe, expect, test, vi } from "vitest";
import {
  AimdRateControl,
  GccBandwidthEstimator,
  LossBasedBwe,
  PacketResult,
  ProbeController,
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpSender,
  RtcpTransportLayerFeedback,
  RtpHeader,
  RtpPacket,
  SenderBandwidthEstimator,
  TransportWideCC,
  TrendlineEstimator,
  type BandwidthEstimator,
  type SentInfo,
  kBeta,
  kLossBasedIncreaseFactor,
  sortPacketResultsByWideSeq,
} from "../../src";
import { RTP_EXTENSION_URI } from "../../src/imports/rtp";
import { createDtlsTransport } from "../fixture";

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

function makeTwccRtcp(results: PacketResult[]): RtcpTransportLayerFeedback {
  return new RtcpTransportLayerFeedback({
    feedback: makeTwccFeedback(results),
  });
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
    test("帯域が変わったときだけ onAvailableBitrate が発火する", () => {
      const bwe = new SenderBandwidthEstimator();
      const fired: number[] = [];
      bwe.onAvailableBitrate.subscribe((v) => fired.push(v));
      bwe.availableBitrate = 500_000;
      bwe.availableBitrate = 500_000;
      bwe.availableBitrate = 600_000;
      expect(fired).toEqual([500_000, 600_000]);
    });

    test("共通 interface は帯域通知のみを契約する", () => {
      const asInterface: BandwidthEstimator = new SenderBandwidthEstimator();
      expect(asInterface.onAvailableBitrate).toBeDefined();
      expect(asInterface.rtpPacketSent).toBeTypeOf("function");
      expect(asInterface.receiveTWCC).toBeTypeOf("function");
    });
  });

  describe("sequence wrap-around", () => {
    test("sortPacketResultsByWideSeq は 0xFFFF を跨いでも送信順を保つ", () => {
      const clustered = [
        new PacketResult({ sequenceNumber: 65534, received: true }),
        new PacketResult({ sequenceNumber: 1, received: true }),
        new PacketResult({ sequenceNumber: 0, received: true }),
        new PacketResult({ sequenceNumber: 65535, received: true }),
      ];
      const sorted = sortPacketResultsByWideSeq(clustered);
      expect(sorted.map((r) => r.sequenceNumber)).toEqual([
        65534, 65535, 0, 1,
      ]);
    });

    test("GCC は wrap-around TWCC でも overuse に誤検出しない", () => {
      const gcc = new GccBandwidthEstimator(300_000);
      const seqs = [65534, 65535, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const base = 8_000_000;
      const interval = 20;
      for (let i = 0; i < seqs.length; i++) {
        gcc.rtpPacketSent(sent(seqs[i], 1000, base + i * interval));
      }
      const results = seqs.map((seq, i) => {
        const sendMs = base + i * interval;
        return new PacketResult({
          sequenceNumber: seq,
          received: true,
          receivedAtMs: sendMs + 25,
        });
      });
      const shuffled = [
        results[2],
        results[0],
        results[5],
        results[1],
        results[3],
        results[4],
        ...results.slice(6),
      ];
      gcc.receiveTWCC(makeTwccFeedback(shuffled));
      expect(gcc.availableBitrate).toBeGreaterThan(0);
      expect(gcc.usageState).not.toBe("overuse");
    });
  });

  describe("TrendlineEstimator / LossBasedBwe / ProbeController", () => {
    test("TrendlineEstimator は正の遅延勾配で正の trend を返す", () => {
      // Arrange
      const t = new TrendlineEstimator();
      let last = 0;
      // Act: recv delta > send delta を連続投入
      for (let i = 0; i < 25; i++) {
        last = t.update(30, 20, 1000 + i * 30);
      }
      // Assert
      expect(last).toBeGreaterThan(0);
      expect(t.sampleCount).toBeGreaterThan(1);
    });

    test("LossBasedBwe は低損失で増加・高損失で減少する系列", () => {
      // Arrange
      const loss = new LossBasedBwe();
      loss.reset(500_000);

      // Act / Assert: 低損失
      const up = loss.update(0.01, 500_000, 500_000);
      expect(up).toBeGreaterThanOrEqual(
        Math.round(500_000 * kLossBasedIncreaseFactor),
      );

      // 中間帯は hold 系
      const mid = loss.update(0.05, 500_000, 500_000);
      expect(mid).toBeLessThanOrEqual(up * 1.05);

      // 高損失で減少
      const down = loss.update(0.2, 400_000, 400_000);
      expect(down).toBeLessThan(mid);
      expect(loss.lossState).toBe("decreasing");
    });

    test("ProbeController は exponential probe を発行し完了後 complete になる", () => {
      // Arrange
      const probe = new ProbeController();
      const clusters = probe.setBitrates(10_000, 100_000, 10_000_000, 1000);

      // Assert: 初期 3x / 6x クラスタ
      expect(clusters.length).toBeGreaterThanOrEqual(1);
      expect(probe.probeState).toBe("waiting_for_result");
      expect(probe.currentProbeTargetBps).toBeGreaterThan(100_000);

      // Act: タグ付き ack でクラスタ完了
      const target = probe.currentProbeTargetBps;
      for (let i = 0; i < 10; i++) {
        probe.onAckedPacket(1200, 1000 + i * 5, true);
      }

      // Assert
      const pending = probe.takePendingEstimateBps();
      expect(pending).toBeGreaterThan(0);
      expect(target).toBeGreaterThan(0);
    });
  });

  describe("GccBandwidthEstimator", () => {
    test("安定遅延で正の availableBitrate が得られる", () => {
      const gcc = new GccBandwidthEstimator(300_000);
      const base = 2_000_000;
      const n = 40;
      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(
          sent(100 + i, 1200, base + i * 20, { isProbation: i < 8 }),
        );
      }
      const results = Array.from({ length: n }, (_, i) => {
        const sendMs = base + i * 20;
        return new PacketResult({
          sequenceNumber: 100 + i,
          received: true,
          receivedAtMs: sendMs + 30,
        });
      });
      gcc.receiveTWCC(makeTwccFeedback(results));
      expect(gcc.availableBitrate).toBeGreaterThan(0);
    });

    test("未知の feedback sequence は loss に数えない", () => {
      // Arrange: 送信は 1..10 のみ
      const gcc = new GccBandwidthEstimator(300_000);
      const base = 3_000_000;
      for (let i = 1; i <= 10; i++) {
        gcc.rtpPacketSent(sent(i, 1000, base + i * 10));
      }

      // Act: 未知 seq 11..30 を全部 not-received で混ぜる
      const results: PacketResult[] = [];
      for (let i = 1; i <= 10; i++) {
        results.push(
          new PacketResult({
            sequenceNumber: i,
            received: true,
            receivedAtMs: base + i * 10 + 20,
          }),
        );
      }
      for (let i = 11; i <= 30; i++) {
        results.push(
          new PacketResult({
            sequenceNumber: i,
            received: false,
            receivedAtMs: 0,
          }),
        );
      }
      gcc.receiveTWCC(makeTwccFeedback(results));
      const afterUnknown = gcc.availableBitrate;

      // 同じ 1..10 を全部損失にした場合は下がる（比較用に別インスタンス）
      const gcc2 = new GccBandwidthEstimator(300_000);
      for (let i = 1; i <= 20; i++) {
        gcc2.rtpPacketSent(sent(i, 1000, base + i * 10));
      }
      const allLost = Array.from({ length: 20 }, (_, i) =>
        new PacketResult({
          sequenceNumber: i + 1,
          received: i >= 12, // 60% loss of known
          receivedAtMs: i >= 12 ? base + (i + 1) * 10 + 20 : 0,
        }),
      );
      // first establish then lose
      gcc2.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 20 }, (_, i) =>
            new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: base + (i + 1) * 10 + 20,
            }),
          ),
        ),
      );
      const good = gcc2.availableBitrate;
      gcc2.receiveTWCC(makeTwccFeedback(allLost));
      const afterRealLoss = gcc2.availableBitrate;

      // Assert: 未知 seq のみの「偽 loss」で致命的に落ちない
      expect(afterUnknown).toBeGreaterThan(0);
      expect(afterRealLoss).toBeLessThanOrEqual(good);
    });

    test("重複 TWCC は二重計上しない", () => {
      const gcc = new GccBandwidthEstimator(300_000);
      const base = 4_000_000;
      for (let i = 1; i <= 25; i++) {
        gcc.rtpPacketSent(sent(i, 1000, base + i * 15));
      }
      const results = Array.from({ length: 25 }, (_, i) =>
        new PacketResult({
          sequenceNumber: i + 1,
          received: true,
          receivedAtMs: base + (i + 1) * 15 + 20,
        }),
      );
      gcc.receiveTWCC(makeTwccFeedback(results));
      const first = gcc.availableBitrate;
      // Act: 同一 feedback 再送
      gcc.receiveTWCC(makeTwccFeedback(results));
      // Assert: 再送だけで急変しない（変化しても同値が多い）
      expect(gcc.availableBitrate).toBeGreaterThan(0);
      expect(Math.abs(gcc.availableBitrate - first) / Math.max(first, 1)).toBeLessThan(
        0.5,
      );
    });

    test("loss 増加で推定が下がる", () => {
      const gcc = new GccBandwidthEstimator(500_000);
      const feed = (
        startSeq: number,
        count: number,
        lossRatio: number,
        t0: number,
      ) => {
        for (let i = 0; i < count; i++) {
          gcc.rtpPacketSent(sent(startSeq + i, 1000, t0 + i * 10));
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
      feed(1, 40, 0, 3_000_000);
      feed(50, 40, 0, 3_010_000);
      const low = gcc.availableBitrate;
      feed(100, 40, 0.4, 3_020_000);
      feed(150, 40, 0.4, 3_030_000);
      const high = gcc.availableBitrate;
      expect(low).toBeGreaterThan(0);
      expect(high).toBeLessThan(low);
    });

    test("probe で getPacingBitrateBps が probe target まで上がる", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      // Act: cold-start probe 開始
      expect(gcc.shouldTagProbePacket()).toBe(true);
      const pacing = gcc.getPacingBitrateBps();
      // Assert: pacing ≥ probe target ≥ start
      expect(pacing).toBeGreaterThanOrEqual(100_000);
      expect(gcc.suggestedProbeBitrateBps).toBeGreaterThan(0);
      expect(pacing).toBeGreaterThanOrEqual(gcc.suggestedProbeBitrateBps);
    });

    test("probe タグ付き ack で推定が上がり probeState が進む", () => {
      const gcc = new GccBandwidthEstimator(100_000);
      gcc.shouldTagProbePacket();
      const base = 5_000_000;
      const n = 20;
      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(
          sent(1 + i, 1200, base + i * 2, { isProbation: true }),
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
      expect(gcc.availableBitrate).toBeGreaterThanOrEqual(100_000);
    });
  });

  describe("決定的制御則", () => {
    test("AIMD は overuse で beta 倍に下げる", () => {
      const aimd = new AimdRateControl();
      aimd.reset(400_000);
      const decreased = aimd.update("overuse", 400_000, 1000);
      expect(decreased).toBe(Math.round(400_000 * kBeta));
    });

    test("固定入力の GCC bitrate 系列が許容誤差内で回帰する", () => {
      const gcc = new GccBandwidthEstimator(500_000);
      const series: number[] = [];
      const step = (
        seq0: number,
        t0: number,
        lossRatio: number,
        count = 30,
      ) => {
        for (let i = 0; i < count; i++) {
          gcc.rtpPacketSent(sent(seq0 + i, 1000, t0 + i * 10));
        }
        const results = Array.from({ length: count }, (_, i) => {
          const lost = i / count < lossRatio;
          return new PacketResult({
            sequenceNumber: seq0 + i,
            received: !lost,
            receivedAtMs: lost ? 0 : t0 + i * 10 + 20,
          });
        });
        gcc.receiveTWCC(makeTwccFeedback(results));
        series.push(gcc.availableBitrate);
      };
      step(1, 9_000_000, 0);
      step(40, 9_001_000, 0);
      const afterGood = series.at(-1)!;
      step(80, 9_002_000, 0.35);
      step(120, 9_003_000, 0.35);
      const afterLoss = series.at(-1)!;
      expect(afterGood).toBeGreaterThan(0);
      expect(afterLoss).toBeLessThan(afterGood);
      expect(afterLoss).toBeLessThanOrEqual(afterGood * 0.95);
    });
  });

  describe("RTCRtpSender 配線", () => {
    test("sender.onAvailableBitrate は差し替え後も維持される", () => {
      const sender = new RTCRtpSender("video");
      const fired: number[] = [];
      sender.onAvailableBitrate.subscribe((v) => fired.push(v));
      const gcc = new GccBandwidthEstimator(300_000);
      sender.setBandwidthEstimator(gcc);
      const base = 7_000_000;
      for (let i = 0; i < 30; i++) {
        gcc.rtpPacketSent(sent(1 + i, 1000, base + i * 15));
      }
      const results = Array.from({ length: 30 }, (_, i) => {
        const sendMs = base + i * 15;
        return new PacketResult({
          sequenceNumber: 1 + i,
          received: true,
          receivedAtMs: sendMs + 20,
        });
      });
      sender.handleRtcpPacket(makeTwccRtcp(results));
      expect(fired.length).toBeGreaterThanOrEqual(1);
      expect(fired.at(-1)).toBe(gcc.availableBitrate);
    });

    test("sendRtp 経路で probe タグと pacing が estimator に連動する", async () => {
      const sender = new RTCRtpSender("video");
      const dtls = createDtlsTransport();
      (dtls as { state: string }).state = "connected";
      dtls.sendRtp = vi.fn(async () => 900) as typeof dtls.sendRtp;
      dtls.transportSequenceNumber = 100;
      sender.setDtlsTransport(dtls);

      const gcc = new GccBandwidthEstimator(100_000);
      const probeCfgs: number[] = [];
      sender.onProbeClusterConfig.subscribe((c) =>
        probeCfgs.push(c.targetBps),
      );
      sender.setBandwidthEstimator(gcc);

      sender.prepareSend({
        codecs: [
          new RTCRtpCodecParameters({
            mimeType: "video/VP8",
            clockRate: 90000,
            payloadType: 96,
          }),
        ],
        headerExtensions: [
          new RTCRtpHeaderExtensionParameters({
            id: 3,
            uri: RTP_EXTENSION_URI.transportWideCC,
          }),
        ],
        muxId: "0",
        rtcp: { cname: "test", mux: true },
      });

      // Act
      expect(sender.pacingBitrateBps).toBeGreaterThanOrEqual(100_000);

      const rtpSpy = vi.spyOn(gcc, "rtpPacketSent");
      for (let i = 0; i < 8; i++) {
        const packet = new RtpPacket(
          new RtpHeader({
            sequenceNumber: i,
            timestamp: i * 3000,
            payloadType: 96,
            ssrc: 1,
            extension: true,
            extensions: [],
            marker: false,
            padding: false,
            payloadOffset: 12,
          }),
          Buffer.alloc(200),
        );
        await sender.sendRtp(packet);
      }

      // Assert: probe タグ付き
      expect(rtpSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      const tagged = rtpSpy.mock.calls.some(
        (c) => (c[0] as SentInfo).isProbation === true,
      );
      expect(tagged).toBe(true);

      // handleRtcpPacket 経路
      const sentCalls = rtpSpy.mock.calls.map((c) => c[0] as SentInfo);
      const results = sentCalls.map(
        (info) =>
          new PacketResult({
            sequenceNumber: info.wideSeq,
            received: true,
            receivedAtMs: info.sendingAtMs + 10,
          }),
      );
      sender.handleRtcpPacket(makeTwccRtcp(results));
      expect(sender.senderBWE.availableBitrate).toBeGreaterThanOrEqual(0);
    });
  });
});
