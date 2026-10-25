import { describe, expect, test, vi } from "vitest";
import type { Config } from "../../../rtp/src/srtp/session";
import { SrtpSession } from "../../../rtp/src/srtp/srtp";
import {
  type BandwidthEstimator,
  DisabledBandwidthEstimator,
  GccBandwidthEstimator,
  PacketResult,
  PacketStatus,
  type ProbePacingController,
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpSender,
  RtcpPacketConverter,
  RtcpTransportLayerFeedback,
  RtpHeader,
  RtpPacket,
  SenderBandwidthEstimator,
  type SentInfo,
  TWCC_REFERENCE_TIME_MOD,
  TWCC_REFERENCE_TIME_UNIT_MS,
  TransportWideCC,
  appendRfc3550Padding,
  hasTwccReceiveTiming,
  isBandwidthEstimatorProcessor,
  isNetworkAvailabilityConsumer,
  isProbePacingController,
  isRoundTripTimeConsumer,
  isSenderBandwidthEstimator,
  kGoogCcProcessIntervalMs,
  kProbePaddingPacketBytes,
} from "../../src";
import { RTP_EXTENSION_URI } from "../../src/imports/rtp";
import { createDtlsTransport } from "../fixture";
import { type GccLink, bitrateAt, runGccSimulation } from "./gccSimulation";
import {
  prepareConnectedSender,
  startGccProbing,
  startGccProbingWithoutSenderPadding,
  twccHistoryOf,
} from "./twccTestUtils";

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

