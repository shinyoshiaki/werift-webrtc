import { describe, expect, test, vi } from "vitest";
import type { Config } from "../../../rtp/src/srtp/session";
import { SrtpSession } from "../../../rtp/src/srtp/srtp";
import {
  AimdRateControl,
  type BandwidthEstimator,
  GccBandwidthEstimator,
  InterArrivalDelta,
  LossBasedBwe,
  PacketResult,
  PacketStatus,
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
  TransportWideCC,
  TrendlineEstimator,
  appendRfc3550Padding,
  isProbePacingController,
  kBeta,
  kProbePaddingPacketBytes,
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
  const results = Array.from({ length: count }, (_, i) => {
    const sendMs = t0 + i * sendInterval;
    const lost = lossRatio > 0 && i / count < lossRatio;
    if (!lost) {
      recv += sendInterval + recvStretchPerStep;
    }
    return new PacketResult({
      sequenceNumber: seq0 + i,
      received: !lost,
      receivedAtMs: lost ? 0 : Math.max(recv, sendMs + 1),
    });
  });
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
      // Arrange: TWCC receivedAtMs は referenceTime 由来で壁時計と無関係
      const gcc = new GccBandwidthEstimator(300_000);
      const twccRecvBase = 50_000; // 壁時計とは無関係な小さなタイムライン
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
      // Arrange
      const gcc = new GccBandwidthEstimator(500_000);
      const t0 = Date.now() - 8_000;

      // Act: 無損失でベース
      feedDelayScenario(gcc, {
        seq0: 1,
        t0,
        count: 40,
        sendInterval: 15,
        recvStretchPerStep: 0,
        lossRatio: 0,
      });
      feedDelayScenario(gcc, {
        seq0: 50,
        t0: t0 + 1000,
        count: 40,
        sendInterval: 15,
        recvStretchPerStep: 0,
        lossRatio: 0,
      });
      const lowLoss = gcc.availableBitrate;
      expect(lowLoss).toBeGreaterThan(0);

      // Act: 40% loss
      feedDelayScenario(gcc, {
        seq0: 100,
        t0: t0 + 2000,
        count: 50,
        sendInterval: 15,
        recvStretchPerStep: 0,
        lossRatio: 0.4,
      });
      feedDelayScenario(gcc, {
        seq0: 160,
        t0: t0 + 3000,
        count: 50,
        sendInterval: 15,
        recvStretchPerStep: 0,
        lossRatio: 0.4,
      });
      const highLoss = gcc.availableBitrate;

      // Assert
      expect(highLoss).toBeLessThan(lowLoss);
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
        loss.update(
          0.5,
          180_000,
          120_000,
          40,
          20,
          first,
          12_000,
          last,
          6_000,
        );
      }

      // Assert: 損失観測が反映され推定が下がる
      expect(loss.averageLossRatio).toBeGreaterThan(0.2);
      expect(loss.observationCount).toBeGreaterThanOrEqual(8);
      expect(loss.targetBitrateBps).toBeLessThan(up);
      expect(loss.targetBitrateBps).toBeLessThanOrEqual(250_000);
    });

    test("LossBasedBwe は 250ms×3 観測まで推定を据え置く", () => {
      // Arrange
      const loss = new LossBasedBwe();
      loss.reset(400_000);

      // Act: send span が 250ms 未満なので commit されない
      loss.update(0.5, 400_000, 100_000, 20, 10, 1000, 10_000, 1100, 5_000);
      loss.update(0.5, 400_000, 100_000, 20, 10, 1100, 10_000, 1200, 5_000);
      // Assert: readiness 未満
      expect(loss.observationCount).toBe(0);
      expect(loss.targetBitrateBps).toBe(400_000);

      // Act: 300ms span を 3 回 → 3 observations
      for (let i = 0; i < 3; i++) {
        const first = 2000 + i * 300;
        loss.update(0.0, 400_000, 380_000, 30, 0, first, 15_000, first + 300, 0);
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
      // Arrange
      const start = 100_000;
      const gcc = new GccBandwidthEstimator(start);
      expect(gcc.shouldTagProbePacket()).toBe(true);
      const probeTarget = gcc.suggestedProbeBitrateBps;
      expect(probeTarget).toBeGreaterThanOrEqual(start * 2);

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

      // Assert: 推定がスタートより明確に上がる
      expect(gcc.availableBitrate).toBeGreaterThan(start);
      // 理論: 1400B / 2ms ≈ 5.6 Mbps オーダー（clamp あり）
      expect(gcc.availableBitrate).toBeGreaterThan(200_000);
    });

    test("probe 成功後に further probe または complete へ遷移する", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      gcc.shouldTagProbePacket();
      const clusters: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => clusters.push(c.targetBps));

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

      // Act: 初回 cluster 完了（setBitrates は 3x と 6x をキュー）
      runProbe(1, 9_000, 15);
      const afterFirst = gcc.availableBitrate;
      expect(afterFirst).toBeGreaterThan(100_000);

      // 2nd exponential cluster が残っていれば waiting、完了なら complete
      // 続けて 2nd を消化
      if (
        gcc.probeState === "waiting_for_result" ||
        gcc.shouldTagProbePacket()
      ) {
        runProbe(100, 9_500, 15);
      }
      const afterSecond = gcc.availableBitrate;

      // Assert: multi-active 3x/6x 完了後も推定はスタートを上回り、state が進行している
      // （2nd batch で delay/AIMD が動いても probe 成果が完全に消えない）
      expect(afterFirst).toBeGreaterThan(100_000);
      expect(afterSecond).toBeGreaterThan(100_000);
      expect(["complete", "waiting_for_result"]).toContain(gcc.probeState);
      // 少なくとも 1 つ以上の probe cluster が発行されている
      expect(clusters.length).toBeGreaterThanOrEqual(1);
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
    test("overuse で beta 倍", () => {
      const aimd = new AimdRateControl();
      aimd.reset(500_000);
      expect(aimd.update("overuse", 500_000, 1000)).toBe(
        Math.round(500_000 * kBeta),
      );
    });
  });

  describe("wrap-around", () => {
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
  });

  describe("Blocker regressions", () => {
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

    test("initial probe は 3x と 6x を同時に active にする（libwebrtc InitiateProbing）", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const started: number[] = [];
      gcc.onProbeClusterConfig.subscribe((c) => started.push(c.targetBps));

      // Act: 最初の送信で ensureProbing
      gcc.rtpPacketSent(sent(1, 200, Date.now()));

      // Assert: 3x と 6x の両方を started として通知、pacing は max=6x
      expect(started.length).toBe(2);
      expect(started).toContain(100_000 * 3);
      expect(started).toContain(100_000 * 6);
      expect(gcc.suggestedProbeBitrateBps).toBe(100_000 * 6);
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
      const wire = new RtcpTransportLayerFeedback({ feedback: twcc }).serialize();
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
        new PacketResult({ sequenceNumber: 0, received: true, receivedAtMs: 3 }),
        new PacketResult({ sequenceNumber: 1, received: true, receivedAtMs: 4 }),
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
      expect(sorted.map((r) => r.sequenceNumber)).toEqual([
        65534, 65535, 0, 1,
      ]);
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
  });
});

/** True if b is the next sequence after a (or later within half-range). */
function uint16Forward(a: number, b: number): boolean {
  const da = (b - a + 0x10000) & 0xffff;
  return da > 0 && da < 0x8000;
}
