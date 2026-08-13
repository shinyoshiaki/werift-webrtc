import { describe, expect, test, vi } from "vitest";
import type { Config } from "../../../rtp/src/srtp/session";
import { SrtpSession } from "../../../rtp/src/srtp/srtp";
import {
  AcknowledgedBitrateEstimator,
  AimdRateControl,
  AlrDetector,
  type BandwidthEstimator,
  GccBandwidthEstimator,
  InterArrivalDelta,
  LinkCapacityEstimator,
  LossBasedBwe,
  PacketResult,
  PacketStatus,
  ProbeController,
  type ProbePacingController,
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpSender,
  RecvDelta,
  RtcpPacketConverter,
  RtcpTransportLayerFeedback,
  RtpHeader,
  RtpPacket,
  RunLengthChunk,
  SenderBandwidthEstimator,
  type SentInfo,
  TWCC_REFERENCE_TIME_MOD,
  TWCC_REFERENCE_TIME_UNIT_MS,
  TransportWideCC,
  TransportWideSeqUnwrapper,
  TrendlineEstimator,
  TwccReferenceTimeUnwrapper,
  appendRfc3550Padding,
  getBandwidthLimitedCause,
  hasTwccReceiveTiming,
  isProbeInitiationAllowed,
  isProbePacingController,
  isRoundTripTimeConsumer,
  isRttAboveLimit,
  kAlrProbeScale,
  kAlrProbingIntervalMs,
  kBeta,
  kGoogCcProcessIntervalMs,
  kLossLimitedProbeScale,
  kMinBitrateBps,
  kProbeFractionAfterDrop,
  kProbePaddingPacketBytes,
  kRttBasedBackOffBandwidthFloorBps,
  kRttBasedBackOffDropFraction,
  kRttBasedBackOffDropIntervalMs,
  kRttBasedBackOffHighRttMs,
  kSendTimeHistoryWindowMs,
  kTrendlineWindowSize,
  maxProbeBitrateBps,
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

/**
 * Controllable sender clock for GCC tests that use synthetic send timelines.
 * Production uses milliTime; pin keeps send/feedback in one Timestamp domain.
 */
function createClockGcc(
  startBps: number,
  initialNow = 0,
  options?: { periodicAlrProbing?: boolean },
) {
  let nowMs = initialNow;
  const gcc = new GccBandwidthEstimator(startBps, {
    clock: () => nowMs,
    periodicAlrProbing: options?.periodicAlrProbing,
  });
  return {
    gcc,
    now: () => nowMs,
    setNow: (t: number) => {
      nowMs = t;
    },
    advanceTo: (t: number) => {
      nowMs = Math.max(nowMs, t);
    },
  };
}

function feedDelayScenario(
  gcc: GccBandwidthEstimator,
  opts: {
    seq0: number;
    t0: number;
    count: number;
    sendInterval: number;
    recvStretchPerStep: number;
    lossRatio?: number;
    baseOneWayMs?: number;
  },
  clock?: { advanceTo: (t: number) => void },
) {
  const {
    seq0,
    t0,
    count,
    sendInterval,
    recvStretchPerStep,
    lossRatio = 0,
    baseOneWayMs = 20,
  } = opts;
  for (let i = 0; i < count; i++) {
    gcc.rtpPacketSent(sent(seq0 + i, 1000, t0 + i * sendInterval));
  }
  let recv = t0 + baseOneWayMs;
  let lastEvent = t0;
  const results = Array.from({ length: count }, (_, i) => {
    const sendMs = t0 + i * sendInterval;
    const lost = lossRatio > 0 && i / count < lossRatio;
    if (!lost) {
      recv += sendInterval + recvStretchPerStep;
    }
    const recvMs = lost ? 0 : Math.max(recv, sendMs + 1);
    if (!lost) lastEvent = Math.max(lastEvent, recvMs, sendMs);
    else lastEvent = Math.max(lastEvent, sendMs);
    return new PacketResult({
      sequenceNumber: seq0 + i,
      received: !lost,
      receivedAtMs: recvMs,
    });
  });
  // feedback_time on sender clock just after last event (pin feedback_time).
  clock?.advanceTo(lastEvent + 1);
  gcc.receiveTWCC(makeTwccFeedback(results));
}

async function prepareConnectedSender(estimator?: BandwidthEstimator) {
  const sender = new RTCRtpSender("video");
  const dtls = createDtlsTransport();
  (dtls as { state: string }).state = "connected";
  const sentPackets: { header: RtpHeader; payload: Buffer; size: number }[] =
    [];
  dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
    // payload already includes RFC 3550 padding bytes when P=1.
    const size = payload.length + header.serializeSize;
    // Snapshot header fields — the same object is mutated across sends.
    sentPackets.push({
      header: new RtpHeader({ ...header, extensions: [...header.extensions] }),
      payload: Buffer.from(payload),
      size,
    });
    return size;
  }) as typeof dtls.sendRtp;
  dtls.transportSequenceNumber = 0;
  sender.setDtlsTransport(dtls);
  if (estimator) {
    sender.setBandwidthEstimator(estimator);
  }
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
  return { sender, dtls, sentPackets };
}