describe("media/sender bandwidth estimator", () => {
  describe("共通契約（BandwidthEstimator / RTCRtpSender）", () => {
    test("probe / RTT / process は共通 interface にあり、legacy と disabled は no-op", () => {
      // Arrange
      const legacy: BandwidthEstimator = new SenderBandwidthEstimator();
      const disabled: BandwidthEstimator = new DisabledBandwidthEstimator();
      const gcc = new GccBandwidthEstimator();

      // Assert: 共通型から呼べる
      for (const e of [legacy, disabled]) {
        expect(e.shouldTagProbePacket()).toBe(false);
        expect(e.getPacingBitrateBps()).toBe(0);
        expect(e.reserveOutgoingProbe(0)).toBeUndefined();
        expect(e.pendingProbePaddingPackets()).toBe(0);
        expect(e.getPaddingBitrateBps()).toBe(0);
        expect(e.pendingLossPaddingPackets()).toBe(0);
        expect(e.processIntervalMs).toBe(0);
        expect(e.probePaddingPacketBytes).toBe(0);
        expect(e.probePaddingMaxBurst).toBe(0);
        e.setRoundTripTime(42);
        e.setNetworkAvailable(true);
        e.process(0);
        expect(e.availableBitrate).toBe(0);
      }

      // Act / Assert: type guard は実効的な GCC のみ true
      expect(isProbePacingController(legacy)).toBe(false);
      expect(isProbePacingController(disabled)).toBe(false);
      expect(isProbePacingController(gcc)).toBe(true);
      expect(isRoundTripTimeConsumer(legacy)).toBe(false);
      expect(isRoundTripTimeConsumer(gcc)).toBe(true);
      expect(isNetworkAvailabilityConsumer(legacy)).toBe(false);
      expect(isNetworkAvailabilityConsumer(gcc)).toBe(true);
      expect(isBandwidthEstimatorProcessor(legacy)).toBe(false);
      expect(isBandwidthEstimatorProcessor(gcc)).toBe(true);
      const probe: ProbePacingController = gcc;
      expect(probe.getPacingBitrateBps()).toBeGreaterThan(0);
      expect(gcc.processIntervalMs).toBe(kGoogCcProcessIntervalMs);
      expect(gcc.probePaddingPacketBytes).toBe(kProbePaddingPacketBytes);
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

    test("senderBWE.onCongestion は TypeScript 互換のため全 estimator に存在する", () => {
      // Arrange
      const sender = new RTCRtpSender("audio");

      // Assert: 既定 legacy では具象イベントに到達できる
      expect(isSenderBandwidthEstimator(sender.senderBWE)).toBe(true);
      expect(typeof sender.senderBWE.onCongestion.subscribe).toBe("function");

      // Act
      sender.setBandwidthEstimator(new GccBandwidthEstimator());

      // Assert: GCC でも同名の no-op Event があり、既存の参照が compile error にならない
      expect(isSenderBandwidthEstimator(sender.senderBWE)).toBe(false);
      expect(typeof sender.senderBWE.onCongestion.subscribe).toBe("function");
      expect(sender.senderBWE.congestionScore).toBe(1);
    });
  });

  describe("legacy（SenderBandwidthEstimator）", () => {
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

    test("legacy sentInfos の時間窓 prune は先頭からのみ削除し、窓内件数で線形に走査しない", () => {
      // Arrange: 1000 pps で 10s 窓が満杯（約 10,000 件）になる送信列
      const legacy = new SenderBandwidthEstimator();
      const send = (i: number) =>
        legacy.rtpPacketSent({
          wideSeq: i,
          size: 100,
          sendingAtMs: i,
          sentAtMs: i,
        });

      // Act: 20,000 件送る（後半 10,000 件は毎回 1 件ずつ窓外になる）
      const t0 = performance.now();
      for (let i = 1; i <= 20_000; i++) {
        send(i);
      }
      const elapsedMs = performance.now() - t0;

      // Assert: 窓内（直近 10s）だけが送信順のまま残る
      const keys = [...twccHistoryOf(legacy).keys()];
      expect(keys.length).toBe(10_001);
      expect(keys[0]).toBe(10_000);
      expect(keys.at(-1)).toBe(20_000);
      // Assert: 全走査（旧実装で約 2.5s）ではなく償却 O(1)。余裕を持たせた上限
      expect(elapsedMs).toBeLessThan(500);
    });
  });

  describe("TWCC 入力の解釈", () => {
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

    test("空 TWCC では通知しない", () => {
      const gcc = new GccBandwidthEstimator(300_000);
      const fired: number[] = [];
      gcc.onAvailableBitrate.subscribe((v) => fired.push(v));
      gcc.receiveTWCC(makeTwccFeedback([]));
      expect(fired).toEqual([]);
      expect(gcc.availableBitrate).toBe(0);
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

    test("Gcc receiveTWCC は 16-bit wrap した probe seq を推定できる", () => {
      // Arrange: wire seq 0xffff → 0。clock=0 の send も含む
      const { gcc, setNow } = createClockGcc(100_000, 0);
      gcc.setBitrates(10_000, 100_000, 1e9);
      const seqs = [0xfffd, 0xfffe, 0xffff, 0, 1, 2];
      for (let i = 0; i < seqs.length; i++) {
        gcc.rtpPacketSent(sent(seqs[i]!, 400, i * 2, { isProbation: true }));
      }

      // Act
      setNow(40);
      gcc.receiveTWCC(
        makeTwccFeedback(
          seqs.map((s, i) => {
            return new PacketResult({
              sequenceNumber: s,
              received: true,
              receivedAtMs: 20 + i * 2,
            });
          }),
        ),
      );

      // Assert: wrap + sendMs=0 でも probe 結果が target に載る
      expect(
        (gcc as any).probe.takePendingEstimateBps() + gcc.availableBitrate,
      ).toBeGreaterThan(0);
    });
  });

  describe("GCC 制御応答（仕様ベース）", () => {
    // draft-ietf-rmcat-gcc の振る舞いを、仮想ボトルネックでの結果の傾向として確認する。
    // libwebrtc と同じ順序・境界値かどうかは検証しない。
    const link = (capacityBps: number, extra: Partial<GccLink> = {}) => ({
      capacityBps,
      baseDelayMs: 40,
      queueLimitBytes: 60_000,
      ...extra,
    });

    test("容量を超える送信を続けると、推定は容量付近まで下がる", () => {
      // Arrange: 容量 1 Mbps に 3 Mbps を送り続ける（アプリは推定に追従しない）
      const capacityBps = 1_000_000;

      // Act
      const result = runGccSimulation({
        startBps: 3_000_000,
        phases: [
          { durationMs: 5_000, link: link(capacityBps), source: 3_000_000 },
        ],
      });

      // Assert: 2 秒以内に開始値から容量付近まで下がり、0 には張り付かない
      expect(bitrateAt(result, 2_000)).toBeLessThan(capacityBps * 1.2);
      expect(result.phaseEndBps[0]).toBeLessThan(capacityBps * 1.2);
      expect(result.phaseEndBps[0]).toBeGreaterThan(capacityBps * 0.4);
    });

    test("容量に余裕があれば probe で素早く上がり、容量を大きく超えない", () => {
      // Arrange: 開始 300 kbps、容量 2 Mbps、アプリは推定に追従する
      const capacityBps = 2_000_000;

      // Act
      const result = runGccSimulation({
        startBps: 300_000,
        phases: [
          { durationMs: 15_000, link: link(capacityBps), source: "follow" },
        ],
      });

      // Assert: probe padding が送られ、1 秒後には開始値の 3 倍以上に上がる
      expect(result.probePackets).toBeGreaterThan(0);
      expect(bitrateAt(result, 1_000)).toBeGreaterThan(900_000);
      // Assert: 収束後は容量の 70〜115% に収まり、キューあふれも起きない
      expect(result.phaseEndBps[0]).toBeGreaterThan(capacityBps * 0.7);
      expect(result.phaseEndBps[0]).toBeLessThan(capacityBps * 1.15);
      expect(result.queueDrops[0]).toBe(0);
    });

    test("容量が下がると推定も追従して下がり、追従後はあふれがほぼ止まる", () => {
      // Arrange: 2 Mbps で安定したあと容量が 500 kbps に落ちる
      const lowBps = 500_000;

      // Act
      const result = runGccSimulation({
        startBps: 1_000_000,
        phases: [
          { durationMs: 8_000, link: link(2_000_000), source: "follow" },
          { durationMs: 10_000, link: link(lowBps), source: "follow" },
          { durationMs: 5_000, link: link(lowBps), source: "follow" },
        ],
      });

      // Assert: 低下から 2 秒以内に新しい容量付近まで下がる
      expect(bitrateAt(result, 10_000)).toBeLessThan(lowBps * 1.2);
      // Assert: 最終値は新しい容量の 50〜110%
      expect(result.phaseEndBps[2]).toBeGreaterThan(lowBps * 0.5);
      expect(result.phaseEndBps[2]).toBeLessThan(lowBps * 1.1);
      // Assert: あふれは低下直後の過渡期だけで、追従後の 5 秒間は 0
      expect(result.queueDrops[1]).toBeGreaterThan(0);
      expect(result.queueDrops[2]).toBe(0);
    });

    test("容量が回復すると推定は上向きに動き、低い値に張り付かない", () => {
      // Arrange: 500 kbps から 2 Mbps へ回復する
      const capacityBps = 2_000_000;

      // Act
      const result = runGccSimulation({
        startBps: 400_000,
        phases: [
          { durationMs: 8_000, link: link(500_000), source: "follow" },
          { durationMs: 20_000, link: link(capacityBps), source: "follow" },
        ],
      });

      // Assert: 回復後に推定が 2 倍以上になり、容量は大きく超えない
      expect(result.phaseEndBps[1]).toBeGreaterThan(result.phaseEndBps[0] * 2);
      expect(result.phaseEndBps[1]).toBeLessThan(capacityBps * 1.15);
    });

    test("遅延が大きいだけで混雑していない経路では推定を下げない", () => {
      // Arrange: 片道 300ms の固定遅延。容量には余裕がある
      const capacityBps = 2_000_000;

      // Act
      const result = runGccSimulation({
        startBps: 300_000,
        phases: [
          {
            durationMs: 15_000,
            link: link(capacityBps, { baseDelayMs: 300 }),
            source: "follow",
          },
        ],
      });

      // Assert: 遅延の絶対値ではなく増え方を見るので、容量付近まで上がる
      expect(result.phaseEndBps[0]).toBeGreaterThan(capacityBps * 0.6);
      expect(result.phaseEndBps[0]).toBeLessThan(capacityBps * 1.2);
    });

    test("ロスが続くと、ロスがない場合より推定を大きく下げる", () => {
      // Arrange: 容量に余裕がある経路で、ロス 0% と 20% を比べる
      const run = (lossRate: number) =>
        runGccSimulation({
          startBps: 1_000_000,
          phases: [
            {
              durationMs: 10_000,
              link: link(3_000_000, { lossRate }),
              source: "follow",
            },
          ],
        });

      // Act
      const clean = run(0);
      const lossy = run(0.2);

      // Assert: ロスありの推定はロスなしの半分未満で、0 にはならない
      expect(lossy.phaseEndBps[0]).toBeLessThan(clean.phaseEndBps[0] * 0.5);
      expect(lossy.phaseEndBps[0]).toBeGreaterThan(0);
    });

    test("TWCC feedback が途絶えると、推定は安全側へ下がり続ける", () => {
      // Arrange: 安定したあと feedback だけが届かなくなる（送信は続く）
      const result = runGccSimulation({
        startBps: 1_000_000,
        phases: [
          { durationMs: 5_000, link: link(2_000_000), source: "follow" },
          {
            durationMs: 8_000,
            link: link(2_000_000),
            source: "follow",
            feedback: false,
          },
        ],
      });

      // Assert: 途絶前の半分未満まで下がり、途絶の後半は前半より低い
      const before = result.phaseEndBps[0];
      expect(result.phaseEndBps[1]).toBeLessThan(before * 0.5);
      expect(bitrateAt(result, 13_000)).toBeLessThanOrEqual(
        bitrateAt(result, 9_000),
      );
      expect(result.phaseEndBps[1]).toBeGreaterThan(0);
    });
  });

  describe("RTCRtpSender 送信経路（werift 固有の回帰）", () => {
    test("大きな probe cluster でも padding が完遂できる", async () => {
      // Arrange: 高 start → 3x probe target が大きく、minBytes が maxBurst を超える
      const gcc = new GccBandwidthEstimator(1_000_000);
      const { sender } = await prepareConnectedSender(gcc);
      // Arrange: cluster 開始時の自動注入を止め、本呼び出しで完遂を検証する
      startGccProbingWithoutSenderPadding(sender, gcc);
      // Act
      const n = await sender.maybeInjectProbePadding();
      // Assert: 単一 maxBurst では足りず、外側ループで完遂する
      expect(n).toBeGreaterThan(16);
      expect(gcc.pendingProbePaddingPackets()).toBe(0);
    });

    test("padding bit・実 padding bytes・一意 sequence", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, sentPackets } = await prepareConnectedSender(gcc);
      startGccProbing(gcc);
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

      // padding は RTX SSRC / PT で送り、media の番号空間を使わない
      for (const p of padPackets) {
        expect(p.header.ssrc).toBe(sender.rtxSsrc);
        expect(p.header.payloadType).toBe(97);
      }
      // RTP sequence は SSRC ごとに一意かつ単調増加
      for (const ssrc of [sender.ssrc, sender.rtxSsrc]) {
        const seqs = sentPackets
          .filter((p) => p.header.ssrc === ssrc)
          .map((p) => p.header.sequenceNumber);
        expect(new Set(seqs).size).toBe(seqs.length);
        for (let i = 1; i < seqs.length; i++) {
          expect(uint16Forward(seqs[i - 1], seqs[i])).toBe(true);
        }
      }
    });

    test("maybeInjectProbePadding が専用経路で padding を送る", async () => {
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, sentPackets } = await prepareConnectedSender(gcc);
      startGccProbingWithoutSenderPadding(sender, gcc);
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
      startGccProbingWithoutSenderPadding(sender, gcc);
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
      const padPayloads = payloads.filter(
        (p) => p.length === kProbePaddingPacketBytes,
      );
      expect(padPayloads.length).toBe(padCalls.length);
      for (let i = 0; i < padCalls.length; i++) {
        expect(padPayloads[i][padPayloads[i].length - 1]).toBe(
          kProbePaddingPacketBytes,
        );
      }
      for (const info of padCalls) {
        expect(sizes).toContain(info.size);
      }
    });

    test("BUNDLE で pacing 中の TSN は wire send 順と一致する", async () => {
      // Arrange: video が pacer で止まり、audio が先に送る
      const gccVideo = new GccBandwidthEstimator(100_000);
      const gccAudio = new GccBandwidthEstimator(100_000);
      // RTX なし: padding を出さず media の TSN 順だけを見る
      const { sender: video, dtls } = await prepareConnectedSender(gccVideo, {
        rtx: false,
      });
      startGccProbing(gccVideo);
      startGccProbing(gccAudio);
      (gccVideo as any).probe.abort(0);
      (gccVideo as any).probe.state = "complete";
      (gccAudio as any).probe.abort(0);
      (gccAudio as any).probe.state = "complete";
      vi.spyOn(gccVideo, "getPacingBitrateBps").mockReturnValue(1_000_000);
      vi.spyOn(gccAudio, "getPacingBitrateBps").mockReturnValue(1_000_000);
      const audio = new RTCRtpSender("audio");
      audio.setDtlsTransport(dtls);
      audio.setBandwidthEstimator(gccAudio);
      audio.prepareSend({
        codecs: [
          new RTCRtpCodecParameters({
            mimeType: "audio/opus",
            clockRate: 48000,
            payloadType: 111,
          }),
        ],
        headerExtensions: [
          new RTCRtpHeaderExtensionParameters({
            id: 3,
            uri: RTP_EXTENSION_URI.transportWideCC,
          }),
        ],
        muxId: "1",
        rtcp: { cname: "test", mux: true },
      });

      let releaseVideo!: () => void;
      const holdVideo = new Promise<void>((resolve) => {
        releaseVideo = resolve;
      });
      const origPace = (video as any).awaitPacingBudget.bind(video);
      (video as any).awaitPacingBudget = async (...args: unknown[]) => {
        await holdVideo;
        return origPace(...args);
      };

      const wireTsns: number[] = [];
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        const twcc = header.extensions.find((ext) => ext.id === 3);
        wireTsns.push(twcc ? twcc.payload.readUInt16BE(0) : -1);
        return payload.length + header.serializeSize;
      }) as typeof dtls.sendRtp;

      const mk = (seq: number, pt: number) =>
        new RtpPacket(
          new RtpHeader({
            sequenceNumber: seq,
            timestamp: seq * 1000,
            payloadType: pt,
            ssrc: 1,
            extension: true,
            extensions: [],
            marker: false,
            padding: false,
            payloadOffset: 12,
          }),
          Buffer.alloc(80),
        );

      // Act: video が pacing 待ちのあいだに audio を送る
      const videoSend = video.sendRtp(mk(1, 96));
      await Promise.resolve();
      await Promise.resolve();
      await audio.sendRtp(mk(1, 111));
      releaseVideo();
      await videoSend;

      // Assert: 先に出た audio が TSN 1、後着 video が 2（確保→待ちの逆転ではない）
      expect(wireTsns).toEqual([1, 2]);
    });

    test("pacing 中の stop は packetCount / NACK cache を commit しない", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      vi.spyOn(gcc, "getPacingBitrateBps").mockReturnValue(1_000_000);
      const sendSpy = dtls.sendRtp as ReturnType<typeof vi.fn>;
      sendSpy.mockClear();
      const countBefore = (sender as any).packetCount;
      const cacheBefore = (sender as any).rtpCache.filter(Boolean).length;
      (sender as any).awaitPacingBudget = async () => {
        sender.stop();
        return false;
      };

      // Act
      await sender.sendRtp(
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
          Buffer.alloc(80),
        ),
      );

      // Assert
      expect((sender as any).packetCount).toBe(countBefore);
      expect((sender as any).rtpCache.filter(Boolean)).toHaveLength(
        cacheBefore,
      );
      expect(sendSpy).not.toHaveBeenCalled();
    });

    test("outgoing FIFO 超過時は古い video を落とす", async () => {
      // Arrange: DTLS を遅くし、キュー上限を超える
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true;
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        if (first) {
          first = false;
          await hold;
        }
        return payload.length + header.serializeSize;
      }) as typeof dtls.sendRtp;

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

      // Act: 1 本 in-flight + 60 キュー
      const pending = [sender.sendRtp(mk(1))];
      await Promise.resolve();
      for (let i = 2; i <= 61; i++) {
        pending.push(sender.sendRtp(mk(i)));
      }
      release();
      await Promise.all(pending);

      // Assert: 上限 48 + 実行中 1 を超えて送らない
      expect(
        (dtls.sendRtp as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeLessThanOrEqual(49);
      expect(
        (dtls.sendRtp as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(1);
    });

    test("probe padding は待ち media に譲る", async () => {
      // Arrange: 初回 media の DTLS を止め、その間に次 media を積む
      const gcc = new GccBandwidthEstimator(1_000_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      startGccProbing(gcc);
      let releaseFirst!: () => void;
      const holdFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstHeld = false;
      const order: string[] = [];
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        order.push(header.padding ? "pad" : "media");
        if (!firstHeld) {
          firstHeld = true;
          await holdFirst;
        }
        return payload.length + header.serializeSize;
      }) as typeof dtls.sendRtp;

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

      // Act
      const first = sender.sendRtp(mk(1));
      await Promise.resolve();
      await Promise.resolve();
      const second = sender.sendRtp(mk(2));
      releaseFirst();
      await Promise.all([first, second]);

      // Assert: 2 本目の media は padding 連打の後ろに埋まらない
      const mediaIdx = order
        .map((kind, i) => (kind === "media" ? i : -1))
        .filter((i) => i >= 0);
      expect(mediaIdx.length).toBeGreaterThanOrEqual(2);
      const padsBeforeSecond = order
        .slice(0, mediaIdx[1])
        .filter((kind) => kind === "pad").length;
      expect(padsBeforeSecond).toBeLessThanOrEqual(1);
    });

    test("sendingAtMs は DTLS send 完了後ではなく送信開始前の時刻である", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probingConfigured = true;
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        return payload.length + header.serializeSize;
      }) as typeof dtls.sendRtp;
      const sent: SentInfo[] = [];
      const orig = gcc.rtpPacketSent.bind(gcc);
      gcc.rtpPacketSent = (info: SentInfo) => {
        sent.push(info);
        orig(info);
      };

      // Act
      await sender.sendRtp(
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
          Buffer.alloc(80),
        ),
      );

      // Assert: ICE wait は sentAtMs に入り、sendingAtMs には入らない
      expect(sent).toHaveLength(1);
      expect(sent[0].sentAtMs - sent[0].sendingAtMs).toBeGreaterThanOrEqual(15);
    });

    test("pacer は RED 構築後のパケットサイズを使う", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender } = await prepareConnectedSender(gcc);
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probingConfigured = true;
      sender.prepareSend({
        codecs: [
          new RTCRtpCodecParameters({
            mimeType: "audio/red",
            clockRate: 48000,
            payloadType: 63,
            parameters: "111/111",
          }),
          new RTCRtpCodecParameters({
            mimeType: "audio/opus",
            clockRate: 48000,
            payloadType: 111,
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
      const paced: number[] = [];
      const orig = (sender as any).awaitPacingBudget.bind(sender);
      (sender as any).awaitPacingBudget = async (
        n: number,
        ...rest: unknown[]
      ) => {
        paced.push(n);
        return orig(n, ...rest);
      };

      // Act: 小さな payload を RED 経路で送る
      await sender.sendRtp(
        new RtpPacket(
          new RtpHeader({
            sequenceNumber: 1,
            timestamp: 1000,
            payloadType: 111,
            ssrc: 1,
            extension: true,
            extensions: [],
            marker: false,
            padding: false,
            payloadOffset: 12,
          }),
          Buffer.alloc(20),
        ),
      );

      // Assert: 生 payload 20+header より大きい（RED + TWCC extension）
      expect(paced.length).toBeGreaterThan(0);
      expect(paced[0]).toBeGreaterThan(20 + 12);
    });

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

    test("probe padding は SR octetCount に含めない", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, sentPackets } = await prepareConnectedSender(gcc);
      startGccProbingWithoutSenderPadding(sender, gcc);
      const before = (sender as any).octetCount as number;

      // Act: padding only
      const n = await sender.maybeInjectProbePadding();
      expect(n).toBeGreaterThan(0);
      expect(sentPackets.every((p) => p.header.padding)).toBe(true);

      // Assert: 0-byte media payload → octetCount 増分 0
      const after = (sender as any).octetCount as number;
      expect(after - before).toBe(0);
    });
  });

  describe("estimator の差し替え・停止", () => {
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
      expect(twccHistoryOf(newGcc).size).toBe(0);

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
      // 旧世代の in-flight 完了バイトを priorUnackedBytes に混ぜない
      expect(newSpy.mock.calls[0][0].priorUnackedBytes).toBe(0);
      // 旧への post-swap 配送はない（dispose 後に呼ばれても世代 discard）
      // oldSpy は差し替え前の同期経路で 0 回、または in-flight 完了時も discard
      const oldCallsAfterSwap = oldSpy.mock.calls.length;
      expect(oldCallsAfterSwap).toBe(0);
    });

    test("差し替えで in-flight probe padding が旧 estimator を再駆動しない", async () => {
      // Arrange: GCC probe padding を非同期開始し、途中で legacy に差し替え
      const gcc = new GccBandwidthEstimator(1_000_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      startGccProbing(gcc);

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

    test("差し替え中に発火した新 GCC probe は旧 padding in-flight を跨いで送信される", async () => {
      // Arrange: 旧 GCC の padding 送信を DTLS で止め、その間に新 GCC へ差し替える
      const oldGcc = new GccBandwidthEstimator(1_000_000);
      const { sender, dtls } = await prepareConnectedSender(oldGcc);
      startGccProbing(oldGcc);

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

      const oldPadPromise = sender.maybeInjectProbePadding();
      await Promise.resolve();
      await Promise.resolve();

      const newGcc = new GccBandwidthEstimator(1_000_000);
      const newSent = vi.spyOn(newGcc, "rtpPacketSent");
      sender.setBandwidthEstimator(newGcc);

      // Act: 切替後に新 estimator の probe cluster を発火させる
      startGccProbing(newGcc);
      releaseFirst();
      await oldPadPromise;
      for (let i = 0; i < 50 && newSent.mock.calls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }

      // Assert: 新 GCC に probation 送信が届く（旧 in-flight ロックで破棄されない）
      const probation = newSent.mock.calls.filter(
        ([info]) => info?.isProbation === true,
      );
      expect(probation.length).toBeGreaterThan(0);
    });

    test("estimator dispose / reset は sentInfos と probe seq map を残さない", () => {
      // Arrange: 送信履歴と probe mapping を積む
      const gcc = new GccBandwidthEstimator(300_000);
      startGccProbing(gcc);
      gcc.rtpPacketSent(sent(1, 200, 1_000, { isProbation: true }));
      gcc.rtpPacketSent(sent(2, 200, 1_010, { isProbation: true }));
      expect(twccHistoryOf(gcc).size).toBeGreaterThan(0);

      // Act
      gcc.dispose();

      // Assert: stop/dispose 後に履歴が残らない
      expect(twccHistoryOf(gcc).size).toBe(0);
      expect((gcc as any).probe.seqToCluster.size).toBe(0);
      expect((gcc as any).probe.seqToSendInfo.size).toBe(0);
    });

    test("RTCRtpSender.stop は世代無効化・padding 停止・estimator dispose する", async () => {
      // Arrange: GCC + 送信履歴 + probe mapping
      const gcc = new GccBandwidthEstimator(300_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      startGccProbing(gcc);
      gcc.rtpPacketSent(sent(1, 200, 1_000, { isProbation: true }));
      gcc.rtpPacketSent(sent(2, 200, 1_010, { isProbation: true }));
      expect(twccHistoryOf(gcc).size).toBeGreaterThan(0);
      await Promise.resolve();
      await Promise.resolve();
      const sendsBeforeStop = (dtls.sendRtp as ReturnType<typeof vi.fn>).mock
        .calls.length;

      // Act
      sender.stop();

      // Assert: 履歴は dispose で解放される
      expect(twccHistoryOf(gcc).size).toBe(0);
      expect((gcc as any).probe.seqToCluster.size).toBe(0);
      expect((gcc as any).lossBwe.partial.numPackets).toBe(0);
      expect((gcc as any).lossBwe.partial.lostPackets.size).toBe(0);
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
      startGccProbing(gcc);

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
      expect(twccHistoryOf(gcc).size).toBe(0);
    });

    test("connected sender に差し込むと network available が同期される", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      expect((gcc as any).probe.isNetworkAvailable).toBe(false);

      // Act: 既に DTLS connected な sender へ差し込む
      await prepareConnectedSender(gcc);

      // Assert: pin OnNetworkAvailability(true) 相当。process 前なので 3x はまだ
      expect((gcc as any).probe.isNetworkAvailable).toBe(true);
    });
  });
});

function uint16Forward(a: number, b: number): boolean {
  const da = (b - a + 0x10000) & 0xffff;
  return da > 0 && da < 0x8000;
}
