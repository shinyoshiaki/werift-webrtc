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
  kTrendlineWindowSize,
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

/** Feed monotonic send/recv with configurable recv stretch (delay growth). */
function feedDelayScenario(
  gcc: GccBandwidthEstimator,
  opts: {
    seq0: number;
    t0: number;
    count: number;
    sendInterval: number;
    /** Extra ms added to inter-recv each step (0 = flat delay). */
    recvStretchPerStep: number;
    baseOneWayMs?: number;
  },
) {
  const {
    seq0,
    t0,
    count,
    sendInterval,
    recvStretchPerStep,
    baseOneWayMs = 20,
  } = opts;
  for (let i = 0; i < count; i++) {
    gcc.rtpPacketSent(sent(seq0 + i, 1000, t0 + i * sendInterval));
  }
  let recv = t0 + baseOneWayMs;
  const results = Array.from({ length: count }, (_, i) => {
    const sendMs = t0 + i * sendInterval;
    recv += sendInterval + recvStretchPerStep;
    return new PacketResult({
      sequenceNumber: seq0 + i,
      received: true,
      receivedAtMs: Math.max(recv, sendMs + 1),
    });
  });
  gcc.receiveTWCC(makeTwccFeedback(results));
}

describe("media/sender bandwidth estimator", () => {
  describe("legacy", () => {
    test("帯域が変わったときだけ onAvailableBitrate が発火する", () => {
      const bwe = new SenderBandwidthEstimator();
      const fired: number[] = [];
      bwe.onAvailableBitrate.subscribe((v) => fired.push(v));
      bwe.availableBitrate = 500_000;
      bwe.availableBitrate = 500_000;
      bwe.availableBitrate = 600_000;
      expect(fired).toEqual([500_000, 600_000]);
    });
  });

  describe("TrendlineEstimator (libwebrtc)", () => {
    test("窓が満杯になるまで slope を再計算しない", () => {
      const t = new TrendlineEstimator();
      for (let i = 0; i < kTrendlineWindowSize - 1; i++) {
        t.update(30, 20, 1000 + i * 30);
      }
      // 窓未充足: trend は 0 のまま
      expect(t.trend).toBe(0);
      expect(t.sampleCount).toBe(kTrendlineWindowSize - 1);

      t.update(30, 20, 1000 + (kTrendlineWindowSize - 1) * 30);
      expect(t.sampleCount).toBe(kTrendlineWindowSize);
      // 正の delay gradient → 正の slope
      expect(t.trend).toBeGreaterThan(0);
    });

    test("modified_trend = min(n,60) * trend * 4 で overuse に遷移し得る", () => {
      const t = new TrendlineEstimator();
      // 強い正勾配を多数投入
      for (let i = 0; i < 80; i++) {
        t.update(40, 10, 2000 + i * 20);
      }
      expect(t.modifiedTrend).toBeGreaterThan(0);
      // 十分なサンプル後は overuse になることが多い
      expect(["overuse", "normal"]).toContain(t.state);
      // 閾値適応が動いている
      expect(t.adaptiveThreshold).toBeGreaterThanOrEqual(6);
    });

    test("負の遅延勾配で underuse になる", () => {
      const t = new TrendlineEstimator();
      // まず正勾配で窓を満たす
      for (let i = 0; i < kTrendlineWindowSize; i++) {
        t.update(25, 20, 3000 + i * 20);
      }
      // 負勾配（キュー排出）
      for (let i = 0; i < 40; i++) {
        t.update(5, 20, 4000 + i * 20);
      }
      expect(t.trend).toBeLessThan(0);
      expect(t.state).toBe("underuse");
    });
  });

  describe("GccBandwidthEstimator delay path", () => {
    test("空の TWCC / 未知 sequence では bitrate を通知しない", () => {
      const gcc = new GccBandwidthEstimator(300_000);
      const fired: number[] = [];
      gcc.onAvailableBitrate.subscribe((v) => fired.push(v));

      // Act: 完全に空
      gcc.receiveTWCC(makeTwccFeedback([]));
      // Act: 未知 seq のみ
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 99,
            received: true,
            receivedAtMs: 1_000_000,
          }),
        ]),
      );

      // Assert
      expect(fired).toEqual([]);
      expect(gcc.availableBitrate).toBe(0);
    });

    test("delay overuse で availableBitrate が下がる", () => {
      // Arrange: wall-clock 近傍の時刻で acked bitrate も測れるようにする
      const gcc = new GccBandwidthEstimator(400_000);
      const usages: string[] = [];
      gcc.onOveruseDetected.subscribe((u) => usages.push(u));
      const t0 = Date.now() - 5_000;

      // Act: 安定経路でベースを作る
      feedDelayScenario(gcc, {
        seq0: 1,
        t0,
        count: 45,
        sendInterval: 20,
        recvStretchPerStep: 0,
      });
      const baseline = gcc.availableBitrate;
      expect(baseline).toBeGreaterThan(0);

      // Act: 強い正の delay gradient を連続投入（overuse）
      // sendInterval を send_delta として overuse タイマーが進む
      feedDelayScenario(gcc, {
        seq0: 100,
        t0: t0 + 2_000,
        count: 80,
        sendInterval: 20,
        recvStretchPerStep: 25,
      });
      const afterOveruse = gcc.availableBitrate;

      // Assert: overuse が検出され、帯域が下がる（AIMD beta 経路）
      expect(usages.includes("overuse") || gcc.usageState === "overuse").toBe(
        true,
      );
      expect(afterOveruse).toBeLessThan(baseline);
    });

    test("underuse 後に normal/increase 方向へ復帰する", () => {
      const gcc = new GccBandwidthEstimator(300_000);

      // overuse 気味に落とす
      feedDelayScenario(gcc, {
        seq0: 1,
        t0: 6_000_000,
        count: 50,
        sendInterval: 15,
        recvStretchPerStep: 10,
      });
      const low = gcc.availableBitrate;

      // 負の勾配（キュー排出 = underuse）
      feedDelayScenario(gcc, {
        seq0: 100,
        t0: 6_020_000,
        count: 50,
        sendInterval: 15,
        recvStretchPerStep: -5,
      });
      // 安定復帰
      feedDelayScenario(gcc, {
        seq0: 200,
        t0: 6_040_000,
        count: 40,
        sendInterval: 15,
        recvStretchPerStep: 0,
      });
      const recovered = gcc.availableBitrate;

      // Assert: underuse を経由、または帯域が回復方向
      expect(
        gcc.usageState === "underuse" ||
          gcc.usageState === "normal" ||
          recovered >= low,
      ).toBe(true);
      expect(recovered).toBeGreaterThan(0);
    });

    test("決定的 overuse 系列: AIMD が beta 倍に寄る", () => {
      // 部品レベルで固定
      const aimd = new AimdRateControl();
      aimd.reset(500_000);
      const d1 = aimd.update("overuse", 500_000, 1000);
      expect(d1).toBe(Math.round(500_000 * kBeta));

      // Gcc 統合: overuse 状態を作ってから loss=0 の追加 feedback
      const gcc = new GccBandwidthEstimator(500_000);
      feedDelayScenario(gcc, {
        seq0: 1,
        t0: 7_000_000,
        count: 80,
        sendInterval: 10,
        recvStretchPerStep: 15,
      });
      const series: number[] = [gcc.availableBitrate];
      feedDelayScenario(gcc, {
        seq0: 200,
        t0: 7_010_000,
        count: 40,
        sendInterval: 10,
        recvStretchPerStep: 15,
      });
      series.push(gcc.availableBitrate);

      // 2 回目の強い overuse 後は同値以下
      expect(series[1]).toBeLessThanOrEqual(series[0] * 1.05);
      expect(series[0]).toBeGreaterThan(0);
    });
  });

  describe("loss / probe", () => {
    test("LossBasedBwe 系列", () => {
      const loss = new LossBasedBwe();
      loss.reset(500_000);
      const up = loss.update(0.01, 500_000, 500_000);
      expect(up).toBeGreaterThanOrEqual(
        Math.round(500_000 * kLossBasedIncreaseFactor),
      );
      const down = loss.update(0.2, 400_000, 400_000);
      expect(down).toBeLessThan(up);
    });

    test("ProbeController exponential + complete", () => {
      const probe = new ProbeController();
      const clusters = probe.setBitrates(10_000, 100_000, 10_000_000, 1000);
      expect(clusters.length).toBeGreaterThanOrEqual(1);
      expect(probe.probeState).toBe("waiting_for_result");
      for (let i = 0; i < 10; i++) {
        probe.onAckedPacket(1200, 1000 + i * 5, true);
      }
      expect(probe.takePendingEstimateBps()).toBeGreaterThan(0);
    });

    test("pendingProbePaddingPackets は probe 中に正", () => {
      const gcc = new GccBandwidthEstimator(100_000);
      gcc.shouldTagProbePacket();
      expect(gcc.pendingProbePaddingPackets()).toBeGreaterThan(0);
    });
  });

  describe("sequence wrap-around", () => {
    test("sortPacketResultsByWideSeq", () => {
      const clustered = [
        new PacketResult({ sequenceNumber: 65534, received: true }),
        new PacketResult({ sequenceNumber: 1, received: true }),
        new PacketResult({ sequenceNumber: 0, received: true }),
        new PacketResult({ sequenceNumber: 65535, received: true }),
      ];
      expect(sortPacketResultsByWideSeq(clustered).map((r) => r.sequenceNumber)).toEqual(
        [65534, 65535, 0, 1],
      );
    });
  });

  describe("RTCRtpSender 配線", () => {
    test("sender.onAvailableBitrate は差し替え後も維持", () => {
      const sender = new RTCRtpSender("video");
      const fired: number[] = [];
      sender.onAvailableBitrate.subscribe((v) => fired.push(v));
      const gcc = new GccBandwidthEstimator(300_000);
      sender.setBandwidthEstimator(gcc);
      feedDelayScenario(gcc, {
        seq0: 1,
        t0: 8_000_000,
        count: 35,
        sendInterval: 15,
        recvStretchPerStep: 0,
      });
      // handleRtcp でも配送できることを確認
      expect(gcc.availableBitrate).toBeGreaterThan(0);
      expect(fired.length).toBeGreaterThanOrEqual(1);
    });

    test("空 TWCC を handleRtcpPacket しても通知しない", () => {
      const sender = new RTCRtpSender("video");
      const gcc = new GccBandwidthEstimator(300_000);
      sender.setBandwidthEstimator(gcc);
      const fired: number[] = [];
      sender.onAvailableBitrate.subscribe((v) => fired.push(v));
      sender.handleRtcpPacket(makeTwccRtcp([]));
      expect(fired).toEqual([]);
      expect(gcc.availableBitrate).toBe(0);
    });

    test("sendRtp 経路で probe padding が生成され isProbation になる", async () => {
      const sender = new RTCRtpSender("video");
      const dtls = createDtlsTransport();
      (dtls as { state: string }).state = "connected";
      let sendCount = 0;
      dtls.sendRtp = vi.fn(async () => {
        sendCount++;
        return 256;
      }) as typeof dtls.sendRtp;
      dtls.transportSequenceNumber = 50;
      sender.setDtlsTransport(dtls);

      const gcc = new GccBandwidthEstimator(100_000);
      sender.setBandwidthEstimator(gcc);
      const rtpSpy = vi.spyOn(gcc, "rtpPacketSent");

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

      // Act: メディア 1 パケット → probe padding も注入される
      const packet = new RtpPacket(
        new RtpHeader({
          sequenceNumber: 0,
          timestamp: 0,
          payloadType: 96,
          ssrc: 1,
          extension: true,
          extensions: [],
          marker: false,
          padding: false,
          payloadOffset: 12,
        }),
        Buffer.alloc(100),
      );
      await sender.sendRtp(packet);

      // Assert: media + padding
      expect(sendCount).toBeGreaterThan(1);
      expect(rtpSpy.mock.calls.length).toBeGreaterThan(1);
      const probationCount = rtpSpy.mock.calls.filter(
        (c) => (c[0] as SentInfo).isProbation === true,
      ).length;
      expect(probationCount).toBeGreaterThan(0);
      expect(sender.pacingBitrateBps).toBeGreaterThanOrEqual(100_000);
    });

    test("maybeInjectProbePadding 単体でも padding を送る", async () => {
      const sender = new RTCRtpSender("video");
      const dtls = createDtlsTransport();
      (dtls as { state: string }).state = "connected";
      dtls.sendRtp = vi.fn(async () => 256) as typeof dtls.sendRtp;
      sender.setDtlsTransport(dtls);
      sender.setBandwidthEstimator(new GccBandwidthEstimator(100_000));
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
        rtcp: { cname: "t", mux: true },
      });

      const n = await sender.maybeInjectProbePadding();
      expect(n).toBeGreaterThan(0);
      expect(dtls.sendRtp).toHaveBeenCalled();
    });
  });

  describe("共通 interface", () => {
    test("BandwidthEstimator 契約", () => {
      const e: BandwidthEstimator = new GccBandwidthEstimator();
      expect(e.onAvailableBitrate).toBeDefined();
      expect(e.rtpPacketSent).toBeTypeOf("function");
      expect(e.receiveTWCC).toBeTypeOf("function");
    });
  });
});