describe("media/sender bandwidth estimator", () => {
  describe("interface separation", () => {
    test("共通 BandwidthEstimator に probe API は含まれない", () => {
      // Arrange
      const legacy: BandwidthEstimator = new SenderBandwidthEstimator();
      const gcc = new GccBandwidthEstimator();

      // Assert: probe は type guard 経由
      expect(isProbePacingController(legacy)).toBe(false);
      expect(isProbePacingController(gcc)).toBe(true);
      const probe: ProbePacingController = gcc;
      expect(probe.getPacingBitrateBps()).toBeGreaterThan(0);
    });

    test("共通 BandwidthEstimator に setRoundTripTime は含まれない（capability 分離）", () => {
      // Arrange
      const legacy: BandwidthEstimator = new SenderBandwidthEstimator();
      const gcc = new GccBandwidthEstimator();

      // Assert: type-level — common に RTT 入力が無い
      type Forbidden = "setRoundTripTime";
      type Intersection = Extract<keyof BandwidthEstimator, Forbidden>;
      type AssertNoRtt = [Intersection] extends [never] ? true : false;
      const noRttOnCommon: AssertNoRtt = true;
      expect(noRttOnCommon).toBe(true);

      // runtime: RoundTripTimeConsumer は GCC のみ
      expect(isRoundTripTimeConsumer(legacy)).toBe(false);
      expect(isRoundTripTimeConsumer(gcc)).toBe(true);
      gcc.setRoundTripTime(42);
      expect((gcc as any).aimd.rtt).toBe(42);
    });

    test("共通 BandwidthEstimator に congestion API は含まれない（compile-time）", () => {
      // Arrange / Assert (type-level): congestion 系キーが共通 interface に無いこと
      type Forbidden =
        | "onCongestion"
        | "onCongestionScore"
        | "congestion"
        | "congestionScore";
      type Intersection = Extract<keyof BandwidthEstimator, Forbidden>;
      type AssertNoCongestion = [Intersection] extends [never] ? true : false;
      const noCongestionOnCommon: AssertNoCongestion = true;
      expect(noCongestionOnCommon).toBe(true);

      // runtime: 具象の固有イベントは共通型経由では触れない（代入は型エラー）
      const asCommon: BandwidthEstimator = new SenderBandwidthEstimator();
      expect(asCommon.availableBitrate).toBeDefined();
      expect(typeof asCommon.receiveTWCC).toBe("function");
      // 具象側には congestion があるが、共通契約外
      const legacy = new SenderBandwidthEstimator();
      expect(typeof legacy.onCongestion.subscribe).toBe("function");
    });

    test("senderBWE は getter のみで直接代入できない", () => {
      // Arrange
      const sender = new RTCRtpSender("audio");
      const gcc = new GccBandwidthEstimator();

      // Act
      sender.setBandwidthEstimator(gcc);

      // Assert
      expect(sender.senderBWE).toBe(gcc);
      // 公開 field ではない（代入しても型エラー; 実行時は getter のみ）
      expect(
        Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(sender),
          "senderBWE",
        )?.set,
      ).toBeUndefined();
    });
  });

  describe("legacy 合成 TWCC", () => {
    test("一定レートの合成 TWCC から availableBitrate が期待範囲になる", () => {
      // Arrange: 1000 byte / 10ms → 理論 800 kbps
      const bwe = new SenderBandwidthEstimator();
      const t0 = Date.now() - 2000;
      const n = 30;
      const size = 1000;
      const interval = 10;
      for (let i = 0; i < n; i++) {
        bwe.rtpPacketSent(sent(i + 1, size, t0 + i * interval));
      }
      const results = Array.from({ length: n }, (_, i) => {
        const sendMs = t0 + i * interval;
        return new PacketResult({
          sequenceNumber: i + 1,
          received: true,
          receivedAtMs: sendMs + 20,
        });
      });

      // Act
      bwe.receiveTWCC(makeTwccFeedback(results));

      // Assert: min(send, recv) 近傍（許容幅広め）
      expect(bwe.availableBitrate).toBeGreaterThan(200_000);
      expect(bwe.availableBitrate).toBeLessThan(2_000_000);
      // 理論 800kbps の 0.4〜1.6 倍
      expect(bwe.availableBitrate).toBeGreaterThan(320_000);
      expect(bwe.availableBitrate).toBeLessThan(1_280_000);
    });

    test("変化時のみ onAvailableBitrate", () => {
      const bwe = new SenderBandwidthEstimator();
      const fired: number[] = [];
      bwe.onAvailableBitrate.subscribe((v) => fired.push(v));
      bwe.availableBitrate = 100_000;
      bwe.availableBitrate = 100_000;
      bwe.availableBitrate = 200_000;
      expect(fired).toEqual([100_000, 200_000]);
    });
  });

  describe("acked bitrate (TWCC 相対時刻)", () => {
    test("TWCC 受信時刻が壁時計と大きくずれても acked bitrate > 0 になる", () => {
      // Arrange: TWCC receivedAtMs は referenceTime 由来で壁時計と無関係。
      // send / feedback は injectable clock で同一 domain（pin Timestamp）。
      const twccRecvBase = 50_000;
      const { gcc, advanceTo } = createClockGcc(300_000, twccRecvBase);
      const n = 40;
      const size = 1200;
      const interval = 20;
      for (let i = 0; i < n; i++) {
        // 送信時刻も相対的でよい（inter-arrival 用）
        gcc.rtpPacketSent(sent(i + 1, size, twccRecvBase + i * interval));
      }
      const results = Array.from(
        { length: n },
        (_, i) =>
          new PacketResult({
            sequenceNumber: i + 1,
            received: true,
            receivedAtMs: twccRecvBase + i * interval + 5,
          }),
      );

      // Act
      const fired: number[] = [];
      gcc.onAvailableBitrate.subscribe((v) => fired.push(v));
      advanceTo(twccRecvBase + n * interval + 10);
      gcc.receiveTWCC(makeTwccFeedback(results));

      // Assert: 壁時計比較バグなら available が 0 のまま / AIMD が異常
      expect(fired.length).toBeGreaterThanOrEqual(1);
      expect(gcc.availableBitrate).toBeGreaterThan(0);
      // 1200B / 20ms → 480 kbps オーダー
      expect(gcc.availableBitrate).toBeGreaterThan(50_000);
    });
  });

  describe("legacy pacing 非適用", () => {
    test("legacy estimator では sendRtp が pacing で遅延しない", async () => {
      // Arrange: デフォルト legacy
      const { sender } = await prepareConnectedSender();
      expect(isProbePacingController(sender.senderBWE)).toBe(false);

      const t0 = performance.now();
      for (let i = 0; i < 20; i++) {
        await sender.sendRtp(
          new RtpPacket(
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
            Buffer.alloc(1200),
          ),
        );
      }
      const elapsed = performance.now() - t0;

      // Assert: token-bucket があれば数百 ms かかるが、legacy は即時
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe("wire TWCC fixture", () => {
    test("serialize/deserialize した実 TWCC で GCC が更新される", () => {
      // Arrange: rtp パッケージの既知ワイヤ（example1, RunLength）を round-trip
      const wire = Buffer.from([
        0xaf, 0xcd, 0x0, 0x5, 0xfa, 0x17, 0xfa, 0x17, 0x43, 0x3, 0x2f, 0xa0,
        0x0, 0x99, 0x0, 0x1, 0x3d, 0xe8, 0x2, 0x17, 0x20, 0x1, 0x94, 0x1,
      ]);
      const [rtpfb] = RtcpPacketConverter.deSerialize(wire) as [
        RtcpTransportLayerFeedback,
      ];
      const twcc = rtpfb.feedback as TransportWideCC;
      expect(rtpfb.serialize()).toEqual(wire);

      // 同一内容を再シリアライズ → 再パース
      const wire2 = rtpfb.serialize();
      const [rtpfb2] = RtcpPacketConverter.deSerialize(wire2) as [
        RtcpTransportLayerFeedback,
      ];
      const restored = rtpfb2.feedback as TransportWideCC;
      expect(restored.baseSequenceNumber).toBe(twcc.baseSequenceNumber);
      expect(restored.packetResults.length).toBeGreaterThan(0);

      // Act: wire 復元 TWCC + 追加の相対時刻バッチで GCC を更新
      // （example1 は 1 パケットのため、実時間線のバッチを同経路で合成）
      const gcc = new GccBandwidthEstimator(300_000);
      const baseSeq = restored.baseSequenceNumber;
      // first packet from wire fixture
      for (const r of restored.packetResults) {
        if (r.received) {
          gcc.rtpPacketSent(sent(r.sequenceNumber, 1000, 40_000));
        }
      }
      gcc.receiveTWCC(restored);

      // multi-packet relative-time batch (also via TransportWideCC instance)
      const n = 30;
      const batch = new TransportWideCC({
        senderSsrc: twcc.senderSsrc,
        mediaSourceSsrc: twcc.mediaSourceSsrc,
        baseSequenceNumber: baseSeq + 10,
        packetStatusCount: n,
        referenceTime: twcc.referenceTime + 10,
        fbPktCount: (twcc.fbPktCount + 1) & 0xff,
      });
      const batchResults = Array.from(
        { length: n },
        (_, i) =>
          new PacketResult({
            sequenceNumber: baseSeq + 10 + i,
            received: true,
            receivedAtMs: Number(BigInt(batch.referenceTime) * 64n) + i * 15,
          }),
      );
      Object.defineProperty(batch, "packetResults", {
        get: () => batchResults,
      });
      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(sent(baseSeq + 10 + i, 1000, 40_000 + 100 + i * 15));
      }
      gcc.receiveTWCC(batch);

      // Assert: wire round-trip 成功 + 相対時刻バッチで推定 > 0
      expect(gcc.availableBitrate).toBeGreaterThan(0);
    });
  });

  describe("GccBandwidthEstimator loss 統合", () => {
    test("高損失 TWCC で availableBitrate が下がる", () => {
      // Arrange: synthetic clock で RTT high にならないよう send/feedback を揃える
      const t0 = 1_000;
      const { gcc, advanceTo } = createClockGcc(500_000, t0);
      const clock = { advanceTo };

      // Act: 無損失でベース
      feedDelayScenario(
        gcc,
        {
          seq0: 1,
          t0,
          count: 40,
          sendInterval: 15,
          recvStretchPerStep: 0,
          lossRatio: 0,
        },
        clock,
      );
      feedDelayScenario(
        gcc,
        {
          seq0: 50,
          t0: t0 + 1000,
          count: 40,
          sendInterval: 15,
          recvStretchPerStep: 0,
          lossRatio: 0,
        },
        clock,
      );
      const lowLoss = gcc.availableBitrate;
      expect(lowLoss).toBeGreaterThan(0);

      // Act: 40% loss
      feedDelayScenario(
        gcc,
        {
          seq0: 100,
          t0: t0 + 2000,
          count: 50,
          sendInterval: 15,
          recvStretchPerStep: 0,
          lossRatio: 0.4,
        },
        clock,
      );
      feedDelayScenario(
        gcc,
        {
          seq0: 160,
          t0: t0 + 3000,
          count: 50,
          sendInterval: 15,
          recvStretchPerStep: 0,
          lossRatio: 0.4,
        },
        clock,
      );
      const highLoss = gcc.availableBitrate;

      // Assert
      expect(highLoss).toBeLessThan(lowLoss);
    });

    test("決定的入力での bitrate 系列（制御応答の形状回帰）", () => {
      // Arrange: 壁時計に依存しない固定 send/recv タイムライン + injectable clock
      // 参照ベクトル（許容幅）: 形状 + 粗いレンジで libwebrtc 完全一致は非ゴール
      const start = 400_000;
      const t0 = 1_000_000; // fixed epoch ms
      const { gcc, advanceTo } = createClockGcc(start, t0);
      const clock = { advanceTo };
      const series: number[] = [];
      const record = () => {
        if (gcc.availableBitrate > 0) series.push(gcc.availableBitrate);
      };

      // Act phase 1: 安定・無損失・一定遅延 → 推定が立つ
      for (let b = 0; b < 3; b++) {
        feedDelayScenario(
          gcc,
          {
            seq0: 1 + b * 40,
            t0: t0 + b * 800,
            count: 40,
            sendInterval: 20,
            recvStretchPerStep: 0,
            lossRatio: 0,
          },
          clock,
        );
        record();
      }
      // Assert 1: 安定期は正の推定（400kbps スタート近傍〜数 Mbps 探索帯）
      expect(series.length).toBeGreaterThanOrEqual(1);
      const steady = series[series.length - 1];
      expect(steady).toBeGreaterThan(50_000);
      expect(steady).toBeLessThan(10_000_000);

      // Act phase 2: 遅延勾配で overuse → 推定が下がる方向
      feedDelayScenario(
        gcc,
        {
          seq0: 200,
          t0: t0 + 3_000,
          count: 80,
          sendInterval: 20,
          recvStretchPerStep: 25,
          lossRatio: 0,
        },
        clock,
      );
      record();
      const afterDelay = series[series.length - 1];

      // Act phase 3: 高損失 → さらに下がる（または維持）方向
      feedDelayScenario(
        gcc,
        {
          seq0: 300,
          t0: t0 + 5_000,
          count: 60,
          sendInterval: 20,
          recvStretchPerStep: 0,
          lossRatio: 0.35,
        },
        clock,
      );
      feedDelayScenario(
        gcc,
        {
          seq0: 400,
          t0: t0 + 6_500,
          count: 60,
          sendInterval: 20,
          recvStretchPerStep: 0,
          lossRatio: 0.35,
        },
        clock,
      );
      record();
      const afterLoss = series[series.length - 1];

      // Assert: 決定的系列の期待形状 + 許容レンジ
      // 日本語: 遅延 overuse 後は安定期を大きく超えない
      expect(afterDelay).toBeLessThanOrEqual(steady * 1.15);
      // 日本語: 高損失後は安定期より明確に下がる
      expect(afterLoss).toBeLessThan(steady);
      // pin complete_time は last arrival なので overuse 窓のあと無遅延ロス窓で
      // わずかに戻ることがある。安定期より低く、delay 期の +15% 以内なら形状一致。
      expect(afterLoss).toBeLessThanOrEqual(afterDelay * 1.15);
      // 日本語: ゼロ張り付きや異常な上限跳躍がない
      expect(afterLoss).toBeGreaterThanOrEqual(10_000);
      expect(afterLoss).toBeLessThan(5_000_000);
      expect(Math.max(...series)).toBeLessThan(50_000_000);
      // 日本語: 最終推定は損失反映後も正で、安定期を超えて再膨張していない
      expect(series[series.length - 1]).toBe(afterLoss);
      expect(series[series.length - 1]).toBeLessThanOrEqual(steady);
      // 日本語: 系列長は phase 記録回数と一致（決定的入力の再現性）
      expect(series.length).toBeGreaterThanOrEqual(5);
    });

    test("LossBasedBwe 観測窓 + Newton で高損失時に帯域が下がる", () => {
      // Arrange: 250ms 下限で observation を commit し、min 3 件まで readiness
      // firstSendMs / lastSendMs は実際の send timeline
      const loss = new LossBasedBwe();
      loss.reset(500_000);
      for (let i = 0; i < 5; i++) {
        const first = 1000 + i * 300;
        const last = first + 300;
        loss.update(0.0, 500_000, 480_000, 30, 0, first, 18_000, last, 0);
      }
      expect(loss.observationCount).toBeGreaterThanOrEqual(3);
      const up = loss.targetBitrateBps;

      // Act: 高損失 + 低い acked + 低い delay-based（容量低下を反映）
      for (let i = 0; i < 12; i++) {
        const first = 3000 + i * 300;
        const last = first + 300;
        // 50% byte loss: 12_000 bytes of which 6_000 lost
        loss.update(0.5, 180_000, 120_000, 40, 20, first, 12_000, last, 6_000);
      }

      // Assert: 損失観測が反映され推定が下がる
      expect(loss.averageLossRatio).toBeGreaterThan(0.2);
      expect(loss.observationCount).toBeGreaterThanOrEqual(8);
      expect(loss.targetBitrateBps).toBeLessThan(up);
      expect(loss.targetBitrateBps).toBeLessThanOrEqual(250_000);
    });

    test("LossBasedBwe HOLD は初回 300ms・次回用に duration を倍化（libwebrtc 順）", () => {
      // Arrange
      const loss = new LossBasedBwe();
      loss.reset(500_000);
      (loss as any).delayBasedBps = 500_000;
      // Act: updateState で decrease に入る（prev > next）
      (loss as any).updateState(500_000, 200_000, 5_000);
      // Assert: holdUntil = now + 300（先に使う）、duration は次回用 600
      expect((loss as any).holdUntilMs).toBe(5_000 + 300);
      expect((loss as any).holdDurationMs).toBe(600);
      expect((loss as any).holdRateBps).toBe(200_000);
      // 2 回目 decrease: holdUntil = now + 600、duration → 1200
      (loss as any).updateState(200_000, 100_000, 6_000);
      expect((loss as any).holdUntilMs).toBe(6_000 + 600);
      expect((loss as any).holdDurationMs).toBe(1_200);
    });

    test("LossBasedBwe HOLD は複数 update にわたり holdRate を超えない", () => {
      // Arrange: ready observations then force HOLD window (decreasing + timer)
      const loss = new LossBasedBwe();
      loss.reset(500_000);
      for (let i = 0; i < 4; i++) {
        const first = 1000 + i * 300;
        loss.update(
          0.0,
          500_000,
          480_000,
          30,
          0,
          first,
          18_000,
          first + 300,
          0,
        );
      }
      (loss as any).delayBasedBps = 500_000;
      (loss as any).state = "decreasing";
      (loss as any).holdUntilMs = 10_000 + 300; // expires at t=10300
      (loss as any).holdRateBps = 200_000;
      (loss as any).current.lossLimitedBandwidthBps = 200_000;
      (loss as any).lastSendTimeMostRecentObservation = 10_000;

      // Act: HOLD 内の複数 update（高損失で候補が holdRate 近傍に留まる）
      // lastSend < holdUntil → guard 継続、state は decreasing のまま
      const t1 = loss.update(
        0.35,
        500_000,
        180_000,
        40,
        14,
        10_050,
        16_000,
        10_100,
        10_000,
      );
      expect((loss as any).state).toBe("decreasing");
      expect(t1).toBeLessThanOrEqual(200_000);

      const t2 = loss.update(
        0.35,
        500_000,
        190_000,
        40,
        14,
        10_150,
        16_000,
        10_200,
        10_000,
      );
      expect((loss as any).state).toBe("decreasing");
      expect(t2).toBeLessThanOrEqual(200_000);

      // Act: HOLD 期限後（lastSend > holdUntil）は guard を抜けられる
      const t3 = loss.update(
        0.0,
        500_000,
        400_000,
        30,
        0,
        10_350,
        12_000,
        10_400,
        0,
      );
      // 期限後は holdRate 上限を超え得る（厳密値は candidate 依存）
      expect(t3).toBeGreaterThan(0);
    });

    test("LossBasedBwe は 250ms×3 観測まで delay-based を返す（cap しない）", () => {
      // Arrange
      const loss = new LossBasedBwe();
      loss.reset(300_000);

      // Act: send span が 250ms 未満なので commit されない
      // delayBased=450kbps, start/current loss=300kbps → not ready では delay を返す
      const out = loss.update(
        0.0,
        450_000,
        400_000,
        20,
        0,
        1000,
        10_000,
        1100,
        0,
      );
      // Assert: readiness 未満 → delay-based（300 で cap しない）
      expect(loss.observationCount).toBe(0);
      expect(out).toBe(450_000);
      expect(loss.lossState).toBe("delay_based");

      // Act: 300ms span を 3 回 → 3 observations
      for (let i = 0; i < 3; i++) {
        const first = 2000 + i * 300;
        loss.update(
          0.0,
          400_000,
          380_000,
          30,
          0,
          first,
          15_000,
          first + 300,
          0,
        );
      }
      expect(loss.observationCount).toBeGreaterThanOrEqual(3);
    });

    test("LossBasedBwe byte-loss は大パケット損失を重く見る", () => {
      // Arrange: 同じ 10% packet loss でも lost bytes が異なる
      const bigLoss = new LossBasedBwe();
      bigLoss.reset(500_000);
      const smallLoss = new LossBasedBwe();
      smallLoss.reset(500_000);

      // Warm-up observations (no loss)
      for (let i = 0; i < 4; i++) {
        const f = 1000 + i * 300;
        bigLoss.update(0, 500_000, 480_000, 30, 0, f, 20_000, f + 300, 0);
        smallLoss.update(0, 500_000, 480_000, 30, 0, f, 20_000, f + 300, 0);
      }

      // Act: 10 packets, 1 lost — big: 1200B lost of ~2100B total ≈ 57% byte loss
      // small: 100B lost of ~10900B ≈ 1% byte loss
      for (let i = 0; i < 8; i++) {
        const f = 3000 + i * 300;
        // big loss: 1×1200 lost + 9×100 received = 2100 total, 1200 lost
        bigLoss.update(0.1, 200_000, 150_000, 10, 1, f, 2100, f + 300, 1200);
        // small loss: 1×100 lost + 9×1200 received = 10900 total, 100 lost
        smallLoss.update(0.1, 200_000, 150_000, 10, 1, f, 10900, f + 300, 100);
      }

      // Assert: byte-loss mode では大パケット損失の方が強い抑制
      expect(bigLoss.averageLossRatio).toBeGreaterThan(
        smallLoss.averageLossRatio,
      );
      expect(bigLoss.targetBitrateBps).toBeLessThanOrEqual(
        smallLoss.targetBitrateBps,
      );
    });
  });

  describe("Gcc delay / empty", () => {
    test("空 TWCC では通知しない", () => {
      const gcc = new GccBandwidthEstimator(300_000);
      const fired: number[] = [];
      gcc.onAvailableBitrate.subscribe((v) => fired.push(v));
      gcc.receiveTWCC(makeTwccFeedback([]));
      expect(fired).toEqual([]);
      expect(gcc.availableBitrate).toBe(0);
    });

    test("delay overuse で帯域低下", () => {
      const gcc = new GccBandwidthEstimator(400_000);
      const usages: string[] = [];
      gcc.onOveruseDetected.subscribe((u) => usages.push(u));
      const t0 = Date.now() - 5_000;
      feedDelayScenario(gcc, {
        seq0: 1,
        t0,
        count: 45,
        sendInterval: 20,
        recvStretchPerStep: 0,
      });
      const baseline = gcc.availableBitrate;
      feedDelayScenario(gcc, {
        seq0: 100,
        t0: t0 + 2000,
        count: 80,
        sendInterval: 20,
        recvStretchPerStep: 25,
      });
      expect(usages.includes("overuse") || gcc.usageState === "overuse").toBe(
        true,
      );
      expect(gcc.availableBitrate).toBeLessThan(baseline);
    });
  });

  describe("Trendline", () => {
    test("窓満杯まで slope 未更新", () => {
      const t = new TrendlineEstimator();
      for (let i = 0; i < kTrendlineWindowSize - 1; i++) {
        t.update(30, 20, 1000 + i * 30);
      }
      expect(t.trend).toBe(0);
      t.update(30, 20, 1000 + kTrendlineWindowSize * 30);
      expect(t.trend).toBeGreaterThan(0);
    });
  });

  describe("Probe 成功・失敗・再 probe", () => {
    test("probe ACK 後に availableBitrate が初期値より上昇する", () => {
      // Arrange: 購読は ensureProbing より前
      const start = 100_000;
      const gcc = new GccBandwidthEstimator(start);
      const clusters: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => clusters.push(c.targetBps));
      expect(gcc.shouldTagProbePacket()).toBe(true);
      // FIFO: pacing target / activate event is front=3x only
      expect(gcc.suggestedProbeBitrateBps).toBe(start * 3);
      expect(clusters).toEqual([start * 3]);

      // Act: 高レートで probation パケットを送受信（cluster 完了）
      const n = 20;
      const base = 8_000;
      const size = 1400;
      const interval = 2; // 高 bitrate 探索
      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(
          sent(i + 1, size, base + i * interval, { isProbation: true }),
        );
      }
      const results = Array.from({ length: n }, (_, i) => {
        const sendMs = base + i * interval;
        return new PacketResult({
          sequenceNumber: i + 1,
          received: true,
          receivedAtMs: sendMs + 3 + i * interval,
        });
      });
      gcc.receiveTWCC(makeTwccFeedback(results));

      // Assert: 初期 exponential は target×1.5 に縛られず探索的に上昇する
      expect(gcc.availableBitrate).toBeGreaterThan(start);
      expect(gcc.availableBitrate).toBeGreaterThanOrEqual(start * 1.5);
      // 理論: 1400B / 2ms ≈ 5.6 Mbps オーダー（acked soft ceiling あり）
      expect(gcc.availableBitrate).toBeGreaterThan(200_000);
    });

    test("probe 成功後に further probe または complete へ遷移する", () => {
      // Arrange: subscribe before ensureProbing so initial 3x/6x are observed
      const gcc = new GccBandwidthEstimator(100_000);
      const clusters: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => clusters.push(c.targetBps));
      gcc.shouldTagProbePacket();

      const runProbe = (seq0: number, t0: number, n: number) => {
        for (let i = 0; i < n; i++) {
          gcc.rtpPacketSent(
            sent(seq0 + i, 1200, t0 + i * 2, { isProbation: true }),
          );
        }
        gcc.receiveTWCC(
          makeTwccFeedback(
            Array.from({ length: n }, (_, i) => {
              const sendMs = t0 + i * 2;
              return new PacketResult({
                sequenceNumber: seq0 + i,
                received: true,
                receivedAtMs: sendMs + 2 + i * 2,
              });
            }),
          ),
        );
      };

      // Act: 初回 front cluster (3x) 完了 → FIFO で 6x が active に
      runProbe(1, 9_000, 15);
      const afterFirst = gcc.availableBitrate;
      expect(afterFirst).toBeGreaterThan(100_000);

      // 2nd cluster (6x) を消化
      if (
        gcc.probeState === "waiting_for_result" ||
        gcc.shouldTagProbePacket()
      ) {
        runProbe(100, 9_500, 15);
      }
      const afterSecond = gcc.availableBitrate;

      // Assert: FIFO 3x→6x 完了後も推定はスタートを上回り、state が進行
      expect(afterFirst).toBeGreaterThan(100_000);
      expect(afterSecond).toBeGreaterThan(100_000);
      expect(["complete", "waiting_for_result"]).toContain(gcc.probeState);
      // activate イベントは 3x の後、送信完了で 6x（重複なし）
      expect(clusters[0]).toBe(100_000 * 3);
      expect(
        clusters.filter((b) => b === 100_000 * 6).length,
      ).toBeLessThanOrEqual(1);
    });

    test("probe 失敗（未 ACK）では推定がスタート付近のまま", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      gcc.shouldTagProbePacket();
      const fired: number[] = [];
      gcc.onAvailableBitrate.subscribe((v) => fired.push(v));

      // Act: 送信だけして TWCC を返さない / 未知 seq のみ
      for (let i = 0; i < 10; i++) {
        gcc.rtpPacketSent(
          sent(i + 1, 1200, 10_000 + i * 2, { isProbation: true }),
        );
      }
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 9999,
            received: true,
            receivedAtMs: 11_000,
          }),
        ]),
      );

      // Assert: 有効サンプルなし → 通知なし
      expect(fired).toEqual([]);
      expect(gcc.availableBitrate).toBe(0);
    });

    test("大きな probe cluster でも padding が完遂できる", async () => {
      // Arrange: 高 start → 3x probe target が大きく、minBytes が maxBurst を超える
      const gcc = new GccBandwidthEstimator(1_000_000);
      const { sender } = await prepareConnectedSender(gcc);
      // Act
      const n = await sender.maybeInjectProbePadding();
      // Assert: 単一 maxBurst では足りず、外側ループで完遂する
      expect(n).toBeGreaterThan(16);
      expect(gcc.pendingProbePaddingPackets()).toBe(0);
    });
  });

  describe("Probe padding 品質", () => {
    test("padding bit・実 padding bytes・一意 sequence", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, sentPackets } = await prepareConnectedSender(gcc);
      const rtpSpy = vi.spyOn(gcc, "rtpPacketSent");

      // Act: メディア 1 + probe padding
      await sender.sendRtp(
        new RtpPacket(
          new RtpHeader({
            sequenceNumber: 10,
            timestamp: 1000,
            payloadType: 96,
            ssrc: 1,
            extension: true,
            extensions: [],
            marker: false,
            padding: false,
            payloadOffset: 12,
          }),
          Buffer.alloc(80),
        ),
      );

      // Assert: 複数送信
      expect(sentPackets.length).toBeGreaterThan(1);

      // padding パケット: P-bit + payload 末尾が RFC 3550 padding
      const padPackets = sentPackets.filter((p) => p.header.padding);
      expect(padPackets.length).toBeGreaterThan(0);
      for (const p of padPackets) {
        expect(p.header.padding).toBe(true);
        expect(p.header.paddingSize).toBe(kProbePaddingPacketBytes);
        // 実 payload に padding が含まれる
        expect(p.payload.length).toBe(kProbePaddingPacketBytes);
        expect(p.payload[p.payload.length - 1]).toBe(kProbePaddingPacketBytes);
        // メディア部なし（ゼロ埋め + 末尾 length）
        expect(p.payload.subarray(0, -1).every((b) => b === 0)).toBe(true);
        // フル RTP を再パース可能
        const wire = new RtpPacket(p.header, p.payload).serialize();
        const parsed = RtpPacket.deSerialize(wire);
        expect(parsed.header.padding).toBe(true);
        expect(parsed.header.paddingSize).toBe(kProbePaddingPacketBytes);
      }

      // SentInfo.size は実送信サイズ（モック戻り値）と一致
      // メディアも probe 中は isProbation になり得るため、padding パケットのみ照合
      expect(padPackets.length).toBeGreaterThan(0);
      const sentInfos = rtpSpy.mock.calls.map((c) => c[0] as SentInfo);
      const padSizes = sentInfos
        .filter((s) => s.size >= kProbePaddingPacketBytes)
        .map((s) => s.size);
      expect(padSizes.length).toBeGreaterThan(0);
      for (const p of padPackets) {
        expect(padSizes).toContain(p.size);
      }

      // RTP sequence が一意かつ単調増加
      const seqs = sentPackets.map((p) => p.header.sequenceNumber);
      expect(new Set(seqs).size).toBe(seqs.length);
      for (let i = 1; i < seqs.length; i++) {
        expect(uint16Forward(seqs[i - 1], seqs[i])).toBe(true);
      }
    });

    test("maybeInjectProbePadding が専用経路で padding を送る", async () => {
      const { sender, sentPackets } = await prepareConnectedSender(
        new GccBandwidthEstimator(100_000),
      );
      const n = await sender.maybeInjectProbePadding();
      expect(n).toBeGreaterThan(0);
      expect(sentPackets.every((p) => p.header.padding)).toBe(true);
      for (const p of sentPackets) {
        expect(p.payload.length).toBe(kProbePaddingPacketBytes);
        expect(p.payload[p.payload.length - 1]).toBe(kProbePaddingPacketBytes);
      }
      const seqs = sentPackets.map((p) => p.header.sequenceNumber);
      expect(new Set(seqs).size).toBe(seqs.length);
    });

    test("SRTP encrypt/decrypt を通した probe padding が復元できる", () => {
      // Arrange: 実 SRTP セッション（モック transport なし）
      const config: Config = {
        profile: 0x0001,
        keys: {
          localMasterKey: Buffer.from([
            0xe1, 0xf9, 0x7a, 0x0d, 0x3e, 0x01, 0x8b, 0xe0, 0xd6, 0x4f, 0xa3,
            0x2c, 0x06, 0xde, 0x41, 0x39,
          ]),
          localMasterSalt: Buffer.from([
            0x0e, 0xc6, 0x75, 0xad, 0x49, 0x8a, 0xfe, 0xeb, 0xb6, 0x96, 0x0b,
            0x3a, 0xab, 0xe6,
          ]),
          remoteMasterKey: Buffer.from([
            0xe1, 0xf9, 0x7a, 0x0d, 0x3e, 0x01, 0x8b, 0xe0, 0xd6, 0x4f, 0xa3,
            0x2c, 0x06, 0xde, 0x41, 0x39,
          ]),
          remoteMasterSalt: Buffer.from([
            0x0e, 0xc6, 0x75, 0xad, 0x49, 0x8a, 0xfe, 0xeb, 0xb6, 0x96, 0x0b,
            0x3a, 0xab, 0xe6,
          ]),
        },
      };
      const senderSrtp = new SrtpSession(config);
      const receiverSrtp = new SrtpSession(config);

      const padSize = kProbePaddingPacketBytes;
      const header = new RtpHeader({
        version: 2,
        padding: true,
        paddingSize: padSize,
        sequenceNumber: 42,
        timestamp: 90000,
        ssrc: 0x12345678,
        payloadType: 96,
        marker: false,
        extension: false,
      });
      // Act: RFC 3550 padding を payload に付加して encrypt
      const plainPayload = appendRfc3550Padding(Buffer.alloc(0), padSize);
      expect(plainPayload.length).toBe(padSize);
      expect(plainPayload[padSize - 1]).toBe(padSize);

      const encrypted = senderSrtp.encrypt(plainPayload, header);
      // 暗号文長 = header + payload(with pad) + auth tag (> payload)
      expect(encrypted.length).toBeGreaterThan(plainPayload.length + 12);

      // Act: decrypt → RTP として解釈
      const decrypted = receiverSrtp.decrypt(encrypted);
      const rtp = RtpPacket.deSerialize(decrypted);

      // Assert
      expect(rtp.header.padding).toBe(true);
      expect(rtp.header.paddingSize).toBe(padSize);
      expect(rtp.header.sequenceNumber).toBe(42);
      expect(rtp.header.ssrc).toBe(0x12345678);
      // deSerialize は padding を除いた media payload を返す（空）
      expect(rtp.payload.length).toBe(0);
      // 復号バッファ末尾は padding length byte
      expect(decrypted[decrypted.length - 1]).toBe(padSize);
    });

    test("SentInfo.size は実送 payload（padding 含む）と一致する", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      const sizes: number[] = [];
      const payloads: Buffer[] = [];
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        payloads.push(Buffer.from(payload));
        // 実 DTLS 経路と同様、送信バイト数を返す
        const n = payload.length + header.serializeSize;
        sizes.push(n);
        return n;
      }) as typeof dtls.sendRtp;

      const spy = vi.spyOn(gcc, "rtpPacketSent");
      await sender.maybeInjectProbePadding();

      // Assert
      const padCalls = spy.mock.calls
        .map((c) => c[0] as SentInfo)
        .filter((s) => s.isProbation);
      expect(padCalls.length).toBeGreaterThan(0);
      expect(payloads.length).toBe(padCalls.length);
      for (let i = 0; i < padCalls.length; i++) {
        expect(payloads[i].length).toBe(kProbePaddingPacketBytes);
        expect(payloads[i][payloads[i].length - 1]).toBe(
          kProbePaddingPacketBytes,
        );
        expect(padCalls[i].size).toBe(sizes[i]);
      }
    });

    test("並行 sendRtp でも SentInfo.wideSeq が重複しない", async () => {
      // Arrange: 遅延する transport で 2 件を並行送信
      // 旧実装は await 後に共有カウンタを読み直し [2,2] になっていた
      const gcc = new GccBandwidthEstimator(100_000);
      // 初期 probe を止めて isProbation 注入を避ける
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probingConfigured = true;

      const { sender, dtls } = await prepareConnectedSender(gcc);
      const gates: Array<() => void> = [];
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return payload.length + header.serializeSize;
      }) as typeof dtls.sendRtp;

      const wideSeqs: number[] = [];
      const orig = gcc.rtpPacketSent.bind(gcc);
      gcc.rtpPacketSent = (info: SentInfo) => {
        wideSeqs.push(info.wideSeq);
        orig(info);
      };

      const mk = (seq: number) =>
        new RtpPacket(
          new RtpHeader({
            sequenceNumber: seq,
            timestamp: seq * 1000,
            payloadType: 96,
            ssrc: 1,
            extension: true,
            extensions: [],
            marker: false,
            padding: false,
            payloadOffset: 12,
          }),
          Buffer.alloc(80),
        );

      // Act: 2 件を並行起動 → 両方 await 中に両 gate を解放
      const p1 = sender.sendRtp(mk(1));
      const p2 = sender.sendRtp(mk(2));
      // 両方が sendRtp に入るまで待つ
      for (let i = 0; i < 50 && gates.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 1));
      }
      expect(gates.length).toBe(2);
      for (const release of gates) {
        release();
      }
      await Promise.all([p1, p2]);

      // Assert: wire TWCC は 1,2 — estimator 入力も [1,2]（重複なし）
      expect(wideSeqs).toEqual([1, 2]);
      expect(new Set(wideSeqs).size).toBe(2);
    });
  });

  describe("sendRtp → handleRtcpPacket 決定的系列", () => {
    test("差し替え後 TWCC が新 estimator に渡り帯域が更新される", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(300_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      const fired: number[] = [];
      sender.onAvailableBitrate.subscribe((v) => fired.push(v));

      // Act: 複数 sendRtp（probe padding 含む）
      for (let i = 0; i < 15; i++) {
        await sender.sendRtp(
          new RtpPacket(
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
            Buffer.alloc(500),
          ),
        );
      }

      // 記録された sentInfos 相当: rtpPacketSent から wideSeq を復元
      // TWCC は transport sequence を使う — dtls の現在値から遡る
      const lastWide = dtls.transportSequenceNumber;
      // 直近 40 パケット分を受信済みとして返す
      const count = Math.min(40, lastWide);
      const base = Date.now() - 1000;
      const results = Array.from({ length: count }, (_, i) => {
        const seq = lastWide - count + 1 + i;
        return new PacketResult({
          sequenceNumber: seq & 0xffff,
          received: true,
          receivedAtMs: base + i * 15,
        });
      });

      // Act: handleRtcpPacket 経路
      sender.handleRtcpPacket(makeTwccRtcp(results));

      // Assert
      expect(sender.senderBWE).toBe(gcc);
      expect(gcc.availableBitrate).toBeGreaterThan(0);
      expect(fired.length).toBeGreaterThanOrEqual(1);
      expect(fired.at(-1)).toBe(gcc.availableBitrate);
    });

    test("loss 系列を sendRtp/TWCC 経路で再現できる", async () => {
      const gcc = new GccBandwidthEstimator(400_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);

      const pushBatch = async (n: number, lossRatio: number, tBase: number) => {
        for (let i = 0; i < n; i++) {
          await sender.sendRtp(
            new RtpPacket(
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
              Buffer.alloc(800),
            ),
          );
        }
        const last = dtls.transportSequenceNumber;
        const results = Array.from({ length: n }, (_, i) => {
          const seq = (last - n + 1 + i) & 0xffff;
          const lost = i / n < lossRatio;
          return new PacketResult({
            sequenceNumber: seq,
            received: !lost,
            receivedAtMs: lost ? 0 : tBase + i * 12,
          });
        });
        sender.handleRtcpPacket(makeTwccRtcp(results));
      };

      await pushBatch(25, 0, Date.now() - 2000);
      await pushBatch(25, 0, Date.now() - 1000);
      const good = gcc.availableBitrate;
      await pushBatch(30, 0.45, Date.now() - 500);
      await pushBatch(30, 0.45, Date.now() - 100);
      const bad = gcc.availableBitrate;

      expect(good).toBeGreaterThan(0);
      expect(bad).toBeLessThanOrEqual(good);
    });
  });

  describe("AIMD", () => {
    /** pin: decreased = throughput * beta; if > 5kbps then − 5kbps */
    const pinDecrease = (throughputBps: number) => {
      let d = throughputBps * kBeta;
      if (d > 5_000) d -= 5_000;
      return Math.round(d);
    };

    test("overuse で pin 更新式（beta×throughput − 5kbps）", () => {
      // Arrange
      const aimd = new AimdRateControl();
      aimd.reset(500_000);
      aimd.setRtt(200);
      // Act / Assert: 初回 overuse = pin decrease
      expect(aimd.update("overuse", 500_000, 1000)).toBe(pinDecrease(500_000));
      // 400kbps → 400×0.85 − 5 = 335 kbps（werift 旧 340kbps ではない）
      aimd.reset(400_000);
      aimd.setRtt(200);
      expect(aimd.update("overuse", 400_000, 2000)).toBe(335_000);
    });

    test("overuse 連続でも clamp(RTT,10,200)ms 以内は再減速しない", () => {
      // Arrange: RTT=500ms → TimeToReduceFurther interval は 200ms に clamp
      const aimd = new AimdRateControl();
      aimd.reset(400_000);
      aimd.setRtt(500);
      const t0 = 10_000;
      const after1 = aimd.update("overuse", 400_000, t0);
      expect(after1).toBe(pinDecrease(400_000));
      // Act: 150ms 後（clamp 上限 200ms 未満）→ 再減速しない
      const after2 = aimd.update("overuse", 380_000, t0 + 150);
      expect(after2).toBe(after1);
      // Act: 200ms 経過後は再減速可
      const after3 = aimd.update("overuse", 380_000, t0 + 250);
      expect(after3).toBe(pinDecrease(380_000));
      expect(after3).toBeGreaterThan(100_000);
    });

    test("決定的 overuse 系列は pin 間隔で減速し連乗しない", () => {
      // Arrange: decrease = beta*acked − 5kbps → acked 一定なら 1 回で収束
      const aimd = new AimdRateControl();
      aimd.reset(800_000);
      aimd.setRtt(200);
      const series: number[] = [];
      const acked = 600_000;
      for (let i = 0; i < 10; i++) {
        series.push(aimd.update("overuse", acked, 1000 + i * 50));
      }
      const once = pinDecrease(acked);
      expect(series[0]).toBe(once);
      expect(series.every((v) => v === once)).toBe(true);
      expect(series[series.length - 1]).toBeGreaterThan(
        Math.round(acked * kBeta ** 5),
      );
    });

    test("default RTT は 200ms で propagation と独立", () => {
      const aimd = new AimdRateControl();
      aimd.reset(300_000);
      expect(aimd.rtt).toBe(200);
      // setRtt は RTCP 経路のみ（clamp しない）
      aimd.setRtt(1_500);
      expect(aimd.rtt).toBe(1_500);
      // TTRF 間隔はなお [10,200] に clamp
      expect(aimd.timeToReduceFurther(0, 300_000)).toBe(true);
      aimd.update("overuse", 300_000, 10_000);
      expect(aimd.timeToReduceFurther(10_100, 300_000)).toBe(false);
      expect(aimd.timeToReduceFurther(10_200, 300_000)).toBe(true);
    });

    test("increase limit は 1.5×throughput + 10kbps", () => {
      const aimd = new AimdRateControl();
      aimd.reset(100_000);
      aimd.setRtt(200);
      // normal increase from hold
      const t0 = 1_000;
      // First normal: hold→increase, change time set
      aimd.update("normal", 200_000, t0);
      // Second update 1s later: multiplicative increase capped by 1.5*200k+10k
      const after = aimd.update("normal", 200_000, t0 + 1_000);
      const limit = 1.5 * 200_000 + 10_000;
      expect(after).toBeLessThanOrEqual(limit);
      expect(after).toBeGreaterThan(100_000);
    });

    test("raw RTT 180ms→20ms は AIMD に 20ms が渡る（smoothed ではない）", () => {
      // Arrange: pin OnRoundTripTimeUpdate discards smoothed RTT
      const gcc = new GccBandwidthEstimator(200_000);
      gcc.setRoundTripTime(180);
      expect((gcc as any).aimd.rtt).toBe(180);
      // Act: next raw sample is 20ms (stats EWMA would be ~156ms)
      gcc.setRoundTripTime(20);
      // Assert
      expect((gcc as any).aimd.rtt).toBe(20);
      // TimeToReduceFurther interval clamps to max(10, min(200, 20)) = 20ms
      const aimd = (gcc as any).aimd as AimdRateControl;
      aimd.reset(300_000);
      aimd.setRtt(20);
      aimd.update("overuse", 300_000, 10_000);
      expect(aimd.timeToReduceFurther(10_015, 300_000)).toBe(false);
      expect(aimd.timeToReduceFurther(10_020, 300_000)).toBe(true);
    });

    test("LinkCapacityEstimator.reset は estimate のみ消し deviation を保つ", () => {
      // Arrange
      const lc = new LinkCapacityEstimator();
      // Train deviation above default 0.4
      for (let i = 0; i < 40; i++) {
        // Alternating samples around 500 kbps to grow variance
        lc.onOveruseDetected(i % 2 === 0 ? 200_000 : 800_000);
      }
      expect(lc.hasEstimate()).toBe(true);
      const devBefore = lc.deviationKbpsValue;
      expect(devBefore).toBeGreaterThan(0.4);

      // Act: pin Reset
      lc.reset();

      // Assert: estimate gone, deviation retained
      expect(lc.hasEstimate()).toBe(false);
      expect(lc.deviationKbpsValue).toBe(devBefore);

      // Act: full reset
      lc.resetAll();
      expect(lc.deviationKbpsValue).toBe(0.4);
    });
  });

  describe("wrap-around", () => {
    test("TransportWideSeqUnwrapper は 16bit wrap と extended seq を区別する", () => {
      // Arrange
      const u = new TransportWideSeqUnwrapper();

      // Act / Assert: 通常の連続 seq
      expect(u.unwrap(1)).toBe(1);
      expect(u.unwrap(2)).toBe(2);

      // Act: 呼び出し側が generation を進めた extended seq
      expect(u.unwrap(65537)).toBe(65537);
      // Assert: 16bit feedback 1 は最新世代へ peek
      expect(u.peek(1)).toBe(65537);
      expect(u.peek(2)).toBe(65538);

      // Act: wrap を 16bit だけで辿る
      const u2 = new TransportWideSeqUnwrapper();
      expect(u2.unwrap(65534)).toBe(65534);
      expect(u2.unwrap(65535)).toBe(65535);
      expect(u2.unwrap(0)).toBe(65536);
      expect(u2.unwrap(1)).toBe(65537);
    });

    test("sortPacketResultsByWideSeq", () => {
      expect(
        sortPacketResultsByWideSeq([
          new PacketResult({ sequenceNumber: 65534, received: true }),
          new PacketResult({ sequenceNumber: 1, received: true }),
          new PacketResult({ sequenceNumber: 0, received: true }),
          new PacketResult({ sequenceNumber: 65535, received: true }),
        ]).map((r) => r.sequenceNumber),
      ).toEqual([65534, 65535, 0, 1]);
    });

    test("24-bit reference_time wrap を連続時刻へ展開する", () => {
      // Arrange: units near wrap then after wrap
      const u = new TwccReferenceTimeUnwrapper();
      const nearEnd = TWCC_REFERENCE_TIME_MOD - 2; // ... wrap soon
      const base1 = u.unwrapBaseMs(nearEnd);
      expect(base1).toBe(nearEnd * TWCC_REFERENCE_TIME_UNIT_MS);

      // Act: wrap to 1
      const base2 = u.unwrapBaseMs(1);
      // Assert: continuous forward (not jump back by ~12 days)
      expect(base2).toBeGreaterThan(base1);
      expect(base2 - base1).toBe((1 + 2) * TWCC_REFERENCE_TIME_UNIT_MS);

      // Act: rebase packetResults as TransportWideCC would emit (raw wrap)
      const u2 = new TwccReferenceTimeUnwrapper();
      const rawNear = [
        new PacketResult({
          sequenceNumber: 1,
          received: true,
          receivedAtMs: nearEnd * TWCC_REFERENCE_TIME_UNIT_MS + 5,
        }),
      ];
      const rebased1 = u2.rebasePacketResults(rawNear, nearEnd);
      const rawAfter = [
        new PacketResult({
          sequenceNumber: 2,
          received: true,
          // packetResults would use referenceTime=1 → 64ms base + delta
          receivedAtMs: 1 * TWCC_REFERENCE_TIME_UNIT_MS + 10,
        }),
      ];
      const rebased2 = u2.rebasePacketResults(rawAfter, 1);
      // Assert: rebased timeline is continuous
      expect(rebased2[0].receivedAtMs).toBeGreaterThan(
        rebased1[0].receivedAtMs,
      );
    });

    test("reference_time wrap 前後でも acked bitrate / trendline が壊れない", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(300_000);
      const nearEnd = TWCC_REFERENCE_TIME_MOD - 3;
      const n = 25;
      // Send packets around wrap
      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(sent(100 + i, 800, 50_000 + i * 20));
      }
      // Act 1: feedback just before wrap (synthetic times near nearEnd*64)
      const pre = Array.from({ length: 12 }, (_, i) => {
        return new PacketResult({
          sequenceNumber: 100 + i,
          received: true,
          receivedAtMs: nearEnd * TWCC_REFERENCE_TIME_UNIT_MS + i * 20,
        });
      });
      const fb1 = makeTwccFeedback(pre);
      fb1.referenceTime = nearEnd;
      gcc.receiveTWCC(fb1);

      // Act 2: feedback after wrap (raw times near 0)
      const post = Array.from({ length: 13 }, (_, i) => {
        return new PacketResult({
          sequenceNumber: 112 + i,
          received: true,
          receivedAtMs: 1 * TWCC_REFERENCE_TIME_UNIT_MS + i * 20,
        });
      });
      const fb2 = makeTwccFeedback(post);
      fb2.referenceTime = 1;
      gcc.receiveTWCC(fb2);

      // Assert: estimate advances (wrap で窓が壊れ 0 張り付きにならない)
      expect(gcc.availableBitrate).toBeGreaterThan(0);
    });

    test("16-bit wrap 連続送信でも旧世代の sentInfo が残る", () => {
      // Arrange / Act: 本番の uint16 カウンタと同じ 65534,65535,0,1
      const gcc = new GccBandwidthEstimator(300_000);
      gcc.rtpPacketSent(sent(65534, 10, 1_000));
      gcc.rtpPacketSent(sent(65535, 11, 1_001));
      gcc.rtpPacketSent(sent(0, 12, 1_002));
      gcc.rtpPacketSent(sent(1, 13, 1_003));

      // Assert: unwrap 済みキーで両世代が共存する
      const map = (gcc as any).sentInfos as Map<number, SentInfo>;
      expect(map.get(65534)?.size).toBe(10);
      expect(map.get(65535)?.size).toBe(11);
      expect(map.get(65536)?.size).toBe(12);
      expect(map.get(65537)?.size).toBe(13);
      expect(map.size).toBe(4);
    });

    test("wideSeq wrap (1 の後 65537) で旧 sentInfo を上書きしない", () => {
      // Arrange: レビュー再現。16bit だけだと 65537 & 0xffff === 1 で置換される
      const gcc = new GccBandwidthEstimator(300_000);
      gcc.rtpPacketSent(sent(1, 100, 1_000));

      // Act: wrap 後の新 packet（extended seq）
      gcc.rtpPacketSent(sent(65537, 999, 2_000));

      // Assert: 旧 packet の size/send time が残る
      const map = (gcc as any).sentInfos as Map<number, SentInfo>;
      expect(map.get(1)?.size).toBe(100);
      expect(map.get(1)?.sendingAtMs).toBe(1_000);
      expect(map.get(65537)?.size).toBe(999);
      expect(map.get(65537)?.sendingAtMs).toBe(2_000);
      expect(map.size).toBe(2);
    });

    test("wrap 後の late received は finalize 済み新 packet に誤結合せず旧 packet を訂正する", () => {
      // Arrange: 旧 seq=1 と wrap 後 seq=65537 を両方送る
      const t0 = 20_000;
      const { gcc, setNow } = createClockGcc(300_000, t0);
      gcc.rtpPacketSent(sent(1, 100, t0));
      gcc.rtpPacketSent(sent(65537, 999, t0 + 1_000));
      const loss = (gcc as any).lossBwe as LossBasedBwe;

      // Act: 先に 16bit seq=1 の received。新 packet（未 finalize の最新世代）へ結合
      setNow(t0 + 1_020);
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 1,
            received: true,
            receivedAtMs: t0 + 1_020,
          }),
        ]),
      );

      // Assert: 新 packet だけ finalize。旧 size=100 は残る
      expect((gcc as any).finalizedSeqs.has(65537)).toBe(true);
      expect((gcc as any).finalizedSeqs.has(1)).toBe(false);
      expect((gcc as any).sentInfos.get(1)?.size).toBe(100);
      expect((loss as any).partial.seenPackets.has(65537)).toBe(true);
      expect((loss as any).partial.seenPackets.has(1)).toBe(false);

      // Act: 旧 packet 向けの late received（同じ 16bit seq）
      setNow(t0 + 1_100);
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 1,
            received: true,
            receivedAtMs: t0 + 20,
          }),
        ]),
      );

      // Assert: 新 packet に再結合せず、旧 packet を訂正する
      expect((gcc as any).finalizedSeqs.has(1)).toBe(true);
      expect((gcc as any).finalizedSeqs.has(65537)).toBe(true);
      expect((loss as any).partial.seenPackets.get(1)).toBe(100);
      expect((loss as any).partial.seenPackets.get(65537)).toBe(999);
    });

    test("probe wrap 後も旧 seq の cluster mapping を残す", () => {
      // Arrange: 同じ 16bit seq が 2 世代ある
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      (probe as any).queue = [];

      // Act: cluster A に seq=1、続けて wrap 後 seq=65537
      probe.onProbePacketSent(400, 1_000, 1);
      const clusterA = (probe as any).seqToCluster.get(1);
      probe.onProbePacketSent(400, 2_000, 65537);

      // Assert: 旧 mapping / send time が新 packet に置換されない
      expect((probe as any).seqToCluster.get(1)).toBe(clusterA);
      expect((probe as any).seqToSendInfo.get(1)?.sendMs).toBe(1_000);
      expect((probe as any).seqToCluster.has(65537)).toBe(true);
      expect((probe as any).seqToSendInfo.get(65537)?.sendMs).toBe(2_000);
      expect((probe as any).seqToCluster.get(1)).not.toBeUndefined();
    });
  });

  describe("Blocker regressions", () => {
    test("TWCC 未交渉では probe padding を送らない", async () => {
      // Arrange: headerExtensions に transport-cc 無し
      const gcc = new GccBandwidthEstimator(100_000);
      const sender = new RTCRtpSender("video");
      const dtls = createDtlsTransport();
      (dtls as { state: string }).state = "connected";
      const sentPackets: { header: RtpHeader }[] = [];
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        sentPackets.push({
          header: new RtpHeader({
            ...header,
            extensions: [...header.extensions],
          }),
        });
        return payload.length + header.serializeSize;
      }) as typeof dtls.sendRtp;
      sender.setDtlsTransport(dtls);
      sender.setBandwidthEstimator(gcc);
      sender.prepareSend({
        codecs: [
          new RTCRtpCodecParameters({
            mimeType: "video/VP8",
            clockRate: 90000,
            payloadType: 96,
          }),
        ],
        headerExtensions: [], // no transport-cc
        muxId: "0",
        rtcp: { cname: "test", mux: true },
      });

      // Act
      await sender.sendRtp(
        new RtpPacket(
          new RtpHeader({
            sequenceNumber: 1,
            timestamp: 1000,
            payloadType: 96,
            ssrc: 1,
            extension: false,
            extensions: [],
            marker: false,
            padding: false,
            payloadOffset: 12,
          }),
          Buffer.alloc(200),
        ),
      );

      // Assert: media のみ、padding なし、BWE にも送っていない
      expect(sentPackets.length).toBe(1);
      expect(sentPackets.every((p) => !p.header.padding)).toBe(true);
      expect(gcc.availableBitrate).toBe(0);
    });

    test("media source sequence の gap/reorder は wire 上でも保持される", async () => {
      // Arrange: legacy / media は source の gap・reorder を維持（NACK 意味を壊さない）
      const { sender, sentPackets } = await prepareConnectedSender();
      // Act: source seq 10, 12 (gap), 11 (reorder)
      for (const seq of [10, 12, 11]) {
        await sender.sendRtp(
          new RtpPacket(
            new RtpHeader({
              sequenceNumber: seq,
              timestamp: seq * 100,
              payloadType: 96,
              ssrc: 1,
              extension: true,
              extensions: [],
              marker: false,
              padding: false,
              payloadOffset: 12,
            }),
            Buffer.alloc(40),
          ),
        );
      }
      // Assert: wire も 10, 12, 11（gap/reorder が見える）
      const wireSeqs = sentPackets
        .filter((p) => !p.header.padding)
        .map((p) => p.header.sequenceNumber);
      expect(wireSeqs.slice(0, 3)).toEqual([10, 12, 11]);
    });

    test("reorder media 後の probe padding でも late media と RTP sequence が衝突しない", async () => {
      // Arrange: sequence 割当は sender 側。GCC の async padding inject を避けるため
      // legacy estimator で media 10 → 12 → padding N → late 11 を再現する。
      // 旧実装は paddingSeqSinceMedia を seqOffset に一律加算し wire=11+N が衝突した。
      const { sender, sentPackets } = await prepareConnectedSender();

      const sendMedia = async (seq: number) => {
        await (sender as any).sendRtpInternal(
          new RtpPacket(
            new RtpHeader({
              sequenceNumber: seq,
              timestamp: seq * 100,
              payloadType: 96,
              ssrc: 1,
              extension: true,
              extensions: [],
              marker: false,
              padding: false,
              payloadOffset: 12,
            }),
            Buffer.alloc(40),
          ),
          { injectProbePadding: false },
        );
      };

      const sendPad = async () => {
        await (sender as any).sendRtpInternal(
          new RtpPacket(
            new RtpHeader({
              sequenceNumber: 0,
              timestamp: 0,
              payloadType: 96,
              ssrc: 1,
              extension: true,
              extensions: [],
              marker: false,
              padding: true,
              paddingSize: kProbePaddingPacketBytes,
              payloadOffset: 12,
            }),
            Buffer.alloc(0),
          ),
          { injectProbePadding: false, isProbePadding: true },
        );
      };

      // Act: media 10, 12 → padding 5 → late media 11
      await sendMedia(10);
      await sendMedia(12);
      for (let i = 0; i < 5; i++) {
        await sendPad();
      }
      const padSeqs = sentPackets
        .filter((p) => p.header.padding)
        .map((p) => p.header.sequenceNumber);
      expect(padSeqs.length).toBe(5);
      // padding は high-water(12) の後（hole 11 を埋めない）
      expect(Math.min(...padSeqs)).toBe(13);

      await sendMedia(11);

      // Assert: 全 wire RTP sequence が一意
      const all = sentPackets.map((p) => p.header.sequenceNumber);
      expect(new Set(all).size).toBe(all.length);

      // rtpCache も既送 packet と衝突しない
      const cache = (sender as any).rtpCache as Array<
        { header: { sequenceNumber: number } } | undefined
      >;
      const history = 128;
      for (const seq of all) {
        const slot = cache[seq % history];
        expect(slot).toBeDefined();
        expect(slot!.header.sequenceNumber).toBe(seq);
      }

      const mediaSeqs = sentPackets
        .filter((p) => !p.header.padding)
        .map((p) => p.header.sequenceNumber);
      expect(mediaSeqs).toEqual([10, 12, 11]);
    });

    test("media → padding → media で sequence 衝突せず source 相対は維持", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, sentPackets } = await prepareConnectedSender(gcc);
      // Act: media 10（sendRtp 後に probe padding が自動注入される）
      await sender.sendRtp(
        new RtpPacket(
          new RtpHeader({
            sequenceNumber: 10,
            timestamp: 1000,
            payloadType: 96,
            ssrc: 1,
            extension: true,
            extensions: [],
            marker: false,
            padding: false,
            payloadOffset: 12,
          }),
          Buffer.alloc(80),
        ),
      );
      expect(sentPackets.some((p) => p.header.padding)).toBe(true);
      const afterFirst = sentPackets.slice();
      const padBetween = afterFirst
        .filter((p) => p.header.padding)
        .map((p) => p.header.sequenceNumber);
      // padding は media 10 の直後から
      expect(padBetween[0]).toBe(11);
      const lastPad = padBetween[padBetween.length - 1];

      // media 12 (source gap 10→12)
      await sender.sendRtp(
        new RtpPacket(
          new RtpHeader({
            sequenceNumber: 12,
            timestamp: 2000,
            payloadType: 96,
            ssrc: 1,
            extension: true,
            extensions: [],
            marker: false,
            padding: false,
            payloadOffset: 12,
          }),
          Buffer.alloc(80),
        ),
      );
      const mediaSeqs = sentPackets
        .filter((p) => !p.header.padding)
        .map((p) => p.header.sequenceNumber);
      expect(mediaSeqs[0]).toBe(10);
      // 2nd media は 1st 後 padding の後（衝突なし）
      expect(mediaSeqs[1]).toBeGreaterThan(lastPad);
      // padding を挟まない media 同士では source gap が保持されることは別テストで確認
      // 全 wire seq は一意
      const all = sentPackets.map((p) => p.header.sequenceNumber);
      expect(new Set(all).size).toBe(all.length);
    });

    test("media → padding → media で RTP sequence が重複しない", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, sentPackets } = await prepareConnectedSender(gcc);

      // Act: media
      await sender.sendRtp(
        new RtpPacket(
          new RtpHeader({
            sequenceNumber: 10,
            timestamp: 1000,
            payloadType: 96,
            ssrc: 1,
            extension: true,
            extensions: [],
            marker: false,
            padding: false,
            payloadOffset: 12,
          }),
          Buffer.alloc(80),
        ),
      );
      // padding が挟まる
      expect(sentPackets.some((p) => p.header.padding)).toBe(true);

      // 次の media (source seq=11)
      await sender.sendRtp(
        new RtpPacket(
          new RtpHeader({
            sequenceNumber: 11,
            timestamp: 2000,
            payloadType: 96,
            ssrc: 1,
            extension: true,
            extensions: [],
            marker: false,
            padding: false,
            payloadOffset: 12,
          }),
          Buffer.alloc(80),
        ),
      );

      // Assert: 全 RTP sequence が一意
      const seqs = sentPackets.map((p) => p.header.sequenceNumber);
      expect(new Set(seqs).size).toBe(seqs.length);
      // media の 2 パケットも padding と衝突しない
      const mediaSeqs = sentPackets
        .filter((p) => !p.header.padding)
        .map((p) => p.header.sequenceNumber);
      expect(mediaSeqs.length).toBe(2);
      expect(mediaSeqs[0]).not.toBe(mediaSeqs[1]);
    });

    test("probe padding は SR octetCount に含めない", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, sentPackets } = await prepareConnectedSender(gcc);
      const before = (sender as any).octetCount as number;

      // Act: padding only
      const n = await sender.maybeInjectProbePadding();
      expect(n).toBeGreaterThan(0);
      expect(sentPackets.every((p) => p.header.padding)).toBe(true);

      // Assert: 0-byte media payload → octetCount 増分 0
      const after = (sender as any).octetCount as number;
      expect(after - before).toBe(0);
    });

    test("initial probe は front=3x のみ activate（6x は queue）", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const activated: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => activated.push(c.targetBps));

      // Act: 最初の送信で ensureProbing
      gcc.rtpPacketSent(sent(1, 200, Date.now()));

      // Assert: pacing イベントは active になった 3x のみ（6x はまだ queue）
      expect(activated).toEqual([100_000 * 3]);
      expect(gcc.suggestedProbeBitrateBps).toBe(100_000 * 3);
      expect(gcc.shouldTagProbePacket()).toBe(true);
    });

    test("probe fill 完了で ACK を待たず FIFO 次 cluster へ進む", () => {
      // Arrange: start=100kbps → 3x then 6x queued
      const probe = new ProbeController();
      const activated = probe.setBitrates(10_000, 100_000, 1e9, 0);
      expect(activated.map((c) => c.targetBps)).toEqual([300_000]);
      expect(probe.currentProbeTargetBps).toBe(300_000);
      expect(probe.queuedClusterCount).toBe(1);

      // Act: 1 パケット 1200B で minBytes は満たすが minPackets=5 未満
      let r = probe.onProbePacketSent(1200, 1000, 1);
      expect(r.activated).toEqual([]);
      expect(probe.currentProbeTargetBps).toBe(300_000);
      expect(probe.remainingProbeBytes(200)).toBeGreaterThan(0);

      // Act: minPackets まで埋める → 送信完了で 6x が pacing に
      for (let i = 0; i < 3; i++) {
        r = probe.onProbePacketSent(200, 1001 + i, 2 + i);
        expect(r.activated).toEqual([]);
      }
      r = probe.onProbePacketSent(200, 1004, 5);
      // Assert: ACK 前に 6x が active
      expect(r.activated.map((c) => c.targetBps)).toEqual([600_000]);
      expect(probe.currentProbeTargetBps).toBe(600_000);
      expect(probe.remainingProbeBytes(200)).toBeGreaterThan(0);
      expect(probe.awaitingResultCount).toBe(1);
    });

    test("80% ACK でも send-fill 未完了なら pacing を終了しない", () => {
      // Arrange: minPackets=5 / minBytes≥1000 → 4×300B で 80% ACK は成立し得るが
      // send-fill (5 pkts AND minBytes) は未完了
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      expect(probe.currentProbeTargetBps).toBe(300_000);

      const pktSize = 300;
      const sendBase = 1_000;
      // Act: 4/5 packets 送信（minPackets 未達）
      for (let i = 0; i < 4; i++) {
        const r = probe.onProbePacketSent(pktSize, sendBase + i * 2, i + 1);
        expect(r.activated).toEqual([]);
      }
      expect(probe.currentProbeTargetBps).toBe(300_000);
      expect(probe.shouldTagProbePacket()).toBe(true);

      // Act: 4 packets を全 ACK（ceil(5×0.8)=4, bytes 80% も満たす）
      for (let i = 0; i < 4; i++) {
        probe.onAckedPacket(
          pktSize,
          sendBase + 5 + i * 2,
          true,
          i + 1,
          sendBase + 20,
        );
      }

      // Assert: result が成立しても pacing は 3x のまま（5 packet 目が必要）
      expect(probe.currentProbeTargetBps).toBe(300_000);
      expect(probe.shouldTagProbePacket()).toBe(true);
      expect(probe.queuedClusterCount).toBe(1);
      expect(probe.awaitingResultCount).toBe(0);

      // Act: 5 packet 目で初めて send-fill → 6x へ advance
      const r5 = probe.onProbePacketSent(pktSize, sendBase + 8, 5);
      expect(r5.activated.map((c) => c.targetBps)).toEqual([600_000]);
      expect(probe.currentProbeTargetBps).toBe(600_000);
      expect(probe.shouldTagProbePacket()).toBe(true);
    });

    test("initial probe 全失敗でも complete になり recovery 可能", () => {
      // Arrange: 3x/6x を send-fill まで送るが ACK なし
      // 6x minBytes ≈ 1125 なので 300B×5 で確実に fill
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      expect(probe.probeState).toBe("waiting_for_result");

      // Act: 3x fill → 6x active
      for (let i = 0; i < 5; i++) {
        probe.onProbePacketSent(300, 1_000 + i, i + 1);
      }
      expect(probe.currentProbeTargetBps).toBe(600_000);

      // Act: 6x fill → pacing 空・両 cluster が awaiting
      let lastSend = 0;
      for (let i = 0; i < 5; i++) {
        lastSend = 1_010 + i;
        probe.onProbePacketSent(300, lastSend, 10 + i);
      }
      expect(probe.currentProbeTargetBps).toBe(0);
      expect(probe.awaitingResultCount).toBe(2);

      // Act: result timeout (1s from last send) — ACK なし
      const afterTimeout = lastSend + 1_001;
      probe.process(afterTimeout);
      expect(probe.awaitingResultCount).toBe(0);
      // Assert: init に戻さず complete（ensureProbing 再実行不能でも recovery 可）
      expect(probe.probeState).toBe("complete");
      // Assert: complete 時 further threshold は +∞（pin UpdateState(kProbingComplete)）
      expect(probe.furtherProbeThresholdBps).toBe(Number.POSITIVE_INFINITY);
      // Assert: complete 後 SetEstimatedBitrate では further を再開しない
      expect(probe.setEstimatedBitrate(500_000, afterTimeout + 1)).toEqual([]);

      // Act: pin RequestProbe — ALR + large drop 後に 0.85×pre-drop
      probe.setAlrStartTime(afterTimeout);
      probe.setEstimatedBitrate(1_000_000, afterTimeout + 1);
      probe.setEstimatedBitrate(150_000, afterTimeout + 2, {
        cause: "delay_based_limited",
      });
      // pin last_bwe_drop_probing_time_ starts at 0; RequestProbe needs >5s
      const recovery = probe.requestProbe(150_000, 5_001);
      expect(recovery.length).toBe(1);
      expect(recovery[0].targetBps).toBe(1_000_000 * kProbeFractionAfterDrop);
      // pin RequestProbe → InitiateProbing(probe_further=false) → complete
      expect(probe.probeState).toBe("complete");
      expect(probe.currentProbeTargetBps).toBe(recovery[0].targetBps);
    });

    test("max bitrate 到達後は last max probe のみで further を止め complete する", () => {
      // Arrange: max=1Mbps。further の uncapped (×2) が max を超えると
      // libwebrtc 同様に max で 1 回だけ probe し、以降 further しない。
      // SetEstimatedBitrate の further は waiting_for_result の間だけ（pin）。
      const maxBps = 1_000_000;
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, maxBps, 0);
      // 初期 3x/6x を破棄し、waiting 中に further threshold だけ再注入
      probe.abort(1_000);
      expect(probe.probeState).toBe("complete");
      expect(probe.furtherProbeThresholdBps).toBe(Number.POSITIVE_INFINITY);
      (probe as any).state = "waiting_for_result";
      (probe as any).minBitrateToProbeFurther = 400_000;
      (probe as any).estimatedBps = 800_000;

      // Act: 800kbps ×2 = 1.6Mbps → clamp max、stopFurtherAfter
      const last = probe.setEstimatedBitrate(800_000, 10_000);
      expect(last.length).toBe(1);
      expect(last[0].targetBps).toBe(maxBps);
      expect(probe.furtherProbeThresholdBps).toBe(Number.POSITIVE_INFINITY);
      // pin probe_further=false → kProbingComplete（pacing は残る）
      expect(probe.probeState).toBe("complete");

      // Assert: 同じ高 estimate でも追加 further は増えない
      const again = probe.setEstimatedBitrate(950_000, 10_100);
      expect(again).toEqual([]);
      expect(probe.queuedClusterCount).toBe(0);

      // Act: max cluster を send-fill + result timeout で完了
      // minBytes for 1Mbps ≈ 1875 → 400B×5 で確実に fill
      let lastSend = 0;
      for (let i = 0; i < 5; i++) {
        lastSend = 11_000 + i * 2;
        probe.onProbePacketSent(400, lastSend, i + 1);
      }
      expect(probe.currentProbeTargetBps).toBe(0);
      expect(probe.awaitingResultCount).toBe(1);
      probe.process(lastSend + 1_001);
      expect(probe.awaitingResultCount).toBe(0);
      expect(probe.probeState).toBe("complete");
      expect(probe.furtherProbeThresholdBps).toBe(Number.POSITIVE_INFINITY);
      expect(probe.queuedClusterCount).toBe(0);
      expect(probe.currentProbeTargetBps).toBe(0);

      // complete 後は state ゲート + Infinity threshold で further しない
      (probe as any).lastProbeEndMs = 0;
      const afterComplete = probe.setEstimatedBitrate(990_000, 100_000);
      expect(afterComplete).toEqual([]);
    });

    test("repeated recovery でも estimator history / seq map は有界", () => {
      // Arrange: recovery を多数回繰り返し、history が無制限に増えないこと
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      // 初期 session を abort → complete
      probe.abort(1_000);
      expect(probe.probeState).toBe("complete");

      let t = 10_000;
      let seq = 1;
      const historySamples: number[] = [];

      for (let round = 0; round < 40; round++) {
        // Act: 各 round で ALR + large drop を再記録して pin RequestProbe
        t += 5_001;
        probe.setAlrStartTime(t - 10);
        probe.setEstimatedBitrate(400_000, t - 2);
        probe.setEstimatedBitrate(150_000 + round * 1_000, t - 1, {
          cause: "delay_based_limited",
        });
        const activated = probe.requestProbe(150_000 + round * 1_000, t);
        expect(activated.length).toBe(1);
        // send-fill（minPackets=5, 大きめ size で minBytes も満たす）
        for (let i = 0; i < 5; i++) {
          t += 2;
          probe.onProbePacketSent(400, t, seq++);
        }
        // ACK して result 成立 → awaiting に残る
        for (let i = 0; i < 5; i++) {
          probe.onAckedPacket(
            400,
            t + 20 + i * 2,
            true,
            seq - 5 + i,
            t + 40,
            t - 8 + i * 2,
          );
        }
        // controller timeout → history へ
        t += 1_001;
        probe.process(t);
        expect(probe.probeState).toBe("complete");
        historySamples.push(probe.estimatorHistoryCount);
        // sender-side 60s prune を進める（古い history を回収）
        t += kSendTimeHistoryWindowMs + 1;
        probe.process(t);
      }

      // Assert: 最終 history は有界（sender age prune 後は 0 近傍）
      expect(probe.estimatorHistoryCount).toBeLessThanOrEqual(2);
      // 途中も数十オーダーに張り付かない（40 round 全保持しない）
      expect(Math.max(...historySamples)).toBeLessThanOrEqual(5);
      // seq maps も process 後に実質空
      expect((probe as any).seqToCluster.size).toBeLessThanOrEqual(16);
    });

    test("controller complete 後は further threshold が Infinity になり further を再開しない", () => {
      // Arrange: initial 3x/6x を send-fill → result timeout で complete
      // pin UpdateState(kProbingComplete): min_bitrate_to_probe_further = +∞
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      expect(probe.furtherProbeThresholdBps).toBe(Math.round(600_000 * 0.7));

      let lastSend = 0;
      for (let i = 0; i < 5; i++) {
        lastSend = 1_000 + i;
        probe.onProbePacketSent(300, lastSend, i + 1);
      }
      for (let i = 0; i < 5; i++) {
        lastSend = 1_100 + i;
        probe.onProbePacketSent(300, lastSend, 10 + i);
      }
      expect(probe.awaitingResultCount).toBe(2);
      expect(probe.probeState).toBe("waiting_for_result");

      // Act: controller result-wait timeout → complete
      probe.process(lastSend + 1_001);

      // Assert: complete + further 閾値が +∞（session 終了後の SetEstimatedBitrate は no-op）
      expect(probe.probeState).toBe("complete");
      expect(probe.furtherProbeThresholdBps).toBe(Number.POSITIVE_INFINITY);
      const further = probe.setEstimatedBitrate(900_000, lastSend + 10_000);
      expect(further).toEqual([]);
      expect(probe.probeState).toBe("complete");
      expect(probe.queuedClusterCount).toBe(0);
      expect(probe.currentProbeTargetBps).toBe(0);

      // Assert: complete 中に threshold を人為的に戻しても state ゲートで further しない
      (probe as any).minBitrateToProbeFurther = 100_000;
      expect(probe.setEstimatedBitrate(500_000, lastSend + 20_000)).toEqual([]);
    });

    test("6x result 受理後も complete 前なら further probe を enqueue できる", () => {
      // Arrange: 3x/6x を send-fill + 有効 ACK まで進め、6x 結果が threshold を超える
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      const threshold6x = Math.round(600_000 * 0.7);
      expect(probe.furtherProbeThresholdBps).toBe(threshold6x);

      const fillAndAck = (
        startSend: number,
        seq0: number,
        pktSize: number,
        n: number,
      ) => {
        for (let i = 0; i < n; i++) {
          probe.onProbePacketSent(pktSize, startSend + i * 2, seq0 + i);
        }
        for (let i = 0; i < n; i++) {
          probe.onAckedPacket(
            pktSize,
            startSend + 20 + i * 2,
            true,
            seq0 + i,
            startSend + 40,
          );
        }
      };

      // Act: 3x fill+ACK（低め result を想定 — threshold 未満でもよい）
      fillAndAck(1_000, 1, 300, 5);
      // 6x が pacing に進んでいること
      expect(probe.currentProbeTargetBps).toBe(600_000);

      // Act: 6x fill+ACK → result 成立。cluster は result timeout まで保持
      // （80% 後の追加 ACK 精緻化用）。onAcked だけでは complete にしない。
      fillAndAck(2_000, 20, 300, 5);
      expect(probe.awaitingResultCount).toBeGreaterThan(0);
      expect(probe.probeState).toBe("waiting_for_result");

      const pending = probe.takePendingEstimateBps();
      expect(pending).toBeGreaterThan(0);

      // Act: 6x×0.7 を超える estimate で further probe（cooldown 未開始）
      const over = Math.max(pending, threshold6x + 1);
      const further = probe.setEstimatedBitrate(over, 2_050);
      // 6x は既に send-fill 済みなので further は即 activate され得る
      expect(further.length + probe.queuedClusterCount).toBeGreaterThanOrEqual(
        1,
      );
      if (further.length === 0) {
        expect(probe.queuedClusterCount).toBeGreaterThanOrEqual(1);
      } else {
        expect(further[0].targetBps).toBeGreaterThan(over * 0.5);
      }

      // process 後に empty なら complete（further がある間は waiting）
      probe.process(2_060);
      if (probe.queuedClusterCount === 0 && !probe.currentProbeTargetBps) {
        // further を消化しきった場合のみ
      } else {
        expect(probe.probeState).toBe("waiting_for_result");
      }
    });

    test("further-probe threshold は計画上の最後の target（6x）基準", () => {
      // Arrange: initial 3x/6x、minBitrateToProbeFurther = 6x × 0.7
      // （成功した cluster の target=3x ではなく計画上の最後=6x が基準）
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      const threshold6x = Math.round(600_000 * 0.7);
      expect(probe.furtherProbeThresholdBps).toBe(threshold6x);

      // Act: 3x send-fill → 6x pacing 開始
      for (let i = 0; i < 5; i++) {
        probe.onProbePacketSent(300, 2_000 + i * 2, i + 1);
      }
      expect(probe.currentProbeTargetBps).toBe(600_000);
      expect(probe.queuedClusterCount).toBe(0);

      // Act: 3x の ACK で result 成功 → lastProbeTarget は 3x に更新され得る
      for (let i = 0; i < 5; i++) {
        probe.onAckedPacket(300, 2_010 + i * 2, true, i + 1, 2_030);
      }
      expect(probe.takePendingEstimateBps()).toBeGreaterThan(0);

      // Assert: 3x×0.7 は超えるが 6x×0.7 未満 → extra probe は増えない
      // （旧実装は lastProbeTarget=3x 基準で誤って enqueue してしまう）
      const mid = 300_000; // > 3x*0.7(=210k), < 6x*0.7(=420k)
      expect(probe.setEstimatedBitrate(mid, 2_040)).toEqual([]);
      expect(probe.queuedClusterCount).toBe(0);
      expect(probe.currentProbeTargetBps).toBe(600_000);

      // Assert: 6x 相当 threshold を超えると further probe が計画される
      // （6x がまだ pacing 中なら activate 戻りは空でも queue に積まれる）
      const over6x = threshold6x + 1;
      const beforeQ = probe.queuedClusterCount;
      const activated = probe.setEstimatedBitrate(over6x, 2_050);
      expect(probe.queuedClusterCount).toBe(beforeQ + 1);
      // pacing 中は activate されないが、完了後に出る
      expect(activated).toEqual([]);
      // 6x を fill すると further が activate
      for (let i = 0; i < 5; i++) {
        const r = probe.onProbePacketSent(300, 2_100 + i * 2, 20 + i);
        if (i === 4) {
          expect(r.activated.length).toBe(1);
          expect(r.activated[0].targetBps).toBeGreaterThan(over6x);
        }
      }
    });

    test("現在 bitrate より低い valid probe result も backoff guard 付きで反映する", () => {
      // Arrange: 高い current estimate の後、低い probe result を注入
      // synthetic timeline は injectable clock で feedback domain を揃える
      const t0 = 80_000;
      const { gcc, setNow } = createClockGcc(1_000_000, t0);
      // ensure probing configured
      gcc.shouldTagProbePacket();
      // 強制的に高い available と delay/loss を立てる
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 1_000_000;
      (gcc as any).lossBasedBps = 1_000_000;
      (gcc as any)._availableBitrate = 1_000_000;
      (gcc as any).currentTargetBps = 1_000_000;
      // ProbeController に pending の低い result を直接セット
      const probe = (gcc as any).probe as ProbeController;
      (probe as any).pendingEstimateBps = 300_000;
      (probe as any).state = "complete";
      (probe as any).lastProbeEndMs = 0;

      // RobustThroughput に ~900kbps 相当の ACK 履歴を注入
      // （後続 1 packet を足しても rate が崩れないよう十分な窓）
      const size = 1125; // 1125B / 10ms → 900 kbps
      const seedN = 40;
      (gcc as any).ackedBitrate.incomingPacketFeedbackVector(
        Array.from({ length: seedN }, (_, i) => ({
          receiveTimeMs: t0 + i * 10,
          sendTimeMs: t0 + i * 10,
          sizeBytes: size,
        })),
      );
      const ackedBefore = (gcc as any).ackedBitrate.bitrate() as number;
      expect(ackedBefore).toBeGreaterThan(700_000);

      // Act: 低い probe を含む TWCC 経路（matched=0 を避けるため 1 packet）
      // send/recv を窓末尾に連続させて rate を維持
      const last = t0 + (seedN - 1) * 10;
      gcc.rtpPacketSent({
        wideSeq: 1,
        size,
        sendingAtMs: last + 10,
        isProbation: false,
      } as any);
      // pending は take 前に再セット（rtpPacketSent で消えない）
      (probe as any).pendingEstimateBps = 300_000;

      setNow(last + 25);
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 1,
            received: true,
            receivedAtMs: last + 20,
          }),
        ]),
      );

      // Assert: 300kbps をそのまま落とさず、acked×0.85 付近を下回らない
      const ackedAfter = (gcc as any).ackedBitrate.bitrate() as number;
      expect(gcc.availableBitrate).toBeGreaterThan(300_000);
      expect(gcc.availableBitrate).toBeLessThanOrEqual(1_000_000);
      // floor は適用時の acked に追随（RobustThroughput の実測）
      const floor = ackedAfter * 0.85;
      expect(gcc.availableBitrate).toBeGreaterThanOrEqual(floor * 0.9);
    });

    test("ProbeController は高低に関係なく valid result を pending に出す", () => {
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      // 先に高い estimate を持たせる
      (probe as any).estimatedBps = 1_000_000;

      // 広い recv spacing → probe estimate が 1Mbps 未満になるよう決定的に
      for (let i = 0; i < 5; i++) {
        probe.onProbePacketSent(300, 1_000 + i * 2, i + 1);
      }
      for (let i = 0; i < 5; i++) {
        // recv interval 40ms 級 → 低レート
        probe.onAckedPacket(
          300,
          1_000 + i * 10,
          true,
          i + 1,
          1_100,
          1_000 + i * 2,
        );
      }

      const pending = probe.takePendingEstimateBps();
      expect(pending).toBeGreaterThan(0);
      expect(pending).toBeLessThan(1_000_000);
    });

    test("receive reorder でも min/max arrival で probe estimate が成立する", () => {
      // Arrange: sequence 順に処理しても recv 時刻が逆転していても valid
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      const size = 300;
      for (let i = 0; i < 5; i++) {
        probe.onProbePacketSent(size, 1_000 + i * 2, i + 1);
      }
      // seq 順: recv 130,90,100,110,120 → 旧 first/last では interval 負
      const recv = [130, 90, 100, 110, 120];
      for (let i = 0; i < 5; i++) {
        probe.onAckedPacket(size, recv[i], true, i + 1, 2_000, 1_000 + i * 2);
      }
      const est = probe.takePendingEstimateBps();
      expect(est).toBeGreaterThan(0);
    });

    test("80% 成立後も遅延 ACK で estimate を再計算する", () => {
      // Arrange: 4/5 ACK で estimate A、5 packet 目が遅延 → B < A
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      const size = 300;
      for (let i = 0; i < 5; i++) {
        probe.onProbePacketSent(size, 1_000 + i * 2, i + 1);
      }
      // 最初の 4 packet: 密な recv
      for (let i = 0; i < 4; i++) {
        probe.onAckedPacket(
          size,
          1_010 + i * 2,
          true,
          i + 1,
          2_000,
          1_000 + i * 2,
        );
      }
      const estA = probe.takePendingEstimateBps();
      expect(estA).toBeGreaterThan(0);

      // 5 packet 目が大きく遅れて到着 → capacity 飽和を示す
      probe.onAckedPacket(size, 1_010 + 80, true, 5, 2_100, 1_000 + 8);
      const estB = probe.takePendingEstimateBps();
      expect(estB).toBeGreaterThan(0);
      expect(estB).toBeLessThan(estA);
    });

    test("overuse 中は probe result を一切適用しない（pin MaybeUpdateEstimate）", () => {
      // pin DelayBasedBwe::MaybeUpdateEstimate: overusing 分岐は probe を無視し
      // AIMD TimeToReduceFurther のみ。lower probe も適用しない。
      const t0 = 50_000;
      const { gcc, setNow } = createClockGcc(1_000_000, t0);
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probe.lastProbeEndMs = 0;
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 1_000_000;
      (gcc as any).lossBasedBps = 1_000_000;
      (gcc as any)._availableBitrate = 1_000_000;
      (gcc as any).currentTargetBps = 1_000_000;
      (gcc as any).aimd.bitrateBps = 1_000_000;
      (gcc as any).probingConfigured = true;

      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => "overuse",
        configurable: true,
      });

      for (let i = 1; i <= 10; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 500,
          sendingAtMs: t0 + i * 20,
          isProbation: false,
        } as any);
      }
      const size = 1125;
      (gcc as any).ackedBitrate.incomingPacketFeedbackVector(
        Array.from({ length: 12 }, (_, i) => ({
          receiveTimeMs: t0 + i * 10,
          sendTimeMs: t0 + i * 10,
          sizeBytes: size,
        })),
      );
      // 低い probe result を注入しても overuse では無視される
      (gcc as any).probe.pendingEstimateBps = 300_000;
      const before = gcc.availableBitrate;

      const results = Array.from({ length: 10 }, (_, i) => {
        return new PacketResult({
          sequenceNumber: i + 1,
          received: true,
          receivedAtMs: t0 + 30 + i * 20,
        });
      });
      setNow(t0 + 250);
      gcc.receiveTWCC(makeTwccFeedback(results));

      // Assert: probe 300kbps は反映されない（floor 付きでも delay に SetEstimate しない）
      // AIMD overuse 減少は RTT spacing 内で 0 回または beta 1 回まで
      expect((gcc as any).probe.pendingEstimateBps).toBe(0);
      // available は probe 由来の 300k 帯には落ちない
      expect(gcc.availableBitrate).toBeGreaterThan(500_000);
      // overuse による減少はあっても probe floor 経路ではない
      expect(gcc.availableBitrate).toBeLessThanOrEqual(before);
    });

    test("probe result がある feedback では recovered_from_overuse recovery を出さない", () => {
      // pin: probe_bitrate がある場合 recovered_from_overuse を result に載せない
      const gcc = new GccBandwidthEstimator(150_000);
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probe.lastProbeEndMs = Date.now() - 10_000;
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 150_000;
      (gcc as any).lossBasedBps = 150_000;
      (gcc as any)._availableBitrate = 150_000;
      (gcc as any).probingConfigured = true;
      (gcc as any).lastUsage = "normal";
      (gcc as any).lossBwe.state = "delay_based";
      (gcc as any).lossBwe.update = () => {
        (gcc as any).lossBwe.state = "delay_based";
        return 150_000;
      };

      const states: Array<"normal" | "underuse" | "overuse"> = [
        "normal",
        "underuse",
        "underuse",
        "normal",
        "normal",
        "normal",
        "normal",
        "normal",
        "normal",
        "normal",
      ];
      let stateIdx = 0;
      let current: "normal" | "underuse" | "overuse" = "normal";
      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => current,
        configurable: true,
      });
      (gcc as any).pushInterArrival = () => {
        if (stateIdx < states.length) {
          current = states[stateIdx++]!;
        }
      };

      // valid probe estimate present this feedback → recovery suppressed
      (gcc as any).probe.pendingEstimateBps = 200_000;

      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));

      const t0 = Date.now();
      for (let i = 1; i <= 10; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 500,
          sendingAtMs: t0 + i * 20,
          isProbation: false,
        } as any);
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 10 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 30 + i * 20,
            });
          }),
        ),
      );

      // Assert: underuse→normal があっても probe estimate と同時なら recovery なし
      expect(probeCfgs).toEqual([]);
    });

    test("delay path idle > 2s で InterArrival/Trendline を reset する", () => {
      // pin DelayBasedBwe::kStreamTimeOut = 2s
      const gcc = new GccBandwidthEstimator(300_000);
      const t0 = 100_000;
      for (let i = 1; i <= 5; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 200,
          sendingAtMs: t0 + i * 20,
          isProbation: false,
        } as any);
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 5 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 40 + i * 20,
            });
          }),
        ),
      );

      // Arrange: idle > 2s と、reset 検出用の偽 history
      (gcc as any).lastSeenPacketMs = Date.now() - 2_500;
      (gcc as any).trendline.delayHist.push({
        arrivalTimeMs: 9999,
        smoothedDelayMs: 9999,
        rawDelayMs: 9999,
      });
      const samplesBefore = (gcc as any).trendline.sampleCount as number;
      expect(samplesBefore).toBeGreaterThan(0);

      const resetSpy = vi.spyOn((gcc as any).trendline, "reset");
      const interResetSpy = vi.spyOn((gcc as any).interArrival, "reset");

      for (let i = 6; i <= 8; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 200,
          sendingAtMs: t0 + 3_000 + (i - 5) * 20,
          isProbation: false,
        } as any);
      }
      // Act: idle 超え後の feedback
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 3 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 6,
              received: true,
              receivedAtMs: t0 + 3_040 + i * 20,
            });
          }),
        ),
      );

      // Assert: pin kStreamTimeOut 相当で delay path が reset される
      expect(resetSpy).toHaveBeenCalled();
      expect(interResetSpy).toHaveBeenCalled();
      // 偽 sample (arrivalTimeMs=9999) は残らない
      const hist = (gcc as any).trendline.delayHist as Array<{
        arrivalTimeMs: number;
      }>;
      expect(hist.every((p) => p.arrivalTimeMs !== 9999)).toBe(true);
      resetSpy.mockRestore();
      interResetSpy.mockRestore();
    });

    test("delay path idle が 2s 未満なら Trendline を reset しない", () => {
      const gcc = new GccBandwidthEstimator(300_000);
      const t0 = 200_000;
      for (let i = 1; i <= 3; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 200,
          sendingAtMs: t0 + i * 20,
          isProbation: false,
        } as any);
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 3 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 40 + i * 20,
            });
          }),
        ),
      );
      // timeout - 1ms 相当（直近 lastSeen を now-1999 に）
      (gcc as any).lastSeenPacketMs = Date.now() - 1_999;
      const resetSpy = vi.spyOn((gcc as any).trendline, "reset");

      for (let i = 4; i <= 5; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 200,
          sendingAtMs: t0 + 500 + i * 20,
          isProbation: false,
        } as any);
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 2 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 4,
              received: true,
              receivedAtMs: t0 + 540 + i * 20,
            });
          }),
        ),
      );

      // Assert: 境界 timeout-1 では reset しない
      expect(resetSpy).not.toHaveBeenCalled();
      resetSpy.mockRestore();
    });

    test("pacing timeout 5s と result timeout 1s は独立", () => {
      // Arrange
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      // 1 packet only — send-fill 未完了
      probe.onProbePacketSent(200, 0, 1);
      expect(probe.currentProbeTargetBps).toBe(300_000);

      // Act: result timeout 相当 (1s) では pacing は残る
      probe.process(1_000);
      expect(probe.currentProbeTargetBps).toBe(300_000);
      expect(probe.shouldTagProbePacket()).toBe(true);

      // Act: pacing timeout (5s) で 3x を history へ → queue の 6x が activate
      probe.process(5_001);
      expect(probe.currentProbeTargetBps).toBe(600_000);
      expect(probe.estimatorHistoryCount).toBeGreaterThanOrEqual(1);

      // Act: 6x を send-fill して awaiting へ（minBytes≈1125 → 300B×5）
      let lastSend = 0;
      for (let i = 0; i < 5; i++) {
        lastSend = 5_100 + i;
        probe.onProbePacketSent(300, lastSend, 10 + i);
      }
      expect(probe.awaitingResultCount).toBe(1);
      expect(probe.currentProbeTargetBps).toBe(0);

      // Act: controller result timeout 1s → awaiting クリア + complete
      // estimator history は残る（late TWCC 用）
      probe.process(lastSend + 1_001);
      expect(probe.awaitingResultCount).toBe(0);
      expect(probe.probeState).toBe("complete");
      expect(probe.estimatorHistoryCount).toBeGreaterThanOrEqual(1);
    });

    test("controller result timeout 後の late TWCC でも probe estimate が得られる", () => {
      // Arrange: single cluster send-fill, no ACK yet
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      // Abort queue 6x so only one cluster is under test
      (probe as any).queue = [];
      const size = 300;
      let lastSend = 0;
      for (let i = 0; i < 5; i++) {
        lastSend = 1_000 + i * 2;
        probe.onProbePacketSent(size, lastSend, i + 1);
      }
      expect(probe.awaitingResultCount).toBe(1);
      expect(probe.currentProbeTargetBps).toBe(0);

      // Act: controller timeout → complete, history keeps seq maps
      probe.process(lastSend + 1_001);
      expect(probe.awaitingResultCount).toBe(0);
      expect(probe.probeState).toBe("complete");
      expect(probe.estimatorHistoryCount).toBe(1);
      expect(probe.takePendingEstimateBps()).toBe(0);

      // Act: late TWCC ACKs after controller complete
      for (let i = 0; i < 5; i++) {
        probe.onAckedPacket(
          size,
          lastSend + 50 + i * 2,
          true,
          i + 1,
          lastSend + 2_000,
          1_000 + i * 2,
        );
      }

      // Assert: ProbeBitrateEstimator が valid pending estimate を返す
      const pending = probe.takePendingEstimateBps();
      expect(pending).toBeGreaterThan(0);
    });

    test("receive timeline で 1s 超古い estimator history は prune される", () => {
      // Arrange: send-fill + ACK で estimate 成立 → controller timeout で history へ
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      (probe as any).queue = [];
      const size = 300;
      let lastSend = 0;
      for (let i = 0; i < 5; i++) {
        lastSend = 1_000 + i * 2;
        probe.onProbePacketSent(size, lastSend, i + 1);
      }
      for (let i = 0; i < 5; i++) {
        probe.onAckedPacket(
          size,
          1_020 + i * 2,
          true,
          i + 1,
          lastSend + 100,
          1_000 + i * 2,
        );
      }
      expect(probe.takePendingEstimateBps()).toBeGreaterThan(0);

      probe.process(lastSend + 1_001);
      expect(probe.probeState).toBe("complete");
      expect(probe.estimatorHistoryCount).toBe(1);

      // Act: last receive から 1s 超の receive timeline で prune
      const lastRecv = 1_020 + 4 * 2;
      probe.onAckedPacket(
        size,
        lastRecv + 1_001,
        true,
        99, // unknown seq — still triggers EraseOldClusters
        lastSend + 3_000,
      );

      // Assert: history と seq map が消える
      expect(probe.estimatorHistoryCount).toBe(0);
      // 既に prune 済み cluster への late ACK は estimate を生まない
      probe.onAckedPacket(
        size,
        lastRecv + 1_050,
        true,
        1,
        lastSend + 3_100,
        1_000,
      );
      expect(probe.takePendingEstimateBps()).toBe(0);
    });

    test("0 packet の pacing timeout は estimator history に残らない", () => {
      // Arrange: activate のみ、1 packet も送らない
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      (probe as any).queue = [];
      expect(probe.currentProbeTargetBps).toBe(300_000);
      expect(probe.shouldTagProbePacket()).toBe(true);

      // Act: pacing timeout 5s（sentPackets=0）
      probe.process(5_001);

      // Assert: history に移さず破棄、seq maps も空
      expect(probe.estimatorHistoryCount).toBe(0);
      expect(probe.currentProbeTargetBps).toBe(0);
      expect((probe as any).seqToCluster.size).toBe(0);
      expect((probe as any).seqToSendInfo.size).toBe(0);
    });

    test("ACK なし cluster は controller complete 後 sender-side 60s で history から消える", () => {
      // Arrange: 1+ packet 送信 → result timeout → history 残留
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      (probe as any).queue = [];
      const size = 300;
      let lastSend = 0;
      for (let i = 0; i < 5; i++) {
        lastSend = 1_000 + i * 2;
        probe.onProbePacketSent(size, lastSend, i + 1);
      }
      expect(probe.awaitingResultCount).toBe(1);

      // Act: controller 1s timeout → complete + history
      probe.process(lastSend + 1_001);
      expect(probe.probeState).toBe("complete");
      expect(probe.estimatorHistoryCount).toBe(1);
      expect((probe as any).seqToCluster.size).toBe(5);

      // Act: 60s 未満は late TWCC 用に残る（pin send-time history）
      probe.process(lastSend + 5_000);
      expect(probe.estimatorHistoryCount).toBe(1);
      probe.process(lastSend + 10_001);
      expect(probe.estimatorHistoryCount).toBe(1);

      // Act: lastSend から 60s 超で sender-side prune
      probe.process(lastSend + kSendTimeHistoryWindowMs + 1);
      expect(probe.estimatorHistoryCount).toBe(0);
      expect((probe as any).seqToCluster.size).toBe(0);
      expect((probe as any).seqToSendInfo.size).toBe(0);
    });

    test("controller timeout 後 10s 以内の late TWCC は estimate 可能", () => {
      // Arrange: send-fill → controller timeout → history
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      (probe as any).queue = [];
      const size = 300;
      let lastSend = 0;
      for (let i = 0; i < 5; i++) {
        lastSend = 1_000 + i * 2;
        probe.onProbePacketSent(size, lastSend, i + 1);
      }
      probe.process(lastSend + 1_001);
      expect(probe.estimatorHistoryCount).toBe(1);
      expect(probe.takePendingEstimateBps()).toBe(0);

      // Act: lastSend から ~5s 後の late TWCC（10s window 内）
      const lateRecvBase = lastSend + 4_000;
      for (let i = 0; i < 5; i++) {
        probe.onAckedPacket(
          size,
          lateRecvBase + i * 2,
          true,
          i + 1,
          lastSend + 5_000,
          1_000 + i * 2,
        );
      }

      // Assert
      expect(probe.takePendingEstimateBps()).toBeGreaterThan(0);
    });

    test("underuse 中は recovery/further probe を生成しない", () => {
      // Arrange: complete 済み + further 可能な threshold、usage=underuse 固定
      const gcc = new GccBandwidthEstimator(100_000);
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probe.lastProbeEndMs = Date.now() - 10_000;
      (gcc as any).probe.minBitrateToProbeFurther = 50_000;
      (gcc as any).probe.pendingEstimateBps = 400_000;
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 200_000;
      (gcc as any).lossBasedBps = 200_000;
      (gcc as any)._availableBitrate = 200_000;
      (gcc as any).probingConfigured = true;
      (gcc as any).lastUsage = "underuse";
      (gcc as any).lossBwe.state = "delay_based";

      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => "underuse",
        configurable: true,
      });

      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));

      const t0 = Date.now();
      for (let i = 1; i <= 10; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 500,
          sendingAtMs: t0 + i * 20,
          isProbation: false,
        } as any);
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 10 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 30 + i * 20,
            });
          }),
        ),
      );

      // Assert: underuse 中は recovery も further も出ない
      expect(probeCfgs).toEqual([]);
      expect(gcc.probeState).toBe("complete");
      expect(gcc.shouldTagProbePacket()).toBe(false);
    });

    test("underuse → normal で recovery probe を生成できる", () => {
      // Arrange: complete + cooldown 済み。feedback 内 per-packet で
      // underuse→normal を latch（pin DelayBasedBwe recovered_from_overuse）
      const gcc = new GccBandwidthEstimator(150_000);
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probe.lastProbeEndMs = Date.now() - 10_000;
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 150_000;
      (gcc as any).lossBasedBps = 150_000;
      (gcc as any)._availableBitrate = 150_000;
      (gcc as any).probingConfigured = true;
      (gcc as any).lastUsage = "normal";
      (gcc as any).lossBwe.state = "delay_based";
      const t0 = Date.now();
      // pin RequestProbe: ALR + large drop（1 Mbps → 150 kbps）
      (gcc as any).probe.setAlrStartTime(t0);
      (gcc as any).probe.setEstimatedBitrate(1_000_000, t0);
      (gcc as any).probe.setEstimatedBitrate(150_000, t0 + 1, {
        cause: "delay_based_limited",
      });
      // Stable delay_based after loss update so cause allows recovery
      (gcc as any).lossBwe.update = () => {
        (gcc as any).lossBwe.state = "delay_based";
        return 150_000;
      };

      // Simulate detector transitions inside the receive-time loop:
      // start normal, then underuse, then normal → latch recovery.
      const states: Array<"normal" | "underuse" | "overuse"> = [
        "normal",
        "underuse",
        "underuse",
        "normal",
        "normal",
        "normal",
        "normal",
        "normal",
        "normal",
        "normal",
      ];
      let stateIdx = 0;
      let current: "normal" | "underuse" | "overuse" = "normal";
      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => current,
        configurable: true,
      });
      const origPush = (gcc as any).pushInterArrival.bind(gcc);
      (gcc as any).pushInterArrival = (
        sendMs: number,
        recvMs: number,
        size: number,
      ) => {
        // Advance state after each packet (mirrors detector update)
        if (stateIdx < states.length) {
          current = states[stateIdx++]!;
        }
        // Skip real inter-arrival (state is fully stubbed)
        void sendMs;
        void recvMs;
        void size;
        void origPush;
      };

      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));

      for (let i = 1; i <= 10; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 500,
          sendingAtMs: t0 + i * 20,
          isProbation: false,
        } as any);
      }
      // TWCC 直前に ALR を立てる（syncAlr が detector を probe に渡す）
      (gcc as any).alr.startedMs = t0;
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 10 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 30 + i * 20,
            });
          }),
        ),
      );

      // Assert: latch + pin RequestProbe（0.85 × 1 Mbps）
      expect(probeCfgs.length).toBeGreaterThanOrEqual(1);
      expect(probeCfgs[0]).toBe(1_000_000 * kProbeFractionAfterDrop);
      expect(gcc.probeState).toBe("complete");
    });

    test("feedback 開始/終了が normal でも途中 underuse→normal で recovery を latch", () => {
      // Arrange: lastUsage=normal, final state=normal, but mid-feedback recovery
      const gcc = new GccBandwidthEstimator(180_000);
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probe.lastProbeEndMs = Date.now() - 10_000;
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 180_000;
      (gcc as any).lossBasedBps = 180_000;
      (gcc as any)._availableBitrate = 180_000;
      (gcc as any).probingConfigured = true;
      (gcc as any).lastUsage = "normal";
      const t0 = Date.now();
      (gcc as any).probe.setAlrStartTime(t0);
      (gcc as any).probe.setEstimatedBitrate(1_000_000, t0);
      (gcc as any).probe.setEstimatedBitrate(180_000, t0 + 1, {
        cause: "delay_based_limited",
      });
      (gcc as any).lossBwe.update = () => {
        (gcc as any).lossBwe.state = "delay_based";
        return 180_000;
      };

      // Per-packet states: N → U → N (start and end both normal)
      const afterUpdate: Array<"normal" | "underuse"> = [
        "normal",
        "underuse",
        "normal",
        "normal",
        "normal",
        "normal",
      ];
      let i = 0;
      let cur: "normal" | "underuse" = "normal";
      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => cur,
        configurable: true,
      });
      (gcc as any).pushInterArrival = () => {
        if (i < afterUpdate.length) cur = afterUpdate[i++]!;
      };

      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));

      for (let s = 1; s <= 6; s++) {
        gcc.rtpPacketSent(sent(s, 500, t0 + s * 10));
      }
      (gcc as any).alr.startedMs = t0;
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 6 }, (_, j) => {
            return new PacketResult({
              sequenceNumber: j + 1,
              received: true,
              receivedAtMs: t0 + 20 + j * 10,
            });
          }),
        ),
      );

      // Assert: feedback 間比較では見逃す N→…→N でも latch + pin RequestProbe
      expect(probeCfgs.length).toBeGreaterThanOrEqual(1);
      expect(probeCfgs[0]).toBe(1_000_000 * kProbeFractionAfterDrop);
      expect(gcc.probeState).toBe("complete");
    });

    test("ALR なしの underuse→normal では recovery probe しない", () => {
      // Arrange: pin RequestProbe は ALR / 直近 ALR 終了が必須
      const gcc = new GccBandwidthEstimator(150_000);
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 150_000;
      (gcc as any).lossBasedBps = 150_000;
      (gcc as any)._availableBitrate = 150_000;
      (gcc as any).probingConfigured = true;
      (gcc as any).lossBwe.state = "delay_based";
      (gcc as any).probe.setEstimatedBitrate(1_000_000, 1);
      (gcc as any).probe.setEstimatedBitrate(150_000, 2, {
        cause: "delay_based_limited",
      });
      (gcc as any).lossBwe.update = () => {
        (gcc as any).lossBwe.state = "delay_based";
        return 150_000;
      };
      let cur: "normal" | "underuse" = "normal";
      const seq: Array<"normal" | "underuse"> = [
        "normal",
        "underuse",
        "normal",
        "normal",
      ];
      let i = 0;
      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => cur,
        configurable: true,
      });
      (gcc as any).pushInterArrival = () => {
        if (i < seq.length) cur = seq[i++]!;
      };
      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));
      const t0 = Date.now();
      for (let s = 1; s <= 4; s++) {
        gcc.rtpPacketSent(sent(s, 500, t0 + s * 10));
      }

      // Act
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 4 }, (_, j) => {
            return new PacketResult({
              sequenceNumber: j + 1,
              received: true,
              receivedAtMs: t0 + 20 + j * 10,
            });
          }),
        ),
      );

      // Assert: latch しても ALR が無いので RequestProbe は空
      expect(probeCfgs).toEqual([]);
      expect(gcc.probeState).toBe("complete");
    });

    test("loss decreasing/hold では further/recovery probe を生成しない", () => {
      // Arrange: usage=normal だが loss が decreasing
      const gcc = new GccBandwidthEstimator(200_000);
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probe.lastProbeEndMs = Date.now() - 10_000;
      (gcc as any).probe.minBitrateToProbeFurther = 50_000;
      (gcc as any).probe.pendingEstimateBps = 500_000;
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 200_000;
      (gcc as any).lossBasedBps = 100_000;
      (gcc as any)._availableBitrate = 100_000;
      (gcc as any).probingConfigured = true;
      (gcc as any).lastUsage = "underuse"; // would recover if loss allowed
      (gcc as any).lossBwe.state = "decreasing";

      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => "normal",
        configurable: true,
      });

      // Prevent loss update from clearing decreasing while we still have few
      // observations: stub update to keep state + return loss-limited bps.
      (gcc as any).lossBwe.update = () => {
        (gcc as any).lossBwe.state = "decreasing";
        return 100_000;
      };

      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));

      const t0 = Date.now();
      for (let i = 1; i <= 10; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 500,
          sendingAtMs: t0 + i * 20,
          isProbation: false,
        } as any);
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 10 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 30 + i * 20,
            });
          }),
        ),
      );

      // Assert: loss decreasing は GetBandwidthLimitedCause 相当で probe 禁止
      expect(probeCfgs).toEqual([]);
      expect(gcc.probeState).toBe("complete");

      // hold も同様
      (gcc as any).lossBwe.update = () => {
        (gcc as any).lossBwe.state = "hold";
        return 100_000;
      };
      (gcc as any).probe.pendingEstimateBps = 500_000;
      (gcc as any).lastUsage = "underuse";
      for (let i = 11; i <= 20; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 500,
          sendingAtMs: t0 + i * 20,
          isProbation: false,
        } as any);
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 10 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: 11 + i,
              received: true,
              receivedAtMs: t0 + 250 + i * 20,
            });
          }),
        ),
      );
      expect(probeCfgs).toEqual([]);
      expect(gcc.probeState).toBe("complete");
    });

    test("GetBandwidthLimitedCause 相当の state→cause→InitiateProbing 対応表", () => {
      // Arrange / Assert: pin goog_cc GetBandwidthLimitedCause + InitiateProbing
      const cases: Array<{
        usage: "normal" | "underuse" | "overuse";
        rttHigh: boolean;
        loss:
          | "increasing"
          | "increase_using_padding"
          | "decreasing"
          | "delay_based"
          | "hold";
        allow: boolean;
        scaleCap: boolean;
      }> = [
        {
          usage: "overuse",
          rttHigh: false,
          loss: "delay_based",
          allow: false,
          scaleCap: false,
        },
        {
          usage: "underuse",
          rttHigh: false,
          loss: "delay_based",
          allow: false,
          scaleCap: false,
        },
        {
          usage: "normal",
          rttHigh: true,
          loss: "delay_based",
          allow: false,
          scaleCap: false,
        },
        {
          usage: "normal",
          rttHigh: false,
          loss: "decreasing",
          allow: false,
          scaleCap: false,
        },
        {
          usage: "normal",
          rttHigh: false,
          loss: "hold",
          allow: false,
          scaleCap: false,
        },
        {
          usage: "normal",
          rttHigh: false,
          loss: "increase_using_padding",
          allow: false,
          scaleCap: false,
        },
        {
          usage: "normal",
          rttHigh: false,
          loss: "increasing",
          allow: true,
          scaleCap: true,
        },
        {
          usage: "normal",
          rttHigh: false,
          loss: "delay_based",
          allow: true,
          scaleCap: false,
        },
      ];
      for (const c of cases) {
        const cause = getBandwidthLimitedCause(c.usage, c.rttHigh, c.loss);
        expect(isProbeInitiationAllowed(cause)).toBe(c.allow);
        const max = maxProbeBitrateBps(cause, 200_000);
        if (!c.allow) {
          expect(max).toBe(0);
        } else if (c.scaleCap) {
          expect(max).toBe(200_000 * kLossLimitedProbeScale);
        } else {
          expect(max).toBeGreaterThan(200_000 * kLossLimitedProbeScale);
        }
      }
      // Assert: RTT threshold は pin の 3s（> limit で high）
      expect(isRttAboveLimit(kRttBasedBackOffHighRttMs)).toBe(false);
      expect(isRttAboveLimit(kRttBasedBackOffHighRttMs + 1)).toBe(true);
    });

    test("propagation RTT 高値では probe 禁止に加え target を ×0.8 backoff する", () => {
      // Arrange: pin UpdateEstimate — IsRttAboveLimit で target ×0.8
      const startBps = 300_000;
      const gcc = new GccBandwidthEstimator(startBps);

      // Act: one-way delay が ~3.5s になるよう recv を send から大きく離す
      // propagation ≈ feedback_rtt − pending → high CorrectedRtt
      const now = Date.now();
      const n = 12;
      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(sent(i + 1, 500, now - 3_600 + i * 5));
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: n }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: now - 3_550 + i * 5,
            });
          }),
        ),
      );

      // Assert: CorrectedRtt > 3s → probe cause high + target ≤ start×0.8
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(true);
      expect((gcc as any).lastPropagationRttMs).toBeGreaterThan(
        kRttBasedBackOffHighRttMs,
      );
      expect(gcc.availableBitrate).toBeGreaterThan(0);
      expect(gcc.availableBitrate).toBeLessThanOrEqual(
        Math.round(startBps * kRttBasedBackOffDropFraction),
      );
      expect(gcc.availableBitrate).toBeGreaterThanOrEqual(
        kRttBasedBackOffBandwidthFloorBps,
      );
    });

    test("max feedback RTT>3s でも propagation RTT が低ければ probe cause は high にしない", () => {
      // Arrange / pin example:
      // A: send=0, recv=100; B: send=2900, recv=3000; feedback=3100
      // max_feedback_rtt=3100, min_propagation_rtt=200
      const gcc = new GccBandwidthEstimator(250_000);
      const feedback = Date.now();
      // Use absolute wall times matching the pin geometry relative to feedback
      const packets = [
        { send: feedback - 3_100, recv: feedback - 3_000 }, // A
        { send: feedback - 200, recv: feedback - 100 }, // B
      ];
      for (let i = 0; i < packets.length; i++) {
        gcc.rtpPacketSent(sent(i + 1, 600, packets[i]!.send));
      }

      // Act
      gcc.receiveTWCC(
        makeTwccFeedback(
          packets.map((p, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: p.recv,
            });
          }),
        ),
      );

      // Assert: max feedback RTT は high だが propagation は ~200ms
      expect((gcc as any).lastMaxFeedbackRttMs).toBeGreaterThan(
        kRttBasedBackOffHighRttMs,
      );
      expect((gcc as any).lastPropagationRttMs).toBeLessThan(500);
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(false);
      // probe cause は RTT では禁止しない（usage/loss 次第）
      expect(
        isProbeInitiationAllowed(
          getBandwidthLimitedCause(
            "normal",
            (gcc as any).rttBackoff.isRttAboveLimit(),
            "delay_based",
          ),
        ),
      ).toBe(true);
      expect(gcc.availableBitrate).toBeGreaterThan(0);
    });

    test("高 propagation RTT → 低 propagation RTT full-path で sticky high が解消される", () => {
      // Arrange: 送信時刻と TWCC だけで high → low を遷移
      const gcc = new GccBandwidthEstimator(200_000);

      // Act 1: high propagation batch (send ≪ feedback, tight recv cluster)
      const highSend = Date.now() - 3_500;
      for (let i = 1; i <= 10; i++) {
        gcc.rtpPacketSent(sent(i, 500, highSend + i * 5));
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 10 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: highSend + 30 + i * 5,
            });
          }),
        ),
      );
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(true);
      expect((gcc as any).lastPropagationRttMs).toBeGreaterThan(
        kRttBasedBackOffHighRttMs,
      );
      const highBps = gcc.availableBitrate;
      expect(highBps).toBeGreaterThan(0);

      // Act 2: low propagation batch
      const lowSend = Date.now() - 3;
      for (let i = 11; i <= 25; i++) {
        gcc.rtpPacketSent(sent(i, 500, lowSend));
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 15 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: 11 + i,
              received: true,
              receivedAtMs: lowSend + 1 + i,
            });
          }),
        ),
      );

      // Assert: propagation が低に更新（sticky high 解消 → probe 許可側へ）
      expect((gcc as any).lastPropagationRttMs).toBeLessThan(50);
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(false);
      expect(
        isProbeInitiationAllowed(
          getBandwidthLimitedCause(
            "normal",
            (gcc as any).rttBackoff.isRttAboveLimit(),
            "delay_based",
          ),
        ),
      ).toBe(true);
      expect(gcc.availableBitrate).toBeGreaterThan(0);
    });

    test("propagation RTT > 30s full-path でも CorrectedRtt を記録する", () => {
      // Arrange / Act: send を 35s 前に置く
      const gcc = new GccBandwidthEstimator(150_000);
      const t0 = Date.now() - 35_000;
      for (let i = 1; i <= 8; i++) {
        gcc.rtpPacketSent(sent(i, 400, t0 + i * 10));
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 8 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 20 + i * 10,
            });
          }),
        ),
      );

      // Assert: high propagation + probe cause forbid + RTT target backoff
      expect((gcc as any).lastPropagationRttMs).toBeGreaterThan(30_000);
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(true);
      expect(
        isProbeInitiationAllowed(
          getBandwidthLimitedCause("normal", true, "delay_based"),
        ),
      ).toBe(false);
      expect(gcc.availableBitrate).toBeGreaterThan(0);
      expect(gcc.availableBitrate).toBeLessThanOrEqual(
        Math.round(150_000 * kRttBasedBackOffDropFraction),
      );
    });

    test("送信継続・feedbackなしで 3s 超えると target を ×0.8 し 1s ごとにさらに下げ floor 未満にはしない", () => {
      // Arrange: pin OnSentPacket は RTT を進めるだけ。drop は ProcessInterval
      const startBps = 1_000_000;
      const gcc = new GccBandwidthEstimator(startBps);
      const t0 = 10_000;

      // Act: 送信を継続（feedback なし）— CorrectedRtt = lastSend − firstSend
      let seq = 1;
      gcc.rtpPacketSent(sent(seq++, 500, t0));
      gcc.process(t0);
      expect(gcc.availableBitrate).toBe(0); // TWCC 前・RTT 未超過は未公開

      // ちょうど limit では drop しない（> limit）
      gcc.rtpPacketSent(sent(seq++, 500, t0 + kRttBasedBackOffHighRttMs));
      gcc.process(t0 + kRttBasedBackOffHighRttMs);
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(false);
      expect(gcc.availableBitrate).toBe(0);

      // 3s+1ms の send では high になるが target はまだ変わらない
      const highSend = t0 + kRttBasedBackOffHighRttMs + 1;
      gcc.rtpPacketSent(sent(seq++, 500, highSend));
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(true);
      expect(gcc.availableBitrate).toBe(0);

      // 次の ProcessInterval（+25ms）で初回 drop → 800kbps
      const firstProcess = highSend + kGoogCcProcessIntervalMs;
      gcc.process(firstProcess);
      expect(gcc.availableBitrate).toBe(
        Math.round(startBps * kRttBasedBackOffDropFraction),
      );

      // drop_interval 未満の send+process では再 drop しない
      gcc.rtpPacketSent(sent(seq++, 500, highSend + 500));
      gcc.process(highSend + 500);
      expect(gcc.availableBitrate).toBe(
        Math.round(startBps * kRttBasedBackOffDropFraction),
      );

      // +1s process: 2 回目 drop → 640kbps
      const secondProcess = firstProcess + kRttBasedBackOffDropIntervalMs;
      gcc.rtpPacketSent(sent(seq++, 500, secondProcess));
      gcc.process(secondProcess);
      expect(gcc.availableBitrate).toBe(
        Math.round(startBps * kRttBasedBackOffDropFraction ** 2),
      );

      // 繰り返し floor まで — pin kCongestionControllerMinBitrate = 5kbps
      let t = secondProcess;
      for (let i = 0; i < 40; i++) {
        t += kRttBasedBackOffDropIntervalMs;
        gcc.rtpPacketSent(sent(seq++, 500, t));
        gcc.process(t);
      }
      expect(kMinBitrateBps).toBe(5_000);
      expect(gcc.availableBitrate).toBe(5_000);
      expect(gcc.availableBitrate).toBe(kMinBitrateBps);
      expect(gcc.availableBitrate).toBe(kRttBasedBackOffBandwidthFloorBps);
    });

    test("feedback 後に送信が止まれば CorrectedRtt は時間だけでは増えない", () => {
      // Arrange: 正常 propagation の TWCC を 1 回入れ、その後送信停止
      // send/recv は wall に近い時刻（production と同じ clock domain）
      const gcc = new GccBandwidthEstimator(500_000);
      const t0 = Date.now() - 50;
      for (let i = 1; i <= 8; i++) {
        gcc.rtpPacketSent(sent(i, 400, t0 + i * 2));
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 8 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 5 + i * 2,
            });
          }),
        ),
      );
      const rttAfterFeedback = (gcc as any).rttBackoff.correctedRttMs();
      expect(rttAfterFeedback).toBeLessThan(kRttBasedBackOffHighRttMs);
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(false);

      // Act: 送信なし → last_packet_sent が進まないので timeout correction は増えない
      // （壁時計だけ進んでも process を呼ばなければ CorrectedRtt は不変）
      const frozen = (gcc as any).rttBackoff.correctedRttMs();
      expect(frozen).toBe(rttAfterFeedback);
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(false);
      // 送信再開しても feedback 直後なら limit 未満
      gcc.rtpPacketSent(sent(100, 400, Date.now()));
      expect((gcc as any).rttBackoff.correctedRttMs()).toBeLessThan(
        kRttBasedBackOffHighRttMs,
      );
    });

    test("正常 feedback 到着後は propagation 更新で不要な RTT backoff が止まる", () => {
      // Arrange: 送信継続で RTT high → drop 済み（sender-clock のみ）
      const startBps = 1_000_000;
      const gcc = new GccBandwidthEstimator(startBps);
      const t0 = 30_000;
      let seq = 1;
      gcc.rtpPacketSent(sent(seq++, 500, t0));
      const highSend = t0 + kRttBasedBackOffHighRttMs + 1;
      gcc.rtpPacketSent(sent(seq++, 500, highSend));
      expect(gcc.availableBitrate).toBe(0);
      gcc.process(highSend + kGoogCcProcessIntervalMs);
      expect(gcc.availableBitrate).toBe(
        Math.round(startBps * kRttBasedBackOffDropFraction),
      );
      const dropped = gcc.availableBitrate;

      // Act: wall と整合する低 propagation TWCC で high を解消
      const lowSend = Date.now() - 20;
      const n = 10;
      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(sent(seq + i, 500, lowSend + i * 2));
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: n }, (_, i) => {
            return new PacketResult({
              sequenceNumber: seq + i,
              received: true,
              receivedAtMs: lowSend + 5 + i * 2,
            });
          }),
        ),
      );

      // Assert: high 解消。delay/loss が target を再設定でき、再 drop しない
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(false);
      expect((gcc as any).lastPropagationRttMs).toBeLessThan(100);
      // 正常 path では availableBitrate が維持または回復方向（再×0.8 しない）
      expect(gcc.availableBitrate).toBeGreaterThanOrEqual(dropped);
    });

    test("high RTT 中は lossBwe が極端に低くても target は old×0.8 であり loss×0.8 ではない", () => {
      // Arrange: pin UpdateEstimate RTT branch は loss result を採用しない
      // current=1Mbps, delay=1Mbps, loss=300kbps, RTT high → 800kbps（240 ではない）
      const startBps = 1_000_000;
      const t0 = 40_000;
      const { gcc, setNow } = createClockGcc(startBps, t0);
      gcc.rtpPacketSent(sent(1, 500, t0));
      // 3s+ 送信では high のみ。drop は ProcessInterval
      const highT = t0 + kRttBasedBackOffHighRttMs + 1;
      gcc.rtpPacketSent(sent(2, 500, highT));
      expect(gcc.availableBitrate).toBe(0);
      gcc.process(highT + kGoogCcProcessIntervalMs);
      const afterFirstDrop = Math.round(
        startBps * kRttBasedBackOffDropFraction,
      );
      expect(gcc.availableBitrate).toBe(afterFirstDrop);

      // Act: high RTT を固定したまま、lossBwe だけ 300kbps を返す TWCC
      (gcc as any).rttBackoff.isRttAboveLimit = () => true;
      (gcc as any).lastRttDecreaseMs = highT; // drop_interval 内 → 再 drop なし
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = startBps;
      (gcc as any).currentTargetBps = afterFirstDrop;
      (gcc as any)._availableBitrate = afterFirstDrop;
      (gcc as any).lossBwe.update = () => {
        (gcc as any).lossBwe.state = "decreasing";
        return 300_000;
      };
      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => "normal",
        configurable: true,
      });

      const twccT = highT + 100;
      setNow(twccT);
      gcc.rtpPacketSent(sent(3, 500, twccT));
      // rtpPacketSent は isRttAboveLimit true でも interval 内なので 800k 維持
      expect(gcc.availableBitrate).toBe(afterFirstDrop);

      setNow(twccT + 20);
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 3,
            received: true,
            receivedAtMs: twccT + 10,
          }),
        ]),
      );

      // Assert: loss 300k を clamp に使わない → 800k 維持
      // 旧実装は min(800k,300k)=300 → さらに ×0.8=240 になり得た
      expect(gcc.availableBitrate).toBe(afterFirstDrop);
      expect(gcc.availableBitrate).not.toBe(300_000);
      expect(gcc.availableBitrate).not.toBe(
        Math.round(300_000 * kRttBasedBackOffDropFraction),
      );
    });

    test("high RTT 後に送信が止まっても process だけで 1s ごとに target drop する", () => {
      // Arrange: pin OnProcessInterval は packet 無しでも UpdateEstimate 継続
      const startBps = 1_000_000;
      const t0 = 50_000;
      const { gcc, setNow } = createClockGcc(startBps, t0);
      gcc.rtpPacketSent(sent(1, 500, t0));
      const highT = t0 + kRttBasedBackOffHighRttMs + 1;
      gcc.rtpPacketSent(sent(2, 500, highT));
      expect(gcc.availableBitrate).toBe(0);

      // Act: 送信なし・process のみで drop を進める
      // CorrectedRtt は last_packet_sent 固定なので high のまま
      const firstProcess = highT + kGoogCcProcessIntervalMs;
      setNow(firstProcess);
      gcc.process(firstProcess);
      expect(gcc.availableBitrate).toBe(
        Math.round(startBps * kRttBasedBackOffDropFraction),
      );

      setNow(firstProcess + kRttBasedBackOffDropIntervalMs);
      gcc.process(firstProcess + kRttBasedBackOffDropIntervalMs);
      expect(gcc.availableBitrate).toBe(
        Math.round(startBps * kRttBasedBackOffDropFraction ** 2),
      );

      setNow(firstProcess + 2 * kRttBasedBackOffDropIntervalMs);
      gcc.process(firstProcess + 2 * kRttBasedBackOffDropIntervalMs);
      expect(gcc.availableBitrate).toBe(
        Math.round(startBps * kRttBasedBackOffDropFraction ** 3),
      );

      // Assert: CorrectedRtt は process だけでは増えない（last_packet_sent 固定）
      const rttFrozen = (gcc as any).rttBackoff.correctedRttMs();
      setNow(highT + 60_000);
      expect((gcc as any).rttBackoff.correctedRttMs()).toBe(rttFrozen);
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(true);
    });

    test("high RTT の process は drop 後に delay upper へ clamp する（GetUpperLimit）", () => {
      // Arrange: pin UpdateEstimate は first drop してから GetUpperLimit=delay
      // current=800kbps, delay=400kbps, drop due → 400kbps
      // 禁止: delay clamp 無しで 800×0.8=640 のまま
      const startBps = 1_000_000;
      const t0 = 60_000;
      const { gcc, setNow } = createClockGcc(startBps, t0);
      gcc.rtpPacketSent(sent(1, 500, t0));
      const highT = t0 + kRttBasedBackOffHighRttMs + 1;
      gcc.rtpPacketSent(sent(2, 500, highT));
      const firstProcess = highT + kGoogCcProcessIntervalMs;
      setNow(firstProcess);
      gcc.process(firstProcess);
      expect(gcc.availableBitrate).toBe(
        Math.round(startBps * kRttBasedBackOffDropFraction),
      );

      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 400_000;
      (gcc as any).delayBasedLimitBps = 400_000;

      // Act: drop_interval 経過後の ProcessInterval
      const later = firstProcess + kRttBasedBackOffDropIntervalMs;
      setNow(later);
      gcc.process(later);

      // Assert: drop 800→640 のあと delay 400 で upper clamp
      expect(gcc.availableBitrate).toBe(400_000);
      expect(gcc.availableBitrate).not.toBe(
        Math.round(800_000 * kRttBasedBackOffDropFraction),
      );
    });

    test("periodic process の RTT drop は Process の後に cause を伝播する", () => {
      // Arrange: pin OnProcessInterval =
      //   UpdateEstimate → SetAlrStartTime → Process → MaybeTrigger
      // ALR 未 due の tick で high になると、Process はまだ旧 cause を見るが
      // MaybeTrigger 後は high RTT。次の ALR due tick では probe しない。
      const startBps = 1_000_000;
      const t0 = 100_000;
      const { gcc, setNow } = createClockGcc(startBps, t0, {
        periodicAlrProbing: true,
      });
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(t0);
      expect(gcc.probeState).toBe("complete");

      gcc.rtpPacketSent(sent(1, 500, t0));
      const highT = t0 + kRttBasedBackOffHighRttMs + 1;
      gcc.rtpPacketSent(sent(2, 500, highT));
      expect(gcc.availableBitrate).toBe(0);
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(true);

      (gcc as any).hasValidSample = true;
      (gcc as any).alr.startedMs = t0;
      (gcc as any).probe.setAlrStartTime(t0);
      (gcc as any).probe.setEstimatedBitrate(startBps, t0, {
        cause: "delay_based_limited",
      });

      // Act: ALR 未 due（t0+3001）の ProcessInterval
      const firstProcess = highT + kGoogCcProcessIntervalMs;
      setNow(firstProcess);
      gcc.process(firstProcess);

      const afterDrop = Math.round(startBps * kRttBasedBackOffDropFraction);
      expect(gcc.availableBitrate).toBe(afterDrop);
      expect((gcc as any).probe.estimatedBitrateBps).toBe(afterDrop);
      expect((gcc as any).probe.lastBandwidthLimitedCause).toBe(
        "rtt_based_back_off_high_rtt",
      );

      // Act: すでに cause 更新済みのあと ALR interval 経過
      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));
      const alrT = t0 + kAlrProbingIntervalMs;
      setNow(alrT);
      gcc.process(alrT);

      // Assert: 前回 MaybeTrigger 済みの high RTT を見て probe しない
      expect(probeCfgs).toEqual([]);
      expect(gcc.probeState).toBe("complete");
    });

    test("ALR due と RTT high が同じ Process tick なら旧 cause で probe し得る", () => {
      // Arrange: pin は Process が前回 cause を見たあと MaybeTrigger する
      const startBps = 1_000_000;
      const t0 = 130_000;
      const { gcc, setNow } = createClockGcc(startBps, t0, {
        periodicAlrProbing: true,
      });
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(t0);
      gcc.rtpPacketSent(sent(1, 500, t0));

      const dueT = t0 + kAlrProbingIntervalMs;
      gcc.rtpPacketSent(sent(2, 500, dueT));
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(true);
      expect(gcc.availableBitrate).toBe(0);

      // send 後に ALR を立てる（OnBytesSent が budget で ALR を落とさないように）
      (gcc as any).hasValidSample = true;
      (gcc as any).alr.startedMs = t0;
      (gcc as any).probe.setAlrStartTime(t0);
      (gcc as any).probe.setEstimatedBitrate(startBps, t0, {
        cause: "delay_based_limited",
      });

      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));
      setNow(dueT);
      gcc.process(dueT);

      // Assert: Process はまだ delay_based を見るので ALR probe が出る
      expect(probeCfgs.length).toBe(1);
      expect(probeCfgs[0]).toBe(startBps * kAlrProbeScale);
      // MaybeTrigger 後は target drop + high RTT cause
      expect(gcc.availableBitrate).toBe(
        Math.round(startBps * kRttBasedBackOffDropFraction),
      );
      expect((gcc as any).probe.lastBandwidthLimitedCause).toBe(
        "rtt_based_back_off_high_rtt",
      );
    });

    test("high RTT の TWCC は loss を無視し drop→delay clamp であり clamp→drop ではない", () => {
      // Arrange: current=800kbps, delay=400kbps, loss=300kbps, drop due
      // pin: drop 800×0.8=640 → GetUpperLimit delay 400 → 400
      // 禁止: min(800,400)=400 を先に入れてから ×0.8 → 320
      // 禁止: 300kbps を採用してから ×0.8 → 240
      const startBps = 1_000_000;
      const t0 = 70_000;
      const { gcc, setNow } = createClockGcc(startBps, t0);
      gcc.rtpPacketSent(sent(1, 500, t0));
      const highT = t0 + kRttBasedBackOffHighRttMs + 1;
      gcc.rtpPacketSent(sent(2, 500, highT));
      gcc.process(highT + kGoogCcProcessIntervalMs);
      expect(gcc.availableBitrate).toBe(
        Math.round(startBps * kRttBasedBackOffDropFraction),
      );

      (gcc as any).rttBackoff.isRttAboveLimit = () => true;
      // drop は receiveTWCC 内の UpdateEstimate で一度だけ（先に rtpPacketSent しない）
      (gcc as any).lastRttDecreaseMs = highT - kRttBasedBackOffDropIntervalMs;
      (gcc as any).hasValidSample = true;
      (gcc as any).currentTargetBps = 800_000;
      (gcc as any)._availableBitrate = 800_000;
      (gcc as any).aimd.update = () => 400_000;
      Object.defineProperty((gcc as any).aimd, "targetBitrateBps", {
        get: () => 400_000,
        configurable: true,
      });
      (gcc as any).lossBwe.update = () => {
        (gcc as any).lossBwe.state = "decreasing";
        return 300_000;
      };
      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => "normal",
        configurable: true,
      });

      const twccT = highT + kRttBasedBackOffDropIntervalMs;
      setNow(twccT);
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 2,
            received: true,
            receivedAtMs: highT + 10,
          }),
        ]),
      );

      // Assert: pin と同じ 400kbps。320 / 240 ではない
      expect(gcc.availableBitrate).toBe(400_000);
      expect(gcc.availableBitrate).not.toBe(320_000);
      expect(gcc.availableBitrate).not.toBe(240_000);
      expect(gcc.availableBitrate).not.toBe(300_000);
    });

    test("60s 超 late feedback でも feedback_time を receive timeline に切替えない", () => {
      // Arrange: sender clock と TWCC recv が 65s 離れる
      const t0 = 1_000;
      const { gcc, setNow } = createClockGcc(300_000, t0);
      gcc.rtpPacketSent(sent(1, 400, t0));

      // Act: 65s 後の sender clock で feedback（recv timeline は t0+20）
      setNow(t0 + 65_000);
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 1,
            received: true,
            receivedAtMs: t0 + 20,
          }),
        ]),
      );

      // Assert: 旧 heuristic だと receive timeline に fallback して低 RTT になる
      expect((gcc as any).lastPropagationRttMs).toBeGreaterThan(60_000);
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(true);
    });

    test("pin 60s send history 内の 11s late TWCC は sentInfos から照合できる", () => {
      // Arrange: 10s で prune すると 11s late ACK が消える（pin は 60s）
      const t0 = 10_000;
      const { gcc, setNow } = createClockGcc(300_000, t0);
      gcc.rtpPacketSent(sent(1, 400, t0));
      setNow(t0 + 11_000);
      gcc.rtpPacketSent(sent(2, 400, t0 + 11_000));

      // Act: packet 1 の late received
      setNow(t0 + 11_050);
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 1,
            received: true,
            receivedAtMs: t0 + 20,
          }),
          new PacketResult({
            sequenceNumber: 2,
            received: true,
            receivedAtMs: t0 + 11_020,
          }),
        ]),
      );

      // Assert: 11s ではまだ history に残る
      expect((gcc as any).sentInfos.has(1)).toBe(true);
      expect((gcc as any).finalizedSeqs.has(1)).toBe(true);
      expect(gcc.availableBitrate).toBeGreaterThan(0);
    });

    test("RTCRtpSender は GCC 差し替え後に pin 25ms ProcessInterval で process する", () => {
      // Arrange: production wiring（runRtcp の 500–1500ms ではなく 25ms）
      vi.useFakeTimers();
      const gcc = new GccBandwidthEstimator(300_000);
      const spy = vi.spyOn(gcc, "process");
      const sender = new RTCRtpSender("video");
      try {
        sender.setBandwidthEstimator(gcc);

        // Act: pin kUpdateIntervalMs
        expect(kGoogCcProcessIntervalMs).toBe(25);
        expect(spy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(kGoogCcProcessIntervalMs);
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
        vi.advanceTimersByTime(kGoogCcProcessIntervalMs);
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);

        // Assert: stop で timer が止まる
        sender.stop();
        const n = spy.mock.calls.length;
        vi.advanceTimersByTime(kGoogCcProcessIntervalMs * 4);
        expect(spy.mock.calls.length).toBe(n);
      } finally {
        sender.stop();
        vi.useRealTimers();
      }
    });

    test("estimator swap で旧 GCC の ProcessInterval timer が止まる", () => {
      vi.useFakeTimers();
      const gcc = new GccBandwidthEstimator(300_000);
      const spy = vi.spyOn(gcc, "process");
      const sender = new RTCRtpSender("video");
      try {
        sender.setBandwidthEstimator(gcc);
        vi.advanceTimersByTime(kGoogCcProcessIntervalMs);
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);

        // Act: legacy に差し替え
        sender.setBandwidthEstimator(new SenderBandwidthEstimator());
        const n = spy.mock.calls.length;
        vi.advanceTimersByTime(kGoogCcProcessIntervalMs * 4);

        // Assert: 旧 instance へはもう process しない
        expect(spy.mock.calls.length).toBe(n);
      } finally {
        sender.stop();
        vi.useRealTimers();
      }
    });

    test("receiveTWCC は wall/receive 混在 heuristic を使わず feedback_time=sender clock", () => {
      // Arrange: synthetic send と wall が乖離しても injectable clock なら正常 RTT
      const t0 = 1000;
      const { gcc, setNow } = createClockGcc(200_000, t0);
      for (let i = 1; i <= 8; i++) {
        gcc.rtpPacketSent(sent(i, 400, t0 + i * 10));
      }
      // feedback は send から 50ms 後（propagation 低）
      setNow(t0 + 80 + 50);
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 8 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 30 + i * 10,
            });
          }),
        ),
      );

      // Assert: 旧 heuristic 無しでも CorrectedRtt は low（clock domain 一致）
      expect((gcc as any).lastPropagationRttMs).toBeLessThan(200);
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(false);
      expect(gcc.availableBitrate).toBeGreaterThan(0);
    });

    test("high propagation RTT 中は complete 後の recovery probe が開始されない（send/TWCC 配線）", () => {
      // Arrange: public path で initial probe を send-fill + timeout → complete
      const gcc = new GccBandwidthEstimator(100_000);
      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));

      // ensureProbing + 3x/6x send-fill（ACK なし → result timeout で complete）
      let seq = 1;
      const fillAt = (base: number, count: number) => {
        for (let i = 0; i < count; i++) {
          gcc.rtpPacketSent(sent(seq++, 400, base + i, { isProbation: true }));
        }
      };
      // 3x minPackets=5
      fillAt(1_000, 5);
      // 6x
      fillAt(1_010, 5);
      // result-wait 1s 超えで complete（ProcessInterval。OnSentPacket では進めない）
      const timeoutAt = 1_010 + 1_100;
      gcc.rtpPacketSent(sent(seq++, 200, timeoutAt));
      gcc.process(timeoutAt);
      expect(gcc.probeState).toBe("complete");

      // cooldown 経過後の media + high propagation RTT TWCC
      const before = probeCfgs.length;
      const highT0 = Date.now() - 3_500;
      const media0 = seq;
      for (let i = 0; i < 12; i++) {
        gcc.rtpPacketSent(sent(media0 + i, 500, highT0 + i * 5));
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 12 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: media0 + i,
              received: true,
              receivedAtMs: highT0 + 40 + i * 5,
            });
          }),
        ),
      );

      // Assert: high RTT 記録 + この TWCC で新しい probe cluster が増えない
      expect((gcc as any).rttBackoff.isRttAboveLimit()).toBe(true);
      expect(probeCfgs.length).toBe(before);
      expect(gcc.probeState).toBe("complete");
      expect(gcc.shouldTagProbePacket()).toBe(false);
    });

    test("rising probe は acked×2 で cap されず delay path にそのまま載る", () => {
      // Arrange: pin は upward cap なし — probe 1.8M を SetEstimate
      const gcc = new GccBandwidthEstimator(300_000);
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probe.pendingEstimateBps = 1_800_000;
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 300_000;
      (gcc as any).lossBasedBps = 300_000;
      (gcc as any)._availableBitrate = 300_000;
      (gcc as any).probingConfigured = true;
      (gcc as any).lastUsage = "normal";
      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => "normal",
        configurable: true,
      });
      // loss は delay をそのまま返す（ready 前 / delay_based）
      (gcc as any).lossBwe.update = (_lf: number, delayBasedBps: number) => {
        (gcc as any).lossBwe.state = "delay_based";
        return delayBasedBps;
      };
      (gcc as any).ackedBitrate.incomingPacketFeedbackVector(
        Array.from({ length: 12 }, (_, i) => ({
          receiveTimeMs: 1_000 + i * 10,
          sendTimeMs: 1_000 + i * 10,
          sizeBytes: 375, // ~300kbps-ish
        })),
      );

      const t0 = Date.now();
      for (let i = 1; i <= 8; i++) {
        gcc.rtpPacketSent(sent(i, 500, t0 + i * 10));
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 8 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 20 + i * 10,
            });
          }),
        ),
      );

      // Assert: 旧 acked×2=600k ではなく probe 1.8M が delay/target に載る
      expect(gcc.availableBitrate).toBeGreaterThan(600_000);
      expect(gcc.availableBitrate).toBe(1_800_000);
    });

    test("probe 適用後に LossBased が再更新され post-loss cause を使う", () => {
      // Arrange: high probe pending + loss update sees elevated delay
      const gcc = new GccBandwidthEstimator(200_000);
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "waiting_for_result";
      (gcc as any).probe.minBitrateToProbeFurther = 50_000;
      (gcc as any).probe.pendingEstimateBps = 800_000;
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 200_000;
      (gcc as any).lossBasedBps = 200_000;
      (gcc as any)._availableBitrate = 200_000;
      (gcc as any).probingConfigured = true;
      (gcc as any).lastUsage = "normal";
      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => "normal",
        configurable: true,
      });
      (gcc as any).ackedBitrate.incomingPacketFeedbackVector(
        Array.from({ length: 15 }, (_, i) => ({
          receiveTimeMs: 1_000 + i * 10,
          sendTimeMs: 1_000 + i * 10,
          sizeBytes: 1_250,
        })),
      );

      const delayArgs: number[] = [];
      let lossCalls = 0;
      (gcc as any).lossBwe.update = (
        _lf: number,
        delayBasedBps: number,
        ..._rest: unknown[]
      ) => {
        lossCalls++;
        delayArgs.push(delayBasedBps);
        // Loss still binds after elevated probe delay
        (gcc as any).lossBwe.state = "decreasing";
        return Math.min(delayBasedBps, 250_000);
      };
      // Ensure setBandwidthEstimate is NOT used to wipe state before loss
      let setBwCalls = 0;
      (gcc as any).lossBwe.setBandwidthEstimate = () => {
        setBwCalls++;
      };

      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));

      const t0 = Date.now();
      for (let i = 1; i <= 10; i++) {
        gcc.rtpPacketSent(sent(i, 500, t0 + i * 10));
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 10 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 20 + i * 10,
            });
          }),
        ),
      );

      // Assert: loss は probe 後の elevated delay で 1 回更新
      expect(lossCalls).toBe(1);
      expect(delayArgs[0]).toBeGreaterThan(200_000);
      expect(setBwCalls).toBe(0);
      // post-loss decreasing → further probe 禁止
      expect(probeCfgs).toEqual([]);
      // final target is loss-limited
      expect(gcc.availableBitrate).toBeLessThanOrEqual(250_000);
    });

    test("loss increasing 中の further probe は estimated×1.5 で cap される", () => {
      // Arrange: ProbeController 単体 — cause cap を InitiateProbing 相当で適用
      // further は waiting_for_result の間のみ（pin SetEstimatedBitrate）
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      probe.abort(1_000);
      (probe as any).state = "waiting_for_result";
      (probe as any).minBitrateToProbeFurther = 100_000;

      const estimated = 400_000;
      const maxProbe = estimated * kLossLimitedProbeScale; // 600kbps
      // Act: further の uncapped は 400k×2=800k → cap 600k + stopFurther
      const further = probe.setEstimatedBitrate(estimated, 10_000, {
        maxProbeBps: maxProbe,
      });
      // Assert
      expect(further.length).toBe(1);
      expect(further[0].targetBps).toBe(maxProbe);
      expect(probe.furtherProbeThresholdBps).toBe(Number.POSITIVE_INFINITY);

      // 同じ cap では追加 further なし
      const again = probe.setEstimatedBitrate(estimated, 10_100, {
        maxProbeBps: maxProbe,
      });
      expect(again).toEqual([]);
    });

    test("loss increasing 中の recovery probe は 0.85×pre-drop を cause cap する", () => {
      // Arrange: 400k → 200k drop。pin target 340k を loss-increasing 1.5×=300k で cap
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      probe.abort(1_000);
      (probe as any).state = "complete";
      probe.setAlrStartTime(9_000);
      probe.setEstimatedBitrate(400_000, 9_000);
      probe.setEstimatedBitrate(200_000, 9_100, {
        cause: "loss_limited_bwe_increasing",
      });

      const estimated = 200_000;
      const maxProbe = estimated * kLossLimitedProbeScale; // 300kbps
      const recovery = probe.requestProbe(estimated, 10_000, {
        maxProbeBps: maxProbe,
      });
      // Assert: 340k は 300k に clamp。further は開かない
      expect(recovery.length).toBe(1);
      expect(recovery[0].targetBps).toBe(maxProbe);
      expect(probe.furtherProbeThresholdBps).toBe(Number.POSITIVE_INFINITY);
    });

    test("loss increasing でも GCC full-path で further が scale cap される", () => {
      // Arrange: waiting_for_result + further 可能 + loss=increasing + rising probe
      // （pin: SetEstimatedBitrate further は waiting 中のみ。complete では再開しない）
      // 注意: rtpPacketSent → process() は empty waiting を complete に落とすため、
      // waiting / further threshold / pending は TWCC 直前に注入する。
      const gcc = new GccBandwidthEstimator(200_000);
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(0);
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 200_000;
      (gcc as any).lossBasedBps = 200_000;
      (gcc as any)._availableBitrate = 200_000;
      (gcc as any).probingConfigured = true;
      (gcc as any).lastUsage = "normal";
      (gcc as any).rttBackoff.reset();
      (gcc as any).rttBackoff.updatePropagationRtt(Date.now(), 100);
      (gcc as any).lossBwe.update = () => {
        (gcc as any).lossBwe.state = "increasing";
        return 200_000;
      };

      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => "normal",
        configurable: true,
      });

      // acked を十分高くして rising probe が cap で落ちないようにする
      (gcc as any).ackedBitrate.incomingPacketFeedbackVector(
        Array.from({ length: 15 }, (_, i) => ({
          receiveTimeMs: 1_000 + i * 10,
          sendTimeMs: 1_000 + i * 10,
          sizeBytes: 500,
        })),
      );

      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));

      const t0 = Date.now();
      for (let i = 1; i <= 12; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 500,
          sendingAtMs: t0 + i * 20,
          isProbation: false,
        } as any);
      }

      // Act 準備: process 後に waiting session を開き直す
      (gcc as any).probe.state = "waiting_for_result";
      (gcc as any).probe.minBitrateToProbeFurther = 50_000;
      (gcc as any).probe.pendingEstimateBps = 400_000;
      // empty waiting が process で complete に落ちないよう dummy awaiting を残す
      (gcc as any).probe.awaitingResults.set(9999, {
        config: {
          id: 9999,
          targetBps: 100_000,
          minPackets: 5,
          minDurationMs: 15,
          minBytes: 1000,
        },
        startMs: t0,
        sentBytes: 1000,
        sentPackets: 5,
        firstSendMs: t0,
        lastSendMs: t0 + 50_000, // process の 1s timeout を避ける
        ackedBytes: 0,
        ackedPackets: 0,
        firstAckedSendMs: 0,
        lastAckedSendMs: 0,
        sizeLastAckedSend: 0,
        firstRecvMs: 0,
        lastRecvMs: 0,
        sizeFirstRecv: 0,
        resultAccepted: false,
      });

      // Act
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 12 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 30 + i * 20,
            });
          }),
        ),
      );

      // Assert: further が起動し、target ≤ accepted×1.5（pin loss_limited_scale）
      expect(probeCfgs.length).toBeGreaterThanOrEqual(1);
      const accepted = Math.max(...probeCfgs);
      // pending 400k 適用後 target≈400k → further uncapped 800k → cap 600k
      expect(accepted).toBeLessThanOrEqual(
        400_000 * kLossLimitedProbeScale + 1,
      );
      expect(accepted).toBeLessThan(400_000 * 2);
    });

    test("max ちょうど一致する initial probe は further を止める（>=）", () => {
      // Arrange: start=100kbps, max=600kbps → initial [300, 600]
      // libwebrtc: 600 >= max → probe_further=false
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 600_000, 0);
      expect(probe.currentProbeTargetBps).toBe(300_000);
      expect(probe.queuedClusterCount).toBe(1);
      // Assert: exact-max で further threshold が Infinity
      expect(probe.furtherProbeThresholdBps).toBe(Number.POSITIVE_INFINITY);

      // Act: 3x/6x send-fill + valid ACK まで進め complete へ
      let lastSend = 0;
      for (let i = 0; i < 5; i++) {
        lastSend = 1_000 + i;
        probe.onProbePacketSent(300, lastSend, i + 1);
      }
      for (let i = 0; i < 5; i++) {
        lastSend = 1_100 + i;
        probe.onProbePacketSent(300, lastSend, 10 + i);
      }
      for (let i = 0; i < 5; i++) {
        probe.onAckedPacket(300, 1_120 + i * 2, true, 10 + i, lastSend + 50);
      }
      // Act: 6x の lastSend から 1s 超で controller complete
      probe.process(lastSend + 1_001);
      expect(probe.probeState).toBe("complete");

      // Assert: 高 estimate でも further は増えない
      (probe as any).lastProbeEndMs = Number.NEGATIVE_INFINITY;
      const further = probe.setEstimatedBitrate(500_000, 10_000);
      expect(further).toEqual([]);
      expect(probe.queuedClusterCount).toBe(0);
    });

    test("congestion feedback は active probe を abort しない", () => {
      // Arrange: GCC が probing 中に overuse + batch loss を受けても
      // pacing 中の cluster は send-fill まで継続する。
      // receiveTWCC は pin OnTransportPacketsFeedback 相当で Process しない。
      // 合成タイムラインでも pacing timeout は発火しない。
      const gcc = new GccBandwidthEstimator(100_000);
      const t0 = 40_000;
      // ensureProbing → 3x active
      gcc.rtpPacketSent({
        wideSeq: 1,
        size: 300,
        sendingAtMs: t0,
        isProbation: true,
      } as any);
      expect(gcc.shouldTagProbePacket()).toBe(true);
      expect(gcc.suggestedProbeBitrateBps).toBe(300_000);

      // partial probe sends (not yet fill: 3 packets < minPackets=5)
      for (let i = 2; i <= 3; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 300,
          sendingAtMs: t0 + i,
          isProbation: true,
        } as any);
      }
      // media-looking packets for loss fraction in TWCC
      for (let i = 10; i <= 20; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 500,
          sendingAtMs: t0 + i * 5,
          isProbation: false,
        } as any);
      }

      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => "overuse",
        configurable: true,
      });

      // Act: 10% loss batch (1 lost / 10 known media) + overuse
      const results = Array.from({ length: 10 }, (_, i) => {
        const seq = 10 + i;
        return new PacketResult({
          sequenceNumber: seq,
          received: i !== 0, // 1 lost → 10%
          receivedAtMs: t0 + 100 + i * 10,
        });
      });
      gcc.receiveTWCC(makeTwccFeedback(results));

      // Assert: active probe は abort されていない（3x pacing 継続）
      expect(gcc.shouldTagProbePacket()).toBe(true);
      expect(gcc.suggestedProbeBitrateBps).toBe(300_000);
      expect((gcc as any).probe.probeState).toBe("waiting_for_result");
      // 6x も queue に残る
      expect((gcc as any).probe.queuedClusterCount).toBe(1);
    });

    test("使用済み estimator の再注入で reset され履歴が残らない", async () => {
      // Arrange: 一度 TWCC を処理して availableBitrate を立てる
      const gcc = new GccBandwidthEstimator(300_000);
      const t0 = 20_000;
      for (let i = 0; i < 20; i++) {
        gcc.rtpPacketSent(sent(i + 1, 800, t0 + i * 20));
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 20 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 30 + i * 20,
            });
          }),
        ),
      );
      expect(gcc.availableBitrate).toBeGreaterThan(0);
      const usedBitrate = gcc.availableBitrate;

      // Act: 別 sender に同じインスタンスを注入 → setBandwidthEstimator が reset
      const { sender } = await prepareConnectedSender();
      sender.setBandwidthEstimator(gcc);

      // Assert: 履歴クリア（availableBitrate は 0 に戻る）
      expect(gcc.availableBitrate).toBe(0);
      expect(gcc.availableBitrate).not.toBe(usedBitrate);
      // 再観測なしでは通知しない
      const fired: number[] = [];
      sender.onAvailableBitrate.subscribe((v) => fired.push(v));
      expect(fired).toEqual([]);
    });

    test("送信中の estimator 差し替えで in-flight が新 estimator を汚染しない", async () => {
      // Arrange: 旧 GCC で send を開始し、await sendRtp 中に差し替える
      const oldGcc = new GccBandwidthEstimator(300_000);
      const newGcc = new GccBandwidthEstimator(100_000);
      const { sender, dtls } = await prepareConnectedSender(oldGcc);

      let releaseSend!: () => void;
      const holdSend = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      let resolveHeld!: (size: number) => void;
      const heldSize = new Promise<number>((resolve) => {
        resolveHeld = resolve;
      });

      // 最初の 1 パケットだけ DTLS send をブロックして差し替えウィンドウを作る
      let blockedOnce = false;
      const originalSendRtp = dtls.sendRtp.bind(dtls);
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        if (!blockedOnce) {
          blockedOnce = true;
          await holdSend;
          const size = payload.length + header.serializeSize;
          resolveHeld(size);
          return size;
        }
        return originalSendRtp(payload, header);
      }) as typeof dtls.sendRtp;

      const oldSpy = vi.spyOn(oldGcc, "rtpPacketSent");
      const newSpy = vi.spyOn(newGcc, "rtpPacketSent");

      // Act: media 送信を開始（sendRtp 内で await 中）
      const sendPromise = sender.sendRtp(
        new RtpPacket(
          new RtpHeader({
            sequenceNumber: 1,
            timestamp: 1000,
            payloadType: 96,
            ssrc: 1,
            extension: true,
            extensions: [],
            marker: false,
            padding: false,
            payloadOffset: 12,
          }),
          Buffer.alloc(200),
        ),
      );

      // 送信が DTLS で止まっている間に estimator を差し替え
      await Promise.resolve();
      await Promise.resolve();
      sender.setBandwidthEstimator(newGcc);
      expect(sender.senderBWE).toBe(newGcc);
      expect(newGcc.availableBitrate).toBe(0);

      // in-flight を完了
      releaseSend();
      await heldSize;
      await sendPromise;

      // Assert: 差し替え後に完了したパケットは新 estimator に渡らない
      // （世代不一致で discard）。旧も dispose 済みなので汚染しない。
      expect(newSpy).not.toHaveBeenCalled();
      // 新 estimator はクリーン（差し替え時 reset + in-flight 非配送）
      expect(newGcc.availableBitrate).toBe(0);
      expect((newGcc as any).sentInfos?.size ?? 0).toBe(0);

      // 差し替え後の新規送信は新 estimator のみに届く
      await sender.sendRtp(
        new RtpPacket(
          new RtpHeader({
            sequenceNumber: 2,
            timestamp: 2000,
            payloadType: 96,
            ssrc: 1,
            extension: true,
            extensions: [],
            marker: false,
            padding: false,
            payloadOffset: 12,
          }),
          Buffer.alloc(200),
        ),
      );
      expect(newSpy).toHaveBeenCalled();
      expect(newSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      // 旧への post-swap 配送はない（dispose 後に呼ばれても世代 discard）
      // oldSpy は差し替え前の同期経路で 0 回、または in-flight 完了時も discard
      const oldCallsAfterSwap = oldSpy.mock.calls.length;
      expect(oldCallsAfterSwap).toBe(0);
    });

    test("差し替えで in-flight probe padding が旧 estimator を再駆動しない", async () => {
      // Arrange: GCC probe padding を非同期開始し、途中で legacy に差し替え
      const gcc = new GccBandwidthEstimator(1_000_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);

      let releaseFirst!: () => void;
      const holdFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstHeld = false;
      const originalSendRtp = dtls.sendRtp.bind(dtls);
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        if (!firstHeld) {
          firstHeld = true;
          await holdFirst;
        }
        return originalSendRtp(payload, header);
      }) as typeof dtls.sendRtp;

      const pendingSpy = vi.spyOn(gcc, "pendingProbePaddingPackets");
      const sentSpy = vi.spyOn(gcc, "rtpPacketSent");

      // Act: padding 注入を開始（最初の send で止まる）
      const padPromise = sender.maybeInjectProbePadding();
      await Promise.resolve();
      await Promise.resolve();

      // 差し替え → generation bump で padding ループは cancel
      const legacy = new SenderBandwidthEstimator();
      sender.setBandwidthEstimator(legacy);
      releaseFirst();
      const n = await padPromise;

      // Assert: dispose 後に pendingProbePaddingPackets で probe を再生成しない
      // （差し替え前の呼び出し回数で止まり、dispose 後の追加呼び出しなし）
      const callsAtEnd = pendingSpy.mock.calls.length;
      // 差し替え後にさらに drain しようとして呼ばれていないことを、
      // イベントループを回してから再確認
      await Promise.resolve();
      await Promise.resolve();
      expect(pendingSpy.mock.calls.length).toBe(callsAtEnd);
      // 新 (legacy) は probe 非対応 — 旧への rtpPacketSent も in-flight discard で 0 可
      expect(isProbePacingController(sender.senderBWE)).toBe(false);
      // n は 0 以上（最初の 1 パケットが wire に出る場合あり）だが、
      // 差し替え後の大量完遂にはならない
      expect(n).toBeLessThan(16);
      void sentSpy;
    });

    test("recovery probe は 0.85×pre-drop の単発で ALR probe 間隔を守る", () => {
      // Arrange: 700k → 150k の large drop + ALR
      const probe = new ProbeController();
      probe.setBitrates(10_000, 700_000, 1_000_000_000, 0);
      probe.abort(2_000);
      (probe as any).state = "complete";
      probe.setAlrStartTime(9_000);
      probe.setEstimatedBitrate(700_000, 9_000);
      probe.setEstimatedBitrate(150_000, 9_100, {
        cause: "delay_based_limited",
      });

      // Act
      const recovery = probe.requestProbe(150_000, 10_000);

      // Assert: pin 0.85 × 700k。start×1.5 ではない。further なし
      expect(recovery.length).toBe(1);
      expect(recovery[0].targetBps).toBe(700_000 * kProbeFractionAfterDrop);
      expect(probe.furtherProbeThresholdBps).toBe(Number.POSITIVE_INFINITY);

      // Act: 5s 未満の再 RequestProbe は拒否
      (probe as any).state = "complete";
      (probe as any).queue = [];
      const denied = probe.requestProbe(150_000, 10_500);
      expect(denied).toEqual([]);
    });

    test("ALR 終了後 3s 以内なら RequestProbe が 0.85×pre-drop を出す", () => {
      // Arrange: pin kAlrEndedTimeout=3s。ALR 終了直後も recovery 可
      const probe = new ProbeController();
      probe.setBitrates(10_000, 200_000, 1e9, 0);
      probe.abort(1_000);
      (probe as any).state = "complete";
      probe.setAlrStartTime(undefined);
      probe.setAlrEndedTime(9_000);
      probe.setEstimatedBitrate(800_000, 8_000);
      probe.setEstimatedBitrate(200_000, 8_500, {
        cause: "delay_based_limited",
      });

      // Act: ALR 終了から 2s
      const recovery = probe.requestProbe(200_000, 11_000);

      // Assert
      expect(recovery.length).toBe(1);
      expect(recovery[0].targetBps).toBe(800_000 * kProbeFractionAfterDrop);
      expect(probe.furtherProbeThresholdBps).toBe(Number.POSITIVE_INFINITY);

      // Act: 3s 超は出さない（drop probe 間隔は別要因なので解除）
      (probe as any).state = "complete";
      (probe as any).queue = [];
      (probe as any).lastBweDropProbingMs = Number.NEGATIVE_INFINITY;
      expect(probe.requestProbe(200_000, 12_001)).toEqual([]);
    });

    test("初期 probe は pin 同様 upward cap なしで start×1.5 を超えられる", () => {
      // Arrange: cold start — pin は rising probe を Aimd SetEstimate にそのまま渡す
      const start = 100_000;
      const gcc = new GccBandwidthEstimator(start);
      gcc.shouldTagProbePacket();
      expect(gcc.probeState).toBe("waiting_for_result");

      // Act 1: 高レート initial probe
      const n = 20;
      const base = 20_000;
      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(
          sent(i + 1, 1400, base + i * 2, { isProbation: true }),
        );
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: n }, (_, i) => {
            const sendMs = base + i * 2;
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: sendMs + 3 + i * 2,
            });
          }),
        ),
      );
      const afterInitial = gcc.availableBitrate;
      // Assert: pin に upward acked×2 / delay×1.5 cap はない → start×1.5 超え可
      expect(afterInitial).toBeGreaterThan(start * 1.5);

      // Act 2: complete まで進め、低い delay/loss target に戻してから recovery
      // process timeout で active を落として complete にする
      for (let t = 0; t < 6; t++) {
        gcc.rtpPacketSent(sent(500 + t, 200, base + 10_000 + t * 2_000));
      }
      // 強制 complete + 低 target 状態を作るため reset せず probe 完了を待つ
      if (gcc.probeState !== "complete") {
        // 追加 probation で残り cluster を消化
        for (let i = 0; i < 25; i++) {
          gcc.rtpPacketSent(
            sent(1000 + i, 1200, base + 30_000 + i * 2, {
              isProbation: true,
            }),
          );
        }
        gcc.receiveTWCC(
          makeTwccFeedback(
            Array.from({ length: 25 }, (_, i) => {
              const sendMs = base + 30_000 + i * 2;
              return new PacketResult({
                sequenceNumber: 1000 + i,
                received: true,
                receivedAtMs: sendMs + 4 + i * 2,
              });
            }),
          ),
        );
      }

      // 低容量相当: 高損失で loss/delay を抑える（複数 observation）
      const lowBase = base + 60_000;
      for (let batch = 0; batch < 4; batch++) {
        const seq0 = 2000 + batch * 40;
        const t0 = lowBase + batch * 400;
        for (let i = 0; i < 40; i++) {
          gcc.rtpPacketSent(sent(seq0 + i, 800, t0 + i * 30));
        }
        gcc.receiveTWCC(
          makeTwccFeedback(
            Array.from({ length: 40 }, (_, i) => {
              const lost = i % 2 === 0;
              return new PacketResult({
                sequenceNumber: seq0 + i,
                received: !lost,
                receivedAtMs: lost ? 0 : t0 + 40 + i * 40,
              });
            }),
          ),
        );
      }
      const afterLoss = gcc.availableBitrate;
      // 日本語: 高損失後は初期 probe 成功時より高く張り付かない
      expect(afterLoss).toBeLessThanOrEqual(afterInitial);
      expect(afterLoss).toBeLessThan(afterInitial * 1.01);

      // recovery 探索 target は ProbeController.requestProbe が scale（start 張り付きなし）
      // rising probe 自体に delay×1.5 / acked×2 の upward cap は無い（pin 準拠）
      expect(gcc.availableBitrate).toBeGreaterThan(0);
    });

    test("高レート (≤5ms spacing) でも inter-arrival group が閉じ delay 推定が進む", () => {
      // Arrange
      const ia = new InterArrivalDelta(5);
      const deltas: number[] = [];
      // Act: 2ms 間隔で 50 パケット（合計 100ms）
      for (let i = 0; i < 50; i++) {
        const d = ia.computeDeltas(
          i * 2,
          1000 + i * 2 + (i > 20 ? i : 0),
          1200,
        );
        if (d) deltas.push(d.sendDeltaMs);
      }
      // Assert: firstSend を固定しているため 5ms 超で group が閉じる
      expect(deltas.length).toBeGreaterThan(5);
      // 各 group の send delta は group length オーダー
      expect(deltas.every((x) => x >= 5)).toBe(true);
    });

    test("TransportWideCC example2 の packetResults が 14 件展開される", () => {
      // Arrange: リポジトリ fixture example2（2× StatusVectorChunk）
      const data = Buffer.from([
        0xaf, 0xcd, 0x0, 0x6, 0xfa, 0x17, 0xfa, 0x17, 0x19, 0x3d, 0xd8, 0xbb,
        0x1, 0x74, 0x0, 0xe, 0x45, 0xb1, 0x5a, 0x40, 0xd8, 0x0, 0xf0, 0xff,
        0xd0, 0x0, 0x0, 0x1,
      ]);
      const [rtpfb] = RtcpPacketConverter.deSerialize(data) as [
        RtcpTransportLayerFeedback,
      ];
      const twcc = rtpfb.feedback as TransportWideCC;

      // Act
      const results = twcc.packetResults;

      // Assert
      expect(twcc.packetStatusCount).toBe(14);
      expect(results.length).toBe(14);
      expect(results[0].sequenceNumber).toBe(372);
      expect(results[13].sequenceNumber).toBe((372 + 13) & 0xffff);
      // 先頭は small/large delta 受信
      expect(results[0].received).toBe(true);
      expect(results[0].receivedAtMs).toBeGreaterThan(0);
      // not received シンボル
      expect(results.some((r) => !r.received)).toBe(true);
    });

    test("複数 RunLengthChunk で sequence cursor が進む", () => {
      // Arrange
      const twcc = new TransportWideCC({
        senderSsrc: 1,
        mediaSourceSsrc: 2,
        baseSequenceNumber: 100,
        packetStatusCount: 5,
        referenceTime: 10,
        fbPktCount: 0,
        packetChunks: [
          new RunLengthChunk({
            packetStatus: PacketStatus.TypeTCCPacketReceivedSmallDelta,
            runLength: 2,
          }),
          new RunLengthChunk({
            packetStatus: PacketStatus.TypeTCCPacketNotReceived,
            runLength: 3,
          }),
        ],
        recvDeltas: [
          new RecvDelta({
            type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
            delta: 1000,
          }),
          new RecvDelta({
            type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
            delta: 1000,
          }),
        ],
      });

      // Act
      const results = twcc.packetResults;

      // Assert
      expect(results.map((r) => r.sequenceNumber)).toEqual([
        100, 101, 102, 103, 104,
      ]);
      expect(results.filter((r) => r.received).length).toBe(2);
      expect(results.filter((r) => !r.received).length).toBe(3);
    });

    test("gap を含む TWCC wire round-trip で PacketNotReceived が復元される", () => {
      // Arrange: received 100, 102 → status received, not-received, received
      // recv deltas は 250us 単位に量子化されるため、parseDelta 後の値に合わせる
      const twcc = new TransportWideCC({
        senderSsrc: 1,
        mediaSourceSsrc: 2,
        baseSequenceNumber: 100,
        packetStatusCount: 3,
        referenceTime: 100,
        fbPktCount: 0,
        packetChunks: [
          new RunLengthChunk({
            packetStatus: PacketStatus.TypeTCCPacketReceivedSmallDelta,
            runLength: 1,
          }),
          new RunLengthChunk({
            packetStatus: PacketStatus.TypeTCCPacketNotReceived,
            runLength: 1,
          }),
          new RunLengthChunk({
            packetStatus: PacketStatus.TypeTCCPacketReceivedSmallDelta,
            runLength: 1,
          }),
        ],
        recvDeltas: [
          new RecvDelta({
            type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
            delta: 1000, // us before parse — serialize will parse if needed
          }),
          new RecvDelta({
            type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
            delta: 1000,
          }),
        ],
      });
      // Ensure deltas are wire-ready
      for (const d of twcc.recvDeltas) {
        if (!d.parsed) d.parseDelta();
      }

      // Act: serialize → deserialize → packetResults
      const wire = new RtcpTransportLayerFeedback({
        feedback: twcc,
      }).serialize();
      const [rtpfb] = RtcpPacketConverter.deSerialize(wire) as [
        RtcpTransportLayerFeedback,
      ];
      const restored = rtpfb.feedback as TransportWideCC;
      const results = restored.packetResults;

      // Assert
      expect(restored.packetStatusCount).toBe(3);
      expect(restored.baseSequenceNumber).toBe(100);
      expect(results.length).toBe(3);
      expect(results[0].sequenceNumber).toBe(100);
      expect(results[0].received).toBe(true);
      expect(results[1].sequenceNumber).toBe(101);
      expect(results[1].received).toBe(false);
      expect(results[2].sequenceNumber).toBe(102);
      expect(results[2].received).toBe(true);
      // status count と received deltas の整合（deserialize が完走している）
      expect(restored.recvDeltas.length).toBe(2);
    });

    test("16-bit wrap の packetResults 順序は 65534..1", () => {
      // Arrange
      const results = [
        new PacketResult({
          sequenceNumber: 0,
          received: true,
          receivedAtMs: 3,
        }),
        new PacketResult({
          sequenceNumber: 1,
          received: true,
          receivedAtMs: 4,
        }),
        new PacketResult({
          sequenceNumber: 65534,
          received: true,
          receivedAtMs: 1,
        }),
        new PacketResult({
          sequenceNumber: 65535,
          received: true,
          receivedAtMs: 2,
        }),
      ];
      // Act
      const sorted = sortPacketResultsByWideSeq(results);
      // Assert
      expect(sorted.map((r) => r.sequenceNumber)).toEqual([65534, 65535, 0, 1]);
    });

    test("receivedAtMs=0 でも SmallDelta は delay サンプルとして受理する", () => {
      // Arrange: reference_time base 0 + first delta → receivedAtMs が 0 になり得る
      const gcc = new GccBandwidthEstimator(300_000);
      const n = 30;
      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(sent(i + 1, 800, 100 + i * 20));
      }
      const results = Array.from({ length: n }, (_, i) => {
        return new PacketResult({
          sequenceNumber: i + 1,
          received: true,
          // Explicit small-delta status; receivedAtMs may be 0 for the first sample.
          status: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          receivedAtMs: i === 0 ? 0 : i * 20,
        });
      });
      // Act
      gcc.receiveTWCC(makeTwccFeedback(results));
      // Assert: falsy 判定だと 0 を捨てて推定が進まない。0 は有効な時刻。
      expect(
        hasTwccReceiveTiming(
          new PacketResult({
            received: true,
            status: PacketStatus.TypeTCCPacketReceivedSmallDelta,
            receivedAtMs: 0,
          }),
        ),
      ).toBe(true);
      expect(
        hasTwccReceiveTiming(
          new PacketResult({
            received: true,
            status: PacketStatus.TypeTCCPacketReceivedWithoutDelta,
            receivedAtMs: 0,
          }),
        ),
      ).toBe(false);
      expect(gcc.availableBitrate).toBeGreaterThan(0);
    });

    test("finalizedSeqs の orphan は wholesale clear せず sentInfos 連動で削除する", () => {
      // Arrange: finalize 済み seq が sentInfos から外れた後も再処理されないこと
      const gcc = new GccBandwidthEstimator(300_000);
      const t0 = 300_000;
      for (let i = 1; i <= 5; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 200,
          sendingAtMs: t0 + i,
          isProbation: false,
        } as any);
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 5 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 20 + i,
            });
          }),
        ),
      );
      expect((gcc as any).finalizedSeqs.has(1)).toBe(true);

      // Act: age-out prune（sendingAtMs を 60s 超にして rtpPacketSent）
      gcc.rtpPacketSent({
        wideSeq: 100,
        size: 200,
        sendingAtMs: t0 + kSendTimeHistoryWindowMs + 10,
        isProbation: false,
      } as any);

      // Assert: orphan finalized は消え、live seq だけ残る
      expect((gcc as any).sentInfos.has(1)).toBe(false);
      expect((gcc as any).finalizedSeqs.has(1)).toBe(false);
      // wholesale clear ではない: まだ sentInfos にある 100 は残しうる
      expect((gcc as any).sentInfos.has(100)).toBe(true);
    });

    test("same-feedback で probe result + loss があっても loss が post-probe delay で更新される", () => {
      // pin order: delay/probe SetEstimate → LossBased.update(post-probe delay)
      const gcc = new GccBandwidthEstimator(200_000);
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probe.lastProbeEndMs = 0;
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 200_000;
      (gcc as any).lossBasedBps = 200_000;
      (gcc as any)._availableBitrate = 200_000;
      (gcc as any).aimd.bitrateBps = 200_000;
      (gcc as any).probingConfigured = true;
      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => "normal",
        configurable: true,
      });

      const lossUpdateArgs: number[] = [];
      const origLossUpdate = (gcc as any).lossBwe.update.bind(
        (gcc as any).lossBwe,
      );
      (gcc as any).lossBwe.update = (
        lossFraction: number,
        delayBasedBps: number,
        ...rest: unknown[]
      ) => {
        lossUpdateArgs.push(delayBasedBps);
        return origLossUpdate(lossFraction, delayBasedBps, ...rest);
      };

      // upward probe pending
      (gcc as any).probe.pendingEstimateBps = 400_000;
      const t0 = 400_000;
      for (let i = 1; i <= 10; i++) {
        gcc.rtpPacketSent({
          wideSeq: i,
          size: 500,
          sendingAtMs: t0 + i * 30,
          isProbation: false,
        } as any);
      }
      // mixed loss in same feedback
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 10 }, (_, i) => {
            const lost = i % 3 === 0;
            return new PacketResult({
              sequenceNumber: i + 1,
              received: !lost,
              receivedAtMs: lost ? 0 : t0 + 40 + i * 30,
            });
          }),
        ),
      );

      // Assert: loss path は probe 適用後の delay (≥200k、可能なら ~400k) を入力に使う
      expect(lossUpdateArgs.length).toBeGreaterThan(0);
      expect(lossUpdateArgs[0]).toBeGreaterThanOrEqual(200_000);
      // probe が delay に載っていれば 200k を超える
      expect(lossUpdateArgs[0]).toBeGreaterThan(200_000);
    });

    test("sentInfos pruning は pin 60s 窓で、件数 2048 では切らない", () => {
      // Arrange: pin kSendTimeHistoryWindow=60s。高レート probe でも 2048 で落とさない
      const gcc = new GccBandwidthEstimator(300_000);
      const t0 = 100_000;
      // Act: 4098 packets in ~4s（60s 未満）
      for (let i = 0; i < 4098; i++) {
        gcc.rtpPacketSent(sent(i, 200, t0 + i));
      }
      const map = (gcc as any).sentInfos as Map<number, unknown>;
      // Assert: 時間窓内なら 2048 を超えて残る
      expect(map.size).toBeGreaterThan(2048);
      expect(map.has(0)).toBe(true);
      expect(map.has(4097)).toBe(true);

      // Act: 60s 超の古い packet だけ落ちる
      gcc.rtpPacketSent(sent(5000, 200, t0 + kSendTimeHistoryWindowMs + 1));
      expect((gcc as any).sentInfos.has(0)).toBe(false);
      expect((gcc as any).sentInfos.has(5000)).toBe(true);
    });

    test("process() は送信停止後も 60s 超の sentInfos を prune する", () => {
      // Arrange: 1 パケット送信後、rtpPacketSent は呼ばない
      const t0 = 80_000;
      const gcc = new GccBandwidthEstimator(300_000);
      gcc.rtpPacketSent(sent(1, 400, t0));
      gcc.rtpPacketSent(sent(2, 400, t0 + 10));
      expect((gcc as any).sentInfos.has(1)).toBe(true);
      expect((gcc as any).sentInfos.size).toBe(2);

      // Act: 送信停止後の periodic process（窓内）
      gcc.process(t0 + 30_000);

      // Assert: 60s 未満は late TWCC 用に残る
      expect((gcc as any).sentInfos.has(1)).toBe(true);
      expect((gcc as any).sentInfos.has(2)).toBe(true);

      // Act: packet 1 だけ 60s 超（packet 2 はまだ窓内）
      gcc.process(t0 + kSendTimeHistoryWindowMs + 1);

      // Assert: 期限切れだけ消え、新しい方は残る
      expect((gcc as any).sentInfos.has(1)).toBe(false);
      expect((gcc as any).sentInfos.has(2)).toBe(true);

      // Act: packet 2 も 60s 超
      gcc.process(t0 + 10 + kSendTimeHistoryWindowMs + 1);

      // Assert: process 経路だけで履歴が空になる（rtpPacketSent 依存ではない）
      expect((gcc as any).sentInfos.size).toBe(0);
      expect((gcc as any).finalizedSeqs.size).toBe(0);
      expect((gcc as any).softLostSeqs.size).toBe(0);
    });

    test("estimator dispose / reset は sentInfos と probe seq map を残さない", () => {
      // Arrange: 送信履歴と probe mapping を積む
      const gcc = new GccBandwidthEstimator(300_000);
      gcc.shouldTagProbePacket();
      gcc.rtpPacketSent(sent(1, 200, 1_000, { isProbation: true }));
      gcc.rtpPacketSent(sent(2, 200, 1_010, { isProbation: true }));
      expect((gcc as any).sentInfos.size).toBeGreaterThan(0);

      // Act
      gcc.dispose();

      // Assert: stop/dispose 後に履歴が残らない
      expect((gcc as any).sentInfos.size).toBe(0);
      expect((gcc as any).finalizedSeqs.size).toBe(0);
      expect((gcc as any).softLostSeqs.size).toBe(0);
      expect((gcc as any).probe.seqToCluster.size).toBe(0);
      expect((gcc as any).probe.seqToSendInfo.size).toBe(0);
    });

    test("RTCRtpSender.stop は世代無効化・padding 停止・estimator dispose する", async () => {
      // Arrange: GCC + 送信履歴 + probe mapping
      const gcc = new GccBandwidthEstimator(300_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      gcc.shouldTagProbePacket();
      gcc.rtpPacketSent(sent(1, 200, 1_000, { isProbation: true }));
      gcc.rtpPacketSent(sent(2, 200, 1_010, { isProbation: true }));
      expect((gcc as any).sentInfos.size).toBeGreaterThan(0);
      await Promise.resolve();
      await Promise.resolve();
      const sendsBeforeStop = (dtls.sendRtp as ReturnType<typeof vi.fn>).mock
        .calls.length;

      // Act
      sender.stop();

      // Assert: 履歴は dispose で解放される
      expect((gcc as any).sentInfos.size).toBe(0);
      expect((gcc as any).probe.seqToCluster.size).toBe(0);
      expect(
        ((gcc as any).lossBwe.partial.seenPackets as Map<number, number>).size,
      ).toBe(0);
      expect((gcc as any).disposed).toBe(true);

      // Act: stop 後の padding / send は何も送らない
      const n = await sender.maybeInjectProbePadding();
      await sender.sendRtp(
        new RtpPacket(
          new RtpHeader({
            sequenceNumber: 9,
            timestamp: 9,
            payloadType: 96,
            ssrc: 1,
            extension: true,
            extensions: [],
            marker: false,
            padding: false,
            payloadOffset: 12,
          }),
          Buffer.alloc(100),
        ),
      );

      // Assert: stop 後に追加の RTP / padding は出ない
      expect(n).toBe(0);
      expect((dtls.sendRtp as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        sendsBeforeStop,
      );
      expect(gcc.pendingProbePaddingPackets()).toBe(0);
    });

    test("stop と in-flight padding の競合で disposed estimator を再駆動しない", async () => {
      // Arrange: padding 注入を非同期開始し、途中で stop
      const gcc = new GccBandwidthEstimator(1_000_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);

      let releaseFirst!: () => void;
      const holdFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstHeld = false;
      const originalSendRtp = dtls.sendRtp.bind(dtls);
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        if (!firstHeld) {
          firstHeld = true;
          await holdFirst;
        }
        return originalSendRtp(payload, header);
      }) as typeof dtls.sendRtp;

      const pendingSpy = vi.spyOn(gcc, "pendingProbePaddingPackets");

      // Act: padding 開始（最初の send で止まる）→ stop
      const padPromise = sender.maybeInjectProbePadding();
      await Promise.resolve();
      await Promise.resolve();
      sender.stop();
      releaseFirst();
      const n = await padPromise;

      // Assert: stop 後に pendingProbe で probe を再生成しない
      const callsAtEnd = pendingSpy.mock.calls.length;
      await Promise.resolve();
      await Promise.resolve();
      expect(pendingSpy.mock.calls.length).toBe(callsAtEnd);
      expect(n).toBeLessThan(16);
      expect(gcc.pendingProbePaddingPackets()).toBe(0);
      expect((gcc as any).sentInfos.size).toBe(0);
    });

    test("PaddingDuration>0 の loss increase は increase_using_padding になり probe を禁止する", () => {
      // Arrange: pin PaddingDuration 有効時の state
      const loss = new LossBasedBwe();
      loss.reset(200_000);
      loss.setPaddingDurationMs(200);
      // delay を高くして loss-limited increase にする
      const t0 = 10_000;
      const r = loss.update(
        0,
        1_000_000,
        150_000,
        8,
        0,
        t0,
        1600,
        t0 + 300,
        0,
        Array.from({ length: 8 }, (_, i) => ({
          seq: i + 1,
          size: 200,
          received: true,
          sendMs: t0 + i * 40,
        })),
      );
      void r;

      // Act / Assert: padding duration 付きなら increase_using_padding
      // （観測が足りず delay_based のままなら skip しないよう state を直接確認）
      if (loss.observationCount >= 1 && loss.lossState !== "delay_based") {
        expect(loss.lossState).toBe("increase_using_padding");
      } else {
        // 観測不足で delay_based のときは setter 後の遷移を直接検証
        (loss as any).delayBasedBps = 1_000_000;
        (loss as any).updateState(200_000, 250_000, t0 + 400);
        expect(loss.lossState).toBe("increase_using_padding");
      }
      expect(
        getBandwidthLimitedCause("normal", false, "increase_using_padding"),
      ).toBe("loss_limited_bwe");
      expect(
        isProbeInitiationAllowed(
          getBandwidthLimitedCause("normal", false, "increase_using_padding"),
        ),
      ).toBe(false);
    });

    test("ALR 中の process は complete 後 5s で periodic probe を出す", () => {
      // Arrange: initial session を complete にして ALR probing を有効化
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      probe.abort(1_000);
      expect(probe.probeState).toBe("complete");
      probe.enablePeriodicAlrProbing(true);
      probe.setAlrStartTime(2_000);
      (probe as any).estimatedBps = 200_000;
      probe.setEstimatedBitrate(200_000, 2_000, {
        cause: "delay_based_limited",
      });

      // Act: 5s 未満は出さない
      expect(probe.process(2_000 + kAlrProbingIntervalMs - 1)).toEqual([]);

      // Act: ALR interval 経過
      const started = probe.process(2_000 + kAlrProbingIntervalMs);

      // Assert: estimated × alr_scale の cluster
      expect(started.length).toBe(1);
      expect(started[0].targetBps).toBe(200_000 * kAlrProbeScale);
      expect(probe.probeState).toBe("waiting_for_result");
    });

    test("default は first TWCC 後も ALR 5s で periodic probe を出さない", () => {
      // Arrange: pin enable_periodic_alr_probing_ 初期値は false
      const t0 = 110_000;
      const { gcc, setNow } = createClockGcc(1_000_000, t0);
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(t0);
      expect(gcc.probeState).toBe("complete");

      gcc.rtpPacketSent(sent(1, 200, t0));
      setNow(t0 + 20);
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 1,
            received: true,
            receivedAtMs: t0 + 10,
          }),
        ]),
      );
      (gcc as any).alr.startedMs = t0;
      setNow(t0 + 30);
      gcc.process(t0 + 30);

      // Act: ALR interval 経過
      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));
      setNow(t0 + kAlrProbingIntervalMs);
      gcc.process(t0 + kAlrProbingIntervalMs);

      // Assert: first TWCC でも自動 enable しない
      expect((gcc as any).probe.periodicAlrProbing).toBe(false);
      expect(probeCfgs).toEqual([]);
      expect(gcc.probeState).toBe("complete");
    });

    test("periodicAlrProbing:true なら ALR 5s 後に probe する", () => {
      // Arrange: 明示 opt-in（pin requests_alr_probing）
      const t0 = 120_000;
      const { gcc, setNow } = createClockGcc(1_000_000, t0, {
        periodicAlrProbing: true,
      });
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(t0);
      expect(gcc.probeState).toBe("complete");

      gcc.rtpPacketSent(sent(1, 200, t0));
      setNow(t0 + 20);
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 1,
            received: true,
            receivedAtMs: t0 + 10,
          }),
        ]),
      );
      (gcc as any).alr.startedMs = t0;
      setNow(t0 + 30);
      gcc.process(t0 + 30);
      expect((gcc as any).probe.periodicAlrProbing).toBe(true);
      expect((gcc as any).probe.alrStartMs).toBe(t0);

      // Act
      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));
      setNow(t0 + kAlrProbingIntervalMs);
      gcc.process(t0 + kAlrProbingIntervalMs);

      // Assert: estimated × alr_scale
      expect(probeCfgs.length).toBe(1);
      const estimated = (gcc as any).probe.estimatedBitrateBps;
      expect(probeCfgs[0]).toBe(estimated * kAlrProbeScale);
      expect(gcc.probeState).toBe("waiting_for_result");
    });

    test("high RTT 中は ALR periodic probe を出さない", () => {
      // Arrange
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      probe.abort(1_000);
      probe.enablePeriodicAlrProbing(true);
      probe.setAlrStartTime(0);
      probe.setEstimatedBitrate(200_000, 0, {
        cause: "rtt_based_back_off_high_rtt",
      });

      // Act
      const started = probe.process(kAlrProbingIntervalMs + 1);

      // Assert: pin InitiateProbing は high RTT で空
      expect(started).toEqual([]);
      expect(probe.probeState).toBe("complete");
    });

    test("network-state estimate が低く interval が有限なら periodic probe する", () => {
      // Arrange: pin TimeForNetworkStateProbe（interval 既定 +∞ なので明示設定）
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      probe.abort(1_000);
      probe.setEstimatedBitrate(200_000, 1_000, {
        cause: "delay_based_limited",
      });
      probe.setNetworkStateEstimate(800_000);
      probe.setNetworkStateProbeIntervalMs(1_000);

      // Act
      const started = probe.process(1_000 + 1_000);

      // Assert: estimated × alr_scale、NSE upper で cap
      expect(started.length).toBe(1);
      expect(started[0].targetBps).toBe(200_000 * kAlrProbeScale);
    });

    test("AlrDetector は低送信で ALR に入り高送信で抜ける", () => {
      // Arrange
      const alr = new AlrDetector();
      alr.setEstimatedBitrate(1_000_000);

      // Act: 小さなパケットを間隔を空けて送ると budget が溜まる
      alr.onBytesSent(100, 0);
      for (let i = 1; i <= 8; i++) {
        alr.onBytesSent(20, i * 200);
      }

      // Assert: ALR 開始
      expect(alr.inAlr).toBe(true);
      expect(alr.startMs).toBeGreaterThan(0);

      // Act: 推定の大半を一気に送ると ALR 終了
      alr.onBytesSent(80_000, 8 * 200 + 10);

      // Assert
      expect(alr.inAlr).toBe(false);
    });

    test("observation commit 後の late received は committed loss を訂正する", () => {
      // Arrange: 250ms 以上の send span で 1 パケット lost を commit
      const loss = new LossBasedBwe();
      loss.reset(300_000);
      loss.update(0.5, 300_000, 250_000, 2, 1, 0, 200, 300, 100, [
        { seq: 1, size: 100, received: false, sendMs: 0 },
        { seq: 2, size: 100, received: true, sendMs: 300 },
      ]);

      // Assert: 観測が commit され seq1 は lost
      expect(loss.observationCount).toBe(1);
      const obs = (loss as any).observations[0];
      expect(obs.numPackets).toBe(2);
      expect(obs.numLostPackets).toBe(1);
      expect(obs.lostSize).toBe(100);
      expect(obs.numReceivedPackets).toBe(1);
      const avgBefore = loss.averageLossRatio;
      expect(avgBefore).toBeCloseTo(0.5, 5);
      expect((loss as any).partial.seenPackets.size).toBe(0);

      // Act: commit 後に seq1 の late ACK
      loss.update(0, 300_000, 250_000, 1, 0, 0, 100, 0, 0, [
        { seq: 1, size: 100, received: true, sendMs: 0 },
      ]);

      // Assert: 過去 observation の loss が減り、新 partial には再計上しない
      expect(loss.observationCount).toBe(1);
      expect(obs.numLostPackets).toBe(0);
      expect(obs.lostSize).toBe(0);
      expect(obs.numReceivedPackets).toBe(2);
      expect(obs.numPackets).toBe(2);
      expect(loss.averageLossRatio).toBe(0);
      expect(loss.averageLossRatio).toBeLessThan(avgBefore);
      expect((loss as any).partial.numPackets).toBe(0);
      expect((loss as any).partial.seenPackets.has(1)).toBe(false);
    });

    test("late TWCC correction は loss partial を二重計上しない", () => {
      // Arrange
      const loss = new LossBasedBwe();
      loss.reset(300_000);
      const packetsLost = [
        {
          seq: 10,
          size: 100,
          received: false,
          sendMs: 1000,
        },
      ];
      // Act 1: not-received
      loss.update(1, 300_000, 0, 1, 1, 1000, 100, 1000, 100, packetsLost);
      const partial1 = (loss as any).partial;
      expect(partial1.numPackets).toBe(1);
      expect(partial1.size).toBe(100);
      expect(partial1.lostPackets.has(10)).toBe(true);

      // Act 2: same seq received (late correction)
      loss.update(0, 300_000, 100_000, 1, 0, 1000, 100, 1000, 0, [
        { seq: 10, size: 100, received: true, sendMs: 1000 },
      ]);
      const partial2 = (loss as any).partial;
      // Assert: still one packet / 100 bytes; loss cleared
      expect(partial2.numPackets).toBe(1);
      expect(partial2.size).toBe(100);
      expect(partial2.lostPackets.has(10)).toBe(false);
    });

    test("commit 後の late TWCC は GCC 経路でも committed loss を訂正する", () => {
      // Arrange: 300ms 超の送信 + 1 パケット not-received で observation を commit
      const t0 = 80_000;
      const { gcc, setNow } = createClockGcc(300_000, t0);
      for (let i = 0; i < 8; i++) {
        gcc.rtpPacketSent(sent(i + 1, 200, t0 + i * 50));
      }
      setNow(t0 + 420);
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 8 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: i !== 2,
              receivedAtMs: i === 2 ? 0 : t0 + 30 + i * 50,
            });
          }),
        ),
      );
      const loss = (gcc as any).lossBwe as LossBasedBwe;
      expect(loss.observationCount).toBeGreaterThanOrEqual(1);
      const obs = (loss as any).observations[0];
      expect(obs.numLostPackets).toBe(1);
      expect(obs.lostSize).toBe(200);
      const avgBefore = loss.averageLossRatio;
      expect(avgBefore).toBeGreaterThan(0);

      // Act: commit 済み seq=3 の late received
      setNow(t0 + 500);
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 3,
            received: true,
            receivedAtMs: t0 + 480,
          }),
        ]),
      );

      // Assert: committed observation の loss が訂正され、二重計上しない
      expect(obs.numLostPackets).toBe(0);
      expect(obs.lostSize).toBe(0);
      expect(loss.averageLossRatio).toBeLessThan(avgBefore);
      expect((loss as any).partial.seenPackets.has(3)).toBe(false);
    });

    test("not-received は永久 finalize せず後続 received を受理する", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(300_000);
      const t0 = 50_000;
      for (let i = 0; i < 5; i++) {
        gcc.rtpPacketSent(sent(100 + i, 500, t0 + i * 20));
      }

      // Act: 最初の feedback で 102 を not-received
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 100,
            received: true,
            receivedAtMs: t0 + 30,
          }),
          new PacketResult({
            sequenceNumber: 101,
            received: true,
            receivedAtMs: t0 + 50,
          }),
          new PacketResult({
            sequenceNumber: 102,
            received: false,
            receivedAtMs: 0,
          }),
          new PacketResult({
            sequenceNumber: 103,
            received: true,
            receivedAtMs: t0 + 90,
          }),
          new PacketResult({
            sequenceNumber: 104,
            received: true,
            receivedAtMs: t0 + 110,
          }),
        ]),
      );
      const afterLoss = gcc.availableBitrate;

      // Act: 後続 feedback で 102 が到着
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 102,
            received: true,
            receivedAtMs: t0 + 200,
          }),
        ]),
      );

      // Assert: 2 回目が無視されず（matched>0 で）推定が維持/更新される
      // afterLoss が 0 なら hasValidSample 済みでない異常
      expect(afterLoss).toBeGreaterThan(0);
      expect(gcc.availableBitrate).toBeGreaterThan(0);
    });

    test("重複した not-received は損失を二重計上せず、後続 received で訂正する", () => {
      // Arrange: 1 パケットを送信し、まだ確定していない soft loss を作る
      const gcc = new GccBandwidthEstimator(300_000);
      const t0 = 60_000;
      gcc.rtpPacketSent(sent(10, 500, t0));
      const loss = (gcc as any).lossBwe as LossBasedBwe;

      // Act: 最初の not-received を損失観測として登録する
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 10,
            received: false,
          }),
        ]),
      );
      const afterFirstLoss = (loss as any).partial;

      // Assert: soft loss は partial observation に 1 回だけ入る
      expect(afterFirstLoss.numPackets).toBe(1);
      expect(afterFirstLoss.lostPackets.has(10)).toBe(true);

      // Act: overlapping feedback の同じ not-received は再度処理しない
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 10,
            received: false,
          }),
        ]),
      );
      const afterDuplicateLoss = (loss as any).partial;

      // Assert: 重複 feedback で packet/loss 数が増えない
      expect(afterDuplicateLoss.numPackets).toBe(1);
      expect(afterDuplicateLoss.lostPackets.size).toBe(1);

      // Act: 遅れて届いた received を訂正として処理する
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 10,
            received: true,
            receivedAtMs: t0 + 10,
          }),
        ]),
      );

      // Assert: packet は二重計上されず、soft loss だけが解除される
      const afterCorrection = (loss as any).partial;
      expect(afterCorrection.numPackets).toBe(1);
      expect(afterCorrection.lostPackets.has(10)).toBe(false);
    });

    test("InterArrivalDelta は group の latest send time 同士の差分を使う", () => {
      // Arrange
      const ia = new InterArrivalDelta(5);
      // Group1: send 0,2,4 → latest 4
      // Group2: send 10,12 → latest 12  (gap > 5ms from first of group1)
      // send delta should be 12-4=8 when group3 starts, or when comparing
      const out: number[] = [];
      for (const [s, r] of [
        [0, 100],
        [2, 102],
        [4, 104],
        [10, 120],
        [12, 122],
        [20, 140],
      ] as const) {
        const d = ia.computeDeltas(s, r, 100);
        if (d) out.push(d.sendDeltaMs);
      }
      // Assert: first closed pair uses latest sends (not firstSend 10-0=10)
      // group1 latest=4, group2 latest=12 → delta 8
      expect(out.length).toBeGreaterThanOrEqual(1);
      expect(out[0]).toBe(8);
    });

    test("InterArrivalDelta は reordered で current send を巻き戻さない", () => {
      // Arrange
      const ia = new InterArrivalDelta(5);
      ia.computeDeltas(100, 200, 100);
      ia.computeDeltas(102, 202, 100);
      // Act: reordered older packet within same group window
      ia.computeDeltas(101, 203, 100);
      // Next packet forces new group; send of group1 should still be max(102,101)=102
      const d = ia.computeDeltas(110, 220, 100);
      // Assert: no delta yet (no prev), but internal max send held — next close:
      const d2 = ia.computeDeltas(120, 240, 100);
      // When third group starts, delta = group2.latest - group1.latest
      // group1: 100..102 (max 102), group2: 110 (max 110) → 8
      expect(d).toBeUndefined();
      expect(d2?.sendDeltaMs).toBe(8);
    });

    test("probe 適用は AIMD/LossBased の full reset ではなく setEstimate を使う", () => {
      // Arrange: RTT・観測履歴を持たせた後に probe を適用
      const gcc = new GccBandwidthEstimator(300_000);
      gcc.shouldTagProbePacket();
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probe.lastProbeEndMs = 0;
      (gcc as any).hasValidSample = true;
      (gcc as any).probingConfigured = true;
      (gcc as any).delayBasedBps = 400_000;
      (gcc as any).lossBasedBps = 400_000;
      (gcc as any)._availableBitrate = 400_000;

      // AIMD に RTT と decrease 履歴を刻む（pin SetEstimate は RTT を消さない）
      const aimd = (gcc as any).aimd as AimdRateControl;
      aimd.reset(400_000);
      aimd.setRtt(180);
      aimd.update("overuse", 400_000, 1_000);
      expect(aimd.rtt).toBe(180);
      expect(aimd.targetBitrateBps).toBeLessThan(400_000);

      // LossBased に observation を積む
      const loss = (gcc as any).lossBwe as LossBasedBwe;
      loss.reset(400_000);
      for (let i = 0; i < 5; i++) {
        loss.update(
          0.02,
          400_000,
          380_000,
          20,
          0,
          i * 300,
          20_000,
          i * 300 + 250,
          0,
        );
      }
      const obsBefore = loss.observationCount;
      expect(obsBefore).toBeGreaterThanOrEqual(1);

      // acked ~ 500kbps 相当 + rising probe
      const t0 = 50_000;
      (gcc as any).ackedBitrate.incomingPacketFeedbackVector(
        Array.from({ length: 12 }, (_, i) => ({
          receiveTimeMs: t0 + i * 10,
          sendTimeMs: t0 + i * 10,
          sizeBytes: 625, // 625B/10ms = 500kbps
        })),
      );
      (gcc as any).probe.pendingEstimateBps = 700_000;

      gcc.rtpPacketSent(sent(1, 500, t0 + 200, { isProbation: false }));

      // Act: matched TWCC で probe 適用
      gcc.receiveTWCC(
        makeTwccFeedback([
          new PacketResult({
            sequenceNumber: 1,
            received: true,
            receivedAtMs: t0 + 205,
          }),
        ]),
      );

      // Assert: estimate は上がるが RTT / observation 履歴は保持
      // （receiveTWCC の loss.update で observation が 1 増えるのは正常。
      //  full reset なら 0 に戻る）
      expect(gcc.availableBitrate).toBeGreaterThan(400_000);
      expect(aimd.rtt).toBe(180);
      // RTT preserved across SetEstimate (not full reset)
      expect(loss.observationCount).toBeGreaterThanOrEqual(obsBefore);
      expect(loss.observationCount).toBeGreaterThan(0);
      // full reset なら inherentLoss も初期値に戻る — 戻っていないこと
      expect(loss.inherentLossEstimate).not.toBe(0.01);
    });

    test("AcknowledgedBitrateEstimator は required_packets 未満で 0、以後は gap 耐性あり", () => {
      // Arrange
      const est = new AcknowledgedBitrateEstimator();
      const size = 1000;
      // Act: 9 packets → not ready
      est.incomingPacketFeedbackVector(
        Array.from({ length: 9 }, (_, i) => ({
          receiveTimeMs: 1000 + i * 20,
          sendTimeMs: 1000 + i * 20,
          sizeBytes: size,
        })),
      );
      // Assert
      expect(est.bitrate()).toBe(0);

      // Act: 10 個目で ready
      est.incomingPacketFeedbackVector([
        {
          receiveTimeMs: 1000 + 9 * 20,
          sendTimeMs: 1000 + 9 * 20,
          sizeBytes: size,
        },
      ]);
      const base = est.bitrate();
      // Assert: ~400 kbps (1000B / 20ms)
      expect(base).toBeGreaterThan(200_000);
      expect(base).toBeLessThan(600_000);

      // Act: 大きな receive gap があっても largest-gap 置換で極端に落ちない
      est.incomingPacketFeedbackVector([
        {
          receiveTimeMs: 1000 + 9 * 20 + 400,
          sendTimeMs: 1000 + 10 * 20,
          sizeBytes: size,
        },
      ]);
      const withSpike = est.bitrate();
      // Assert: spike で 0 にならず、ベースの半分以上を維持
      expect(withSpike).toBeGreaterThan(base * 0.4);
    });

    test("delay/acked 経路は receive-time 順で処理する（seq 逆順 feedback）", () => {
      // Arrange: transport-seq 昇順だが recv 時刻は逆順
      const gcc = new GccBandwidthEstimator(300_000);
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probingConfigured = true;
      const t0 = 10_000;
      const n = 20;
      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(sent(i + 1, 600, t0 + i * 10));
      }
      // recv 時刻を seq 逆順に（後ろの seq ほど早く届いた）
      const results = Array.from({ length: n }, (_, i) => {
        const seq = i + 1;
        return new PacketResult({
          sequenceNumber: seq,
          received: true,
          // seq 1 → late, seq n → early
          receivedAtMs: t0 + (n - i) * 10,
        });
      });

      // Act
      gcc.receiveTWCC(makeTwccFeedback(results));

      // Assert: reverse-recv でも acked ready + estimate > 0（窓リセットで 0 にならない）
      expect((gcc as any).ackedBitrate.bitrate()).toBeGreaterThan(0);
      expect(gcc.availableBitrate).toBeGreaterThan(0);
    });

    test("receiveTWCC は ProbeController::Process を呼ばない（合成 t0 でも pacing 継続）", () => {
      // Arrange: pin OnTransportPacketsFeedback に Process は無い。
      // 旧実装は milliTime() で process するため小さな t0 だと 5s pacing timeout が即発火した。
      const { gcc, setNow } = createClockGcc(100_000, 1_000);
      gcc.rtpPacketSent(sent(1, 300, 1_000, { isProbation: true }));
      gcc.rtpPacketSent(sent(2, 300, 1_001, { isProbation: true }));
      expect(gcc.shouldTagProbePacket()).toBe(true);
      expect(gcc.suggestedProbeBitrateBps).toBe(300_000);

      const processSpy = vi.spyOn((gcc as any).probe, "process");
      setNow(1_050);
      for (let i = 10; i <= 16; i++) {
        gcc.rtpPacketSent(sent(i, 400, 1_000 + i));
      }

      // Act: 全ロス TWCC（delay 空）でも Process しない
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 7 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: 10 + i,
              received: false,
              receivedAtMs: 0,
            });
          }),
        ),
      );

      // Assert
      expect(processSpy).not.toHaveBeenCalled();
      expect(gcc.shouldTagProbePacket()).toBe(true);
      expect(gcc.suggestedProbeBitrateBps).toBe(300_000);
      processSpy.mockRestore();
    });

    test("all-lost TWCC は AIMD を進めず delay target を上げない", () => {
      // Arrange: pin DelayBasedBwe は SortedByReceiveTime 空なら Result()
      const { gcc, setNow } = createClockGcc(300_000, 20_000);
      (gcc as any).probe.abort(20_000);
      (gcc as any).probe.state = "complete";
      (gcc as any).probingConfigured = true;
      const t0 = 20_000;
      for (let i = 1; i <= 12; i++) {
        gcc.rtpPacketSent(sent(i, 500, t0 + i * 10));
      }
      setNow(t0 + 200);
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 12 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: t0 + 30 + i * 10,
            });
          }),
        ),
      );
      const delayBefore = (gcc as any).delayBasedBps as number;
      const aimdSpy = vi.spyOn((gcc as any).aimd, "update");

      // Act: 未知でない全ロス（timing なし）
      for (let i = 20; i <= 31; i++) {
        gcc.rtpPacketSent(sent(i, 500, t0 + 400 + (i - 20) * 10));
      }
      setNow(t0 + 600);
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 12 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: 20 + i,
              received: false,
              receivedAtMs: 0,
            });
          }),
        ),
      );

      // Assert: AIMD Update は走らず delay 推定は据え置き
      expect(aimdSpy).not.toHaveBeenCalled();
      expect((gcc as any).delayBasedBps).toBe(delayBefore);
      aimdSpy.mockRestore();
    });

    test("ProcessInterval は最初の RTP 無しでも initial probe を開始する", () => {
      // Arrange: pin 初回 OnProcessInterval の ResetConstraints → SetBitrates
      const { gcc, setNow } = createClockGcc(100_000, 5_000);
      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));
      expect(gcc.probeState).toBe("init");

      // Act
      setNow(5_025);
      gcc.process(5_025);

      // Assert: 3x が activate（6x は queue）
      expect(probeCfgs).toEqual([300_000]);
      expect(gcc.probeState).toBe("waiting_for_result");
      expect(gcc.shouldTagProbePacket()).toBe(true);
    });

    test("SetEstimatedBitrate further は high RTT cause では空（InitiateProbing）", () => {
      // Arrange: pin InitiateProbing は kRttBasedBackOffHighRtt で return {}
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      expect(probe.probeState).toBe("waiting_for_result");
      (probe as any).minBitrateToProbeFurther = 50_000;

      // Act: further 条件は満たすが cause が forbid
      const further = probe.setEstimatedBitrate(200_000, 10, {
        cause: "rtt_based_back_off_high_rtt",
      });

      // Assert
      expect(further).toEqual([]);
      expect(probe.queuedClusterCount).toBe(1);
    });

    test("ProbeController Process は initiation から 1s 超で session complete（境界）", () => {
      // Arrange: pin Process は at_time - time_last_probing_initiated_ > 1s
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      probe.onProbePacketSent(200, 0, 1);
      expect(probe.probeState).toBe("waiting_for_result");
      const timeoutMs = 1_000;

      // Act / Assert: timeout - 1 と timeout では waiting のまま
      expect(probe.process(timeoutMs - 1)).toEqual([]);
      expect(probe.probeState).toBe("waiting_for_result");
      expect(probe.process(timeoutMs)).toEqual([]);
      expect(probe.probeState).toBe("waiting_for_result");

      // Act: timeout + 1 で complete。pacing は BitrateProber として残る
      expect(probe.process(timeoutMs + 1)).toEqual([]);
      expect(probe.probeState).toBe("complete");
      expect(probe.furtherProbeThresholdBps).toBe(Number.POSITIVE_INFINITY);
      expect(probe.shouldTagProbePacket()).toBe(true);
      expect(probe.setEstimatedBitrate(500_000, timeoutMs + 2)).toEqual([]);
    });

    test("InterArrivalDelta は arrival−system offset >= 3000ms で reset する", () => {
      // Arrange: pin ComputeDeltas の arrival_delta - system_delta >= 3000
      const ia = new InterArrivalDelta(5);
      ia.computeDeltas(0, 100, 100, 1_000);
      ia.computeDeltas(4, 110, 100, 1_000);
      // 2nd group（この時点では prev が無く delta なし）
      ia.computeDeltas(10, 3_120, 100, 1_010);
      // Act: 3rd group 開始で g2 vs g1 を比較
      // recvDelta=3120-110=3010, systemDelta=10 → offset 3000
      const d = ia.computeDeltas(20, 3_140, 100, 1_020);

      // Assert: 境界ちょうどで reset、delta なし
      expect(d).toBeUndefined();
      expect(ia.computeDeltas(30, 3_160, 100, 1_030)).toBeUndefined();
    });

    test("InterArrivalDelta は offset 境界 2999 では reset しない", () => {
      // Arrange
      const ia = new InterArrivalDelta(5);
      ia.computeDeltas(0, 100, 100, 1_000);
      ia.computeDeltas(4, 110, 100, 1_000);
      ia.computeDeltas(10, 3_119, 100, 1_010);
      // Act: recvDelta=3119-110=3009, systemDelta=10 → offset 2999
      const d = ia.computeDeltas(20, 3_130, 100, 1_020);

      // Assert: reset せず group close の delta が出る
      expect(d).toBeDefined();
      expect(d!.sendDeltaMs).toBe(6);
    });

    test("complete 後に max が上がると new max で単発 probe する", () => {
      // Arrange: pin SetBitrates kProbingComplete —
      // old_max < new_max && estimated < new_max → InitiateProbing({max}, false)
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1_000_000, 0);
      probe.abort(1_000);
      expect(probe.probeState).toBe("complete");
      probe.setEstimatedBitrate(400_000, 6_000, {
        cause: "delay_based_limited",
      });

      // Act: max 1M → 2M
      const started = probe.setBitrates(10_000, 100_000, 2_000_000, 6_000);

      // Assert: start>0 で estimated は start に上書きされ、target=new max
      expect(started.length).toBe(1);
      expect(started[0].targetBps).toBe(2_000_000);
      expect(probe.furtherProbeThresholdBps).toBe(Number.POSITIVE_INFINITY);
      expect(probe.currentProbeTargetBps).toBe(2_000_000);
    });

    test("complete 後の max 据え置き / 低下 / 境界では probe しない", () => {
      // Arrange
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1_000_000, 0);
      probe.abort(1_000);
      probe.setEstimatedBitrate(400_000, 6_000, {
        cause: "delay_based_limited",
      });

      // Act / Assert: 同じ max（old < new ではない）
      expect(probe.setBitrates(10_000, 100_000, 1_000_000, 6_000)).toEqual([]);
      // Act / Assert: より低い max
      expect(probe.setBitrates(10_000, 100_000, 500_000, 6_100)).toEqual([]);
      // Act / Assert: max+1 なら開始
      const up = probe.setBitrates(10_000, 100_000, 1_000_001, 6_200);
      expect(up.length).toBe(1);
      expect(up[0].targetBps).toBe(1_000_001);
    });

    test("reset は periodic ALR と ALR start を残し drop-probe cooldown を now にする", () => {
      // Arrange: pin Reset は enable_periodic_alr_probing_ / alr_start_time_
      // を残し、last_bwe_drop_probing_time_ = at_time
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1e9, 0);
      probe.enablePeriodicAlrProbing(true);
      probe.setAlrStartTime(2_000);
      probe.abort(3_000);
      probe.setEstimatedBitrate(800_000, 8_000);
      probe.setEstimatedBitrate(200_000, 8_100, {
        cause: "delay_based_limited",
      });

      // Act
      const resetAt = 9_000;
      probe.reset(resetAt);

      // Assert: 設定保持
      expect(probe.probeState).toBe("init");
      expect((probe as any).periodicAlrProbing).toBe(true);
      expect((probe as any).alrStartMs).toBe(2_000);
      expect((probe as any).alrEndMs).toBeUndefined();
      expect((probe as any).lastBweDropProbingMs).toBe(resetAt);
      expect((probe as any).timeOfLastLargeDropMs).toBe(resetAt);
      expect(probe.furtherProbeThresholdBps).toBe(Number.POSITIVE_INFINITY);

      // Act: reset 直後の RequestProbe は 5s cooldown
      probe.setBitrates(10_000, 100_000, 1e9, resetAt);
      probe.abort(resetAt + 1);
      probe.setEstimatedBitrate(800_000, resetAt + 2);
      probe.setEstimatedBitrate(200_000, resetAt + 3, {
        cause: "delay_based_limited",
      });
      expect(probe.requestProbe(200_000, resetAt + 100)).toEqual([]);

      // Act / Assert: pin time_since_probe > 5s（timeout-1 / timeout は拒否）
      expect(probe.requestProbe(200_000, resetAt + 4_999)).toEqual([]);
      expect(probe.requestProbe(200_000, resetAt + 5_000)).toEqual([]);
      expect(probe.requestProbe(200_000, resetAt + 5_001).length).toBe(1);
    });

    test("GccBandwidthEstimator.setBitrates は complete 後の max 上昇で probe する", () => {
      // Arrange: public production path。初期 max 1Mbps で session を閉じる
      const { gcc, setNow } = createClockGcc(100_000, 20_000);
      gcc.setBitrates(10_000, 100_000, 1_000_000);
      (gcc as any).probe.abort(20_000);
      expect(gcc.probeState).toBe("complete");
      const probeCfgs: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => probeCfgs.push(c.targetBps));

      // Act: max 1M → 2M
      setNow(26_000);
      gcc.setBitrates(10_000, 100_000, 2_000_000);

      // Assert
      expect(probeCfgs).toEqual([2_000_000]);
      expect(gcc.shouldTagProbePacket()).toBe(true);
      expect(gcc.suggestedProbeBitrateBps).toBe(2_000_000);
    });

    test("未設定 max では delay>5Mbps を process が 5Mbps に落とさない", () => {
      // Arrange: pin 未設定 target max = 1 Gbps。probe 既定 5Mbps と混ぜない
      const { gcc, setNow } = createClockGcc(300_000, 40_000);
      (gcc as any).probe.abort(40_000);
      (gcc as any).probingConfigured = true;
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 8_000_000;
      (gcc as any).delayBasedLimitBps = 8_000_000;
      (gcc as any).lossBasedBps = 8_000_000;
      (gcc as any).currentTargetBps = 8_000_000;
      (gcc as any)._availableBitrate = 8_000_000;

      // Act: ProcessInterval が delay 上限を適用する
      setNow(40_050);
      gcc.process(40_050);

      // Assert: 8Mbps のまま（5Mbps probe cap を target に使わない）
      expect(gcc.availableBitrate).toBe(8_000_000);
    });

    test("全ロス TWCC だけでは start bitrate を delay cap にしない", () => {
      // Arrange: pin delay_based_limit_ は +∞ のまま（result.updated なし）
      const start = 300_000;
      const { gcc, setNow } = createClockGcc(start, 60_000);
      (gcc as any).probe.abort(60_000);
      (gcc as any).probingConfigured = true;
      for (let i = 1; i <= 8; i++) {
        gcc.rtpPacketSent(sent(i, 500, 60_000 + i * 10));
      }
      setNow(60_200);
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 8 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: false,
            });
          }),
        ),
      );
      expect((gcc as any).delayBasedLimitBps).toBe(Number.POSITIVE_INFINITY);

      // Act: 損失側が 8Mbps を返したあとの ProcessInterval
      (gcc as any).lossBasedBps = 8_000_000;
      (gcc as any).currentTargetBps = 8_000_000;
      (gcc as any)._availableBitrate = 8_000_000;
      setNow(60_250);
      gcc.process(60_250);

      // Assert: start 300kbps で clamp されない
      expect(gcc.availableBitrate).toBe(8_000_000);
    });

    test("setBitrates(start>0) は delay cap を外して新しい start を採用する", () => {
      // Arrange: pin SetSendBitrate は delay_based_limit_ = +∞
      const { gcc } = createClockGcc(300_000, 70_000);
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 200_000;
      (gcc as any).delayBasedLimitBps = 200_000;
      (gcc as any).lossBasedBps = 200_000;
      (gcc as any).currentTargetBps = 200_000;
      (gcc as any)._availableBitrate = 200_000;

      // Act: start=1Mbps を伴う constraint 更新
      gcc.setBitrates(10_000, 1_000_000, 2_000_000);

      // Assert: 古い delay 200kbps に張り付かない
      expect((gcc as any).delayBasedLimitBps).toBe(Number.POSITIVE_INFINITY);
      expect(gcc.availableBitrate).toBe(1_000_000);

      // Act: 全ロス TWCC は pin 同様 +∞ を LossBased に渡す（古い delay cap を消す）
      for (let i = 1; i <= 4; i++) {
        gcc.rtpPacketSent(sent(i, 500, 70_000 + i * 10));
      }
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 4 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: false,
            });
          }),
        ),
      );

      // Assert: LossBased の delay 入力もクリアされる
      expect((gcc as any).lossBwe.delayBasedBps).toBe(0);
    });

    test("setBitrates(start=0) は current target を上書きしない", () => {
      // Arrange: pin SetBitrates は start=0 なら SetSendBitrate しない
      const { gcc } = createClockGcc(300_000, 80_000);
      (gcc as any).hasValidSample = true;
      (gcc as any).delayBasedBps = 400_000;
      (gcc as any).delayBasedLimitBps = 400_000;
      (gcc as any).lossBasedBps = 400_000;
      (gcc as any).currentTargetBps = 400_000;
      (gcc as any)._availableBitrate = 400_000;
      (gcc as any).startBitrateBps = 300_000;

      // Act: max だけ更新
      gcc.setBitrates(10_000, 0, 2_000_000);

      // Assert: start/current は据え置き、max は効く
      expect((gcc as any).startBitrateBps).toBe(300_000);
      expect(gcc.availableBitrate).toBe(400_000);
      (gcc as any).currentTargetBps = 3_000_000;
      (gcc as any).delayBasedLimitBps = Number.POSITIVE_INFINITY;
      (gcc as any).lossBasedBps = 3_000_000;
      gcc.process(80_025);
      expect(gcc.availableBitrate).toBeLessThanOrEqual(2_000_000);
    });

    test("setBitrates(max=1M) 後の TWCC は delay/loss=3M を即 1M に clamp する", () => {
      // Arrange: pin ResetConstraints の app max は UpdateTargetBitrate 上限
      const { gcc, setNow } = createClockGcc(300_000, 50_000);
      gcc.setBitrates(10_000, 300_000, 1_000_000);
      (gcc as any).probe.abort(50_000);
      (gcc as any).probingConfigured = true;
      (gcc as any).lossBwe.update = () => {
        (gcc as any).lossBwe.state = "delay_based";
        return 3_000_000;
      };
      (gcc as any).aimd.update = () => 3_000_000;
      Object.defineProperty((gcc as any).trendline, "state", {
        get: () => "normal",
        configurable: true,
      });
      for (let i = 1; i <= 8; i++) {
        gcc.rtpPacketSent(sent(i, 500, 50_000 + i * 10));
      }

      // Act
      setNow(50_200);
      gcc.receiveTWCC(
        makeTwccFeedback(
          Array.from({ length: 8 }, (_, i) => {
            return new PacketResult({
              sequenceNumber: i + 1,
              received: true,
              receivedAtMs: 50_040 + i * 10,
            });
          }),
        ),
      );

      // Assert: TWCC 直後に app max で clamp（次の process を待たない）
      expect(gcc.availableBitrate).toBeLessThanOrEqual(1_000_000);
      expect(gcc.availableBitrate).toBeGreaterThan(0);
    });

    test("complete 後の max 上昇 probe の直後にさらに max を上げると 2 本目が始まる", () => {
      // Arrange: pin probe_further=false → complete のままなので次の SetBitrates が再び発火
      const probe = new ProbeController();
      probe.setBitrates(10_000, 100_000, 1_000_000, 0);
      probe.abort(1_000);
      probe.setEstimatedBitrate(200_000, 6_000, {
        cause: "delay_based_limited",
      });
      const first = probe.setBitrates(10_000, 0, 2_000_000, 6_000);
      expect(first.length).toBe(1);
      expect(first[0].targetBps).toBe(2_000_000);
      expect(probe.probeState).toBe("complete");
      expect(probe.shouldTagProbePacket()).toBe(true);

      // Act: start=0 は estimated を上書きしない。max 2M→3M は FIFO に積む
      probe.setBitrates(10_000, 0, 3_000_000, 6_100);
      expect(probe.probeState).toBe("complete");
      expect(probe.queuedClusterCount).toBe(1);

      // Act: 先頭 2M を send-fill すると 3M が pacing になる
      for (let i = 0; i < 5; i++) {
        probe.onProbePacketSent(2_000, 6_200 + i, i + 1);
      }

      // Assert
      expect(probe.currentProbeTargetBps).toBe(3_000_000);
      expect(probe.shouldTagProbePacket()).toBe(true);
    });

    test("group 単位の負の arrival delta では prev/current を進めない", () => {
      // Arrange: pin complete_time は group 内 last arrival（max ではない）
      const ia = new InterArrivalDelta(5);
      ia.computeDeltas(0, 200, 100);
      ia.computeDeltas(4, 210, 100);
      ia.computeDeltas(10, 220, 100);
      // 同じ g2 の後着 packet が complete_time を 100 に戻す
      ia.computeDeltas(12, 100, 100);

      // Act: g2 vs g1 の recvDelta=100-210<0。packet 破棄、group は進まない
      expect(ia.computeDeltas(20, 240, 100)).toBeUndefined();
      // g2 を正しい complete に戻してから次 group を閉じる
      ia.computeDeltas(13, 230, 100);
      const d = ia.computeDeltas(20, 250, 100);

      // Assert: 進めていたら send 13 は firstSend=20 より古く無視され delta が出ない
      expect(d?.sendDeltaMs).toBe(9);
    });

    test("setBitrates は start<min を min へ正規化する（境界）", () => {
      // Arrange: pin ClampConstraints — start < min_data_rate_ なら start = min
      const min = 200_000;
      const { gcc } = createClockGcc(300_000, 90_000);
      (gcc as any).hasValidSample = true;
      (gcc as any)._availableBitrate = 300_000;

      // Act: start = min-1
      gcc.setBitrates(min, min - 1, 2_000_000);

      // Assert: start / target / probe 初期倍率がすべて min 基準
      expect((gcc as any).startBitrateBps).toBe(min);
      expect((gcc as any).minConfiguredBps).toBe(min);
      expect(gcc.availableBitrate).toBe(min);
      expect(gcc.suggestedProbeBitrateBps).toBe(min * 3);

      // Act: ちょうど min と min+1 はそのまま
      gcc.setBitrates(min, min, 2_000_000);
      expect((gcc as any).startBitrateBps).toBe(min);
      gcc.setBitrates(min, min + 1, 2_000_000);
      expect((gcc as any).startBitrateBps).toBe(min + 1);
    });

    test("setBitrates は min>max のとき max を min へ上げる（境界）", () => {
      // Arrange: pin ClampConstraints — max_data_rate_ < min なら max = min
      const { gcc } = createClockGcc(300_000, 91_000);
      (gcc as any).hasValidSample = true;
      (gcc as any)._availableBitrate = 300_000;
      const min = 1_000_000;

      // Act: max = min-1
      gcc.setBitrates(min, 300_000, min - 1);

      // Assert: max も start も min。probe / target clamp が同じ上限
      expect((gcc as any).minConfiguredBps).toBe(min);
      expect((gcc as any).appMaxBps).toBe(min);
      expect((gcc as any).startBitrateBps).toBe(min);
      expect(gcc.availableBitrate).toBe(min);
      expect(gcc.suggestedProbeBitrateBps).toBe(min);

      // Act: max === min はそのまま（上げない）
      gcc.setBitrates(min, 0, min);
      expect((gcc as any).appMaxBps).toBe(min);
      expect((gcc as any).startBitrateBps).toBe(min);

      // Act: max = min+1 は保持
      gcc.setBitrates(min, 0, min + 1);
      expect((gcc as any).appMaxBps).toBe(min + 1);
    });

    test("RequestProbe の 5s 境界は pin の > / < に従う", () => {
      // Arrange
      const probe = new ProbeController();
      probe.setBitrates(10_000, 200_000, 1e9, 0);
      probe.abort(1_000);
      probe.setAlrStartTime(0);
      probe.setEstimatedBitrate(800_000, 1_000);
      probe.setEstimatedBitrate(200_000, 1_100, {
        cause: "delay_based_limited",
      });
      (probe as any).lastBweDropProbingMs = 10_000;
      // drop は 12s 時点なので probe 境界 15s でもまだ <5s
      (probe as any).timeOfLastLargeDropMs = 12_000;

      // Act / Assert: time_since_probe > 5s
      expect(probe.requestProbe(200_000, 14_999)).toEqual([]);
      expect(probe.requestProbe(200_000, 15_000)).toEqual([]);
      expect(probe.requestProbe(200_000, 15_001).length).toBe(1);

      // Act / Assert: time_since_drop < 5s（ちょうど 5s は拒否）
      (probe as any).state = "complete";
      (probe as any).queue = [];
      (probe as any).pacing = undefined;
      (probe as any).lastBweDropProbingMs = 0;
      (probe as any).timeOfLastLargeDropMs = 20_000;
      expect(probe.requestProbe(200_000, 25_000)).toEqual([]);
      (probe as any).timeOfLastLargeDropMs = 20_001;
      expect(probe.requestProbe(200_000, 25_000).length).toBe(1);
    });
  });
});

/** True if b is the next sequence after a (or later within half-range). */
function uint16Forward(a: number, b: number): boolean {
  const da = (b - a + 0x10000) & 0xffff;
  return da > 0 && da < 0x8000;
}
