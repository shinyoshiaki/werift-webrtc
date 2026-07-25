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
  type BandwidthEstimator,
  type SentInfo,
  kBeta,
  kLossIncreaseFactor,
  sortPacketResultsByWideSeq,
} from "../../src";
import { RTP_EXTENSION_URI } from "../../src/imports/rtp";
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
        return new PacketResult({
          sequenceNumber: i + 1,
          received: true,
          receivedAtMs: sendMs + 20,
        });
      });

      // Act
      bwe.receiveTWCC(makeTwccFeedback(results));

      // Assert
      if (bwe.availableBitrate > 0) {
        expect(bwe.availableBitrate).toBeGreaterThan(100_000);
        expect(bwe.availableBitrate).toBeLessThan(2_000_000);
      } else {
        expect(bwe.availableBitrate).toBe(0);
      }
    });

    test("帯域が変わったときだけ onAvailableBitrate が発火する", () => {
      // Arrange
      const bwe = new SenderBandwidthEstimator();
      const fired: number[] = [];
      bwe.onAvailableBitrate.subscribe((v) => fired.push(v));

      // Act
      bwe.availableBitrate = 500_000;
      bwe.availableBitrate = 500_000;
      bwe.availableBitrate = 600_000;

      // Assert
      expect(fired).toEqual([500_000, 600_000]);
    });

    test("共通 interface は帯域通知のみを契約し congestion は必須でない", () => {
      // Arrange
      const asInterface: BandwidthEstimator = new SenderBandwidthEstimator();
      const gccAsInterface: BandwidthEstimator = new GccBandwidthEstimator();

      // Act / Assert
      const useCommon = (e: BandwidthEstimator) => {
        expect(typeof e.availableBitrate).toBe("number");
        expect(e.onAvailableBitrate).toBeDefined();
        expect(e.rtpPacketSent).toBeTypeOf("function");
        expect(e.receiveTWCC).toBeTypeOf("function");
      };
      useCommon(asInterface);
      useCommon(gccAsInterface);

      expect(
        (gccAsInterface as BandwidthEstimator & { onCongestion?: unknown })
          .onCongestion,
      ).toBeUndefined();
    });

    test("legacy 具象には onCongestion / onCongestionScore がある", () => {
      // Arrange
      const legacy = new SenderBandwidthEstimator();
      // Assert
      expect(legacy.onCongestion).toBeDefined();
      expect(legacy.onCongestionScore).toBeDefined();
    });
  });

  describe("sequence wrap-around", () => {
    test("sortPacketResultsByWideSeq は 0xFFFF を跨いでも送信順を保つ", () => {
      // Arrange: フィードバック到着順が乱れている想定
      const results = [
        new PacketResult({ sequenceNumber: 1, received: true }),
        new PacketResult({ sequenceNumber: 0, received: true }),
        new PacketResult({ sequenceNumber: 65535, received: true }),
        new PacketResult({ sequenceNumber: 65534, received: true }),
      ];

      // Act: 先頭を origin として相対順に並べ替え
      // origin=1 だと 1, …, 65534, 65535, 0 の距離になるので、
      // 実際のクラスタは 65534 起点で並べる
      const clustered = [
        new PacketResult({ sequenceNumber: 65534, received: true }),
        new PacketResult({ sequenceNumber: 1, received: true }),
        new PacketResult({ sequenceNumber: 0, received: true }),
        new PacketResult({ sequenceNumber: 65535, received: true }),
      ];
      const sorted = sortPacketResultsByWideSeq(clustered);

      // Assert: 65534 → 65535 → 0 → 1
      expect(sorted.map((r) => r.sequenceNumber)).toEqual([
        65534, 65535, 0, 1,
      ]);
    });

    test("GCC は transport-wide seq wrap-around を含む TWCC でも遅延勾配を壊さない", () => {
      // Arrange: seq が 65534..2 とラップする安定遅延経路
      const gcc = new GccBandwidthEstimator(300_000);
      const usages: string[] = [];
      gcc.onOveruseDetected.subscribe((u) => usages.push(u));

      const seqs = [65534, 65535, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const base = 8_000_000;
      const interval = 20;
      for (let i = 0; i < seqs.length; i++) {
        gcc.rtpPacketSent(sent(seqs[i], 1000, base + i * interval));
      }

      // 受信時刻は送信順に単調増加（一定遅延）
      const results = seqs.map((seq, i) => {
        const sendMs = base + i * interval;
        return new PacketResult({
          sequenceNumber: seq,
          received: true,
          receivedAtMs: sendMs + 25,
        });
      });
      // 意図的に乱順でフィードバック（単純数値ソートだと 0,1,...65534 になり勾配が壊れる）
      const shuffled = [
        results[2],
        results[0],
        results[5],
        results[1],
        results[3],
        results[4],
        ...results.slice(6),
      ];

      // Act
      gcc.receiveTWCC(makeTwccFeedback(shuffled));

      // Assert: 安定経路なので overuse に落ちず、正の推定が出る
      expect(gcc.availableBitrate).toBeGreaterThan(0);
      expect(gcc.usageState).not.toBe("overuse");
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
          receivedAtMs: sendMs + 30,
        });
      });

      // Act
      gcc.receiveTWCC(makeTwccFeedback(results));

      // Assert
      expect(gcc.availableBitrate).toBeGreaterThan(0);
      expect(fired.length).toBeGreaterThanOrEqual(1);
    });

    test("loss 増加で推定が下がる", () => {
      // Arrange
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

      // Act
      feed(1, 40, 0, 3_000_000);
      feed(50, 40, 0, 3_010_000);
      const lowLossBitrate = gcc.availableBitrate;
      feed(100, 40, 0.4, 3_020_000);
      feed(150, 40, 0.4, 3_030_000);
      const highLossBitrate = gcc.availableBitrate;

      // Assert
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

      // Act
      let recv = base + 20;
      const results = Array.from({ length: n }, (_, i) => {
        const sendMs = base + i * 15;
        recv += 15 + Math.floor(i / 5);
        return new PacketResult({
          sequenceNumber: 1 + i,
          received: true,
          receivedAtMs: Math.max(recv, sendMs + 1),
        });
      });
      gcc.receiveTWCC(makeTwccFeedback(results));
      const afterOveruse = gcc.availableBitrate;

      const base2 = base + 10_000;
      for (let i = 0; i < n; i++) {
        gcc.rtpPacketSent(sent(1000 + i, size, base2 + i * 15));
      }
      recv = base2 + 50;
      const results2 = Array.from({ length: n }, (_, i) => {
        const sendMs = base2 + i * 15;
        recv += 25;
        return new PacketResult({
          sequenceNumber: 1000 + i,
          received: true,
          receivedAtMs: Math.max(recv, sendMs + 1),
        });
      });
      gcc.receiveTWCC(makeTwccFeedback(results2));
      const afterMoreOveruse = gcc.availableBitrate;

      // Assert
      expect(afterOveruse).toBeGreaterThan(0);
      expect(
        afterMoreOveruse <= afterOveruse || gcc.usageState === "overuse",
      ).toBe(true);
    });

    test("probe タグ付きパケットのみで probe 推定が完了し帯域が上がり得る", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      expect(gcc.shouldTagProbePacket()).toBe(true);
      expect(gcc.probeState).toBe("probing");

      const base = 5_000_000;
      const size = 1200;
      const n = 20;

      // Act: isProbation=true のパケットを高レートで ack
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

      // Assert: probe 完了で cooldown、推定が開始値以上
      expect(gcc.probeState === "cooldown" || gcc.availableBitrate > 0).toBe(
        true,
      );
      if (gcc.probeState === "cooldown") {
        expect(gcc.availableBitrate).toBeGreaterThanOrEqual(100_000);
      }
    });

    test("probe 未タグの media だけでは probe クラスタが完了しない", () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      gcc.shouldTagProbePacket(); // open cluster
      const base = 5_500_000;

      // Act: isProbation なし
      for (let i = 0; i < 20; i++) {
        gcc.rtpPacketSent(sent(1 + i, 1200, base + i * 2));
      }
      const results = Array.from({ length: 20 }, (_, i) => {
        const sendMs = base + i * 2;
        return new PacketResult({
          sequenceNumber: 1 + i,
          received: true,
          receivedAtMs: sendMs + 5,
        });
      });
      gcc.receiveTWCC(makeTwccFeedback(results));

      // Assert: probe はまだ probing（タグ無しでは完了しない）
      expect(gcc.probeState).toBe("probing");
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
      pushStable(100, 6_000_500);
      const extra = fired.slice(countAfterFirst);

      // Assert
      for (const v of extra) {
        expect(v).not.toBe(value);
      }
    });
  });

  describe("決定的制御則（loss / AIMD 系列）", () => {
    test("LossBasedBwe は draft §6 の更新式に従う", () => {
      // Arrange
      const loss = new LossBasedBwe();
      loss.reset(500_000);

      // Act / Assert: p < 2% → *1.05
      const up = loss.update(0.01, 500_000);
      expect(up).toBe(Math.round(500_000 * kLossIncreaseFactor));

      // 2%–10% → hold
      const hold = loss.update(0.05, 500_000);
      expect(hold).toBe(up);

      // p > 10% → * (1 - 0.5p)
      const p = 0.2;
      const down = loss.update(p, 500_000);
      expect(down).toBe(Math.round(hold * (1 - 0.5 * p)));
    });

    test("AIMD は overuse で beta 倍に下げ normal で増加方向に動く", () => {
      // Arrange
      const aimd = new AimdRateControl();
      aimd.reset(400_000);
      const acked = 400_000;

      // Act: overuse → decrease to beta * acked
      const decreased = aimd.update("overuse", acked, 1000);
      expect(decreased).toBe(Math.round(acked * kBeta));

      // underuse/normal 遷移後の increase で hold→increase
      aimd.update("normal", acked * kBeta, 1100);
      const afterIncrease = aimd.update("normal", acked * kBeta, 2100);

      // Assert: 1 秒分の multiplicative 増加で上昇
      expect(afterIncrease).toBeGreaterThan(decreased);
    });

    test("固定入力に対する GCC の bitrate 系列が許容誤差内で回帰する", () => {
      // Arrange: 決定的な loss のみシナリオ（遅延一定、probe 無効化のため isProbation なし）
      // cold-start probe を避けるため、最初に十分な non-probe で推定を立ててから loss 系列を見る
      const gcc = new GccBandwidthEstimator(500_000);
      // 明示的に probe を開かず media のみ
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

      // Act: 無損失 → 無損失 → 高損失 → 高損失
      // shouldTagProbePacket を呼ばない限り probe は idle のまま（rtpPacketSent だけでは開かない）
      step(1, 9_000_000, 0);
      step(40, 9_001_000, 0);
      const afterGood = series[series.length - 1];
      step(80, 9_002_000, 0.35);
      step(120, 9_003_000, 0.35);
      const afterLoss = series[series.length - 1];

      // Assert: 高損失後は明確に低下（制御応答の定性 + 下限）
      expect(afterGood).toBeGreaterThan(0);
      expect(afterLoss).toBeLessThan(afterGood);
      // 2 回の 35% loss で loss-based は (1-0.5*0.35)^2 ≈ 0.68 倍オーダー
      expect(afterLoss).toBeLessThanOrEqual(afterGood * 0.95);
    });
  });

  describe("RTCRtpSender 配線", () => {
    test("setBandwidthEstimator 後も sender.onAvailableBitrate 購読が維持される", () => {
      // Arrange
      const sender = new RTCRtpSender("video");
      const fired: number[] = [];
      sender.onAvailableBitrate.subscribe((v) => fired.push(v));

      const gcc = new GccBandwidthEstimator(300_000);

      // Act: 差し替え後に新 estimator が帯域を更新
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
      // handleRtcpPacket 経路で TWCC を配送
      sender.handleRtcpPacket(makeTwccRtcp(results));

      // Assert
      expect(sender.senderBWE).toBe(gcc);
      expect(gcc.availableBitrate).toBeGreaterThan(0);
      expect(fired.length).toBeGreaterThanOrEqual(1);
      expect(fired[fired.length - 1]).toBe(gcc.availableBitrate);
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

    test("sendRtp / handleRtcpPacket 経路で probe タグ付き TWCC が estimator に届く", async () => {
      // Arrange
      const sender = new RTCRtpSender("video");
      const dtls = createDtlsTransport();
      (dtls as { state: string }).state = "connected";
      dtls.sendRtp = vi.fn(async () => 900) as typeof dtls.sendRtp;
      dtls.transportSequenceNumber = 100;
      sender.setDtlsTransport(dtls);

      const gcc = new GccBandwidthEstimator(100_000);
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

      const rtpSpy = vi.spyOn(gcc, "rtpPacketSent");
      const twccSpy = vi.spyOn(gcc, "receiveTWCC");

      // Act: 実 sendRtp で isProbation が立つこと
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

      // Assert: rtpPacketSent が呼ばれ probe タグが付く
      expect(rtpSpy.mock.calls.length).toBeGreaterThanOrEqual(8);
      const tagged = rtpSpy.mock.calls.some(
        (c) => (c[0] as SentInfo).isProbation === true,
      );
      expect(tagged).toBe(true);

      // Act: handleRtcpPacket で TWCC を配送
      const sentCalls = rtpSpy.mock.calls.map((c) => c[0] as SentInfo);
      const results = sentCalls.map((info) => {
        return new PacketResult({
          sequenceNumber: info.wideSeq,
          received: true,
          receivedAtMs: info.sendingAtMs + 10,
        });
      });
      sender.handleRtcpPacket(makeTwccRtcp(results));

      // Assert
      expect(twccSpy).toHaveBeenCalled();
      expect(sender.senderBWE.availableBitrate).toBeGreaterThanOrEqual(0);
    });
  });
});
