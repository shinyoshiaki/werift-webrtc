import { describe, expect, test, vi } from "vitest";
import {
  AimdRateControl,
  GccBandwidthEstimator,
  LossBasedBwe,
  PacketResult,
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
  type ProbePacingController,
  type SentInfo,
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
    const size =
      payload.length + (header.padding ? header.paddingSize : 0) + 12;
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

    test("LossBasedBwe 観測窓で平均 loss が反映される", () => {
      const loss = new LossBasedBwe();
      loss.reset(500_000);
      // 複数 observation
      for (let i = 0; i < 5; i++) {
        loss.update(0.0, 500_000, 500_000, 20, 0, 1000 + i, 20_000);
      }
      const up = loss.targetBitrateBps;
      for (let i = 0; i < 5; i++) {
        loss.update(0.3, 400_000, 400_000, 20, 6, 2000 + i, 20_000);
      }
      expect(loss.targetBitrateBps).toBeLessThan(up);
      expect(loss.averageLossRatio).toBeGreaterThan(0.05);
      expect(["decreasing", "hold", "delay_based"]).toContain(loss.lossState);
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

  describe("Probe padding 品質", () => {
    test("padding bit・一意 sequence・受信可能な wire 形式", async () => {
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

      // padding パケットは P-bit と paddingSize
      const padHeaders = sentPackets.filter((p) => p.header.padding);
      expect(padHeaders.length).toBeGreaterThan(0);
      for (const p of padHeaders) {
        expect(p.header.padding).toBe(true);
        expect(p.header.paddingSize).toBe(kProbePaddingPacketBytes);
        // シリアライズして再パース可能（受信可能性）
        const wire = new RtpPacket(p.header, p.payload).serialize();
        const parsed = RtpPacket.deSerialize(wire);
        expect(parsed.header.padding).toBe(true);
        expect(parsed.header.paddingSize).toBe(kProbePaddingPacketBytes);
      }

      // RTP sequence が一意かつ単調増加
      const seqs = sentPackets.map((p) => p.header.sequenceNumber);
      expect(new Set(seqs).size).toBe(seqs.length);
      for (let i = 1; i < seqs.length; i++) {
        expect(uint16Forward(seqs[i - 1], seqs[i])).toBe(true);
      }

      // isProbation タグ
      const probation = rtpSpy.mock.calls.filter(
        (c) => (c[0] as SentInfo).isProbation,
      );
      expect(probation.length).toBeGreaterThan(0);
    });

    test("maybeInjectProbePadding が専用経路で padding を送る", async () => {
      const { sender, sentPackets } = await prepareConnectedSender(
        new GccBandwidthEstimator(100_000),
      );
      const n = await sender.maybeInjectProbePadding();
      expect(n).toBeGreaterThan(0);
      expect(sentPackets.every((p) => p.header.padding)).toBe(true);
      const seqs = sentPackets.map((p) => p.header.sequenceNumber);
      expect(new Set(seqs).size).toBe(seqs.length);
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
});

/** True if b is the next sequence after a (or later within half-range). */
function uint16Forward(a: number, b: number): boolean {
  const da = (b - a + 0x10000) & 0xffff;
  return da > 0 && da < 0x8000;
}
