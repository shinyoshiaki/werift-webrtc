import { describe, expect, test, vi } from "vitest";
import {
  type BandwidthEstimator,
  DisabledBandwidthEstimator,
  GccBandwidthEstimator,
  hasTwccReceiveTiming,
  isBandwidthEstimatorProcessor,
  isNetworkAvailabilityConsumer,
  isProbePacingController,
  isRoundTripTimeConsumer,
  isSenderBandwidthEstimator,
  kGoogCcProcessIntervalMs,
  kProbePaddingPacketBytes,
  PacketResult,
  PacketStatus,
  type ProbePacingController,
  RTCRtpCodecParameters,
  RTCRtpSender,
  RtcpTransportLayerFeedback,
  type RtpHeader,
  RtpPacket,
  SenderBandwidthEstimator,
  type SentInfo,
  TransportWideCC,
  TWCC_REFERENCE_TIME_MOD,
  TWCC_REFERENCE_TIME_UNIT_MS,
} from "../../src";
import { createRtpPacket } from "../fixture";
import { bitrateAt, type GccLink, runGccSimulation } from "./gccSimulation";
import {
  attachSender,
  type CapturedRtp,
  captureMatchedFeedback,
  connectedDtlsTransport,
  flushMicrotasks,
  holdFirstWrite,
  prepareConnectedSender,
  settleGccProbe,
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
        await sender.sendRtp(createRtpPacket(i, i * 3000, Buffer.alloc(1200)));
      }
      const elapsed = performance.now() - t0;

      // Assert: token-bucket があれば数百 ms かかるが、legacy は即時
      expect(elapsed).toBeLessThan(50);
    });

    test("BUNDLE で他の sender 宛ての TWCC だけを受けても、送信していない legacy は輻輳と判定しない", () => {
      // Arrange: 1 パケットも送っていない legacy と、その購読
      const legacy = new SenderBandwidthEstimator();
      const congestion: boolean[] = [];
      const scores: number[] = [];
      legacy.onCongestion.subscribe((v) => congestion.push(v));
      legacy.onCongestionScore.subscribe((v) => scores.push(v));
      const others = Array.from(
        { length: 20 },
        (_, i) =>
          new PacketResult({
            sequenceNumber: 1000 + i,
            received: true,
            receivedAtMs: 1000 + i * 10,
          }),
      );

      // Act: transport の fan-out で、他 sender の TWCC が 100ms 周期で約 4 秒分届く
      for (let i = 0; i < 40; i++) {
        legacy.receiveTWCC(makeTwccFeedback(others));
      }

      // Assert: develop と同じく congestion=false・score=1 のままで、イベントも出ない
      expect(legacy.congestion).toBe(false);
      expect(legacy.congestionScore).toBe(1);
      expect(congestion).toEqual([]);
      expect(scores).toEqual([]);
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

    test("空 TWCC では通知しない", () => {
      const gcc = new GccBandwidthEstimator(300_000);
      const fired: number[] = [];
      gcc.onAvailableBitrate.subscribe((v) => fired.push(v));
      gcc.receiveTWCC(makeTwccFeedback([]));
      expect(fired).toEqual([]);
      expect(gcc.availableBitrate).toBe(0);
    });

    test("reference_time wrap 前後でも acked bitrate / trendline が壊れない", () => {
      // Arrange: 送信時刻と同じ domain の clock
      const { gcc } = createClockGcc(300_000, 50_000);
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

    test("receivedAtMs=0 でも SmallDelta は delay サンプルとして受理する", () => {
      // Arrange: reference_time base 0 + first delta → receivedAtMs が 0 になり得る
      const { gcc } = createClockGcc(300_000, 100);
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
      // 送信確認は RTCRtpSender と同じ拡張 TSN、feedback は 16-bit の wire 番号
      const sentSeqs = [0xfffd, 0xfffe, 0xffff, 0x10000, 0x10001, 0x10002];
      const seqs = sentSeqs.map((s) => s & 0xffff);
      for (let i = 0; i < sentSeqs.length; i++) {
        gcc.rtpPacketSent(
          sent(sentSeqs[i]!, 400, i * 2, { isProbation: true }),
        );
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

    test("経路を初期化（resetNetworkRoute）しても、アプリ指定の max を超えて推定しない", () => {
      // Arrange: max 150 kbps を指定した直後に経路が初期化される GCC。容量 2 Mbps、アプリは推定に追従する
      const createEstimator = (clock: () => number, startBps: number) => {
        const gcc = new GccBandwidthEstimator(startBps, { clock });
        const setBitrates = gcc.setBitrates.bind(gcc);
        gcc.setBitrates = (min, start, max) => {
          setBitrates(min, start, max);
          gcc.resetNetworkRoute();
        };
        return gcc;
      };

      // Act
      const result = runGccSimulation({
        startBps: 100_000,
        minBps: 50_000,
        maxBps: 150_000,
        createEstimator,
        phases: [
          {
            durationMs: 10_000,
            link: link(2_000_000),
            source: "follow",
          },
        ],
      });

      // Assert: 推定は上がるが、通知はすべて max 150 kbps 以下
      expect(result.events.length).toBeGreaterThan(0);
      expect(Math.max(...result.events.map((e) => e.bps))).toBeLessThanOrEqual(
        150_000,
      );
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
    test("probe padding は RTX の padding-only RTP で cluster を最後まで送り、SentInfo と一致し、SR octetCount に数えない", async () => {
      // Arrange: 高 start → 3x probe target が大きく、minBytes が maxBurst を超える
      const gcc = new GccBandwidthEstimator(1_000_000);
      const { sender, sentPackets } = await prepareConnectedSender(gcc);
      // Arrange: cluster 開始時の自動注入を止め、本呼び出しの padding だけを観察する
      startGccProbingWithoutSenderPadding(sender, gcc);
      const spy = vi.spyOn(gcc, "rtpPacketSent");
      const octetsBefore = (sender as any).stats.octetCount as number;

      // Act
      const n = await sender.maybeInjectProbePadding();

      // Assert: 単一 maxBurst では足りず、外側ループで cluster を完遂する
      expect(n).toBeGreaterThan(16);
      expect(gcc.pendingProbePaddingPackets()).toBe(0);
      // Assert: 全パケットが RTX SSRC / PT の padding-only RTP で、番号は重複しない
      for (const p of sentPackets) {
        expectProbePaddingPacket(p);
        expect(p.header.ssrc).toBe(sender.rtxSsrc);
        expect(p.header.payloadType).toBe(97);
      }
      const seqs = sentPackets.map((p) => p.header.sequenceNumber);
      expect(new Set(seqs).size).toBe(seqs.length);
      // Assert: estimator へは送った padding ごとに probation の SentInfo が実送サイズで届く
      const infos = spy.mock.calls.map(([info]) => info);
      expect(infos.every((info) => info.isProbation)).toBe(true);
      expect(infos.map((info) => info.size)).toEqual(
        sentPackets.map((p) => p.size),
      );
      // Assert: media payload は 0 byte なので SR の octetCount は増えない
      expect((sender as any).stats.octetCount - octetsBefore).toBe(0);
    });

    test("media 送信で始まった probe padding は RTX SSRC に出て、media の番号を進めない", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, sentPackets } = await prepareConnectedSender(gcc);
      startGccProbing(gcc);

      // Act: media 1 本の送信で probe padding が自動注入される
      await sender.sendRtp(createRtpPacket(10, 1000, Buffer.alloc(80)));

      // Assert: media は 1 本だけで、padding はすべて RTX SSRC / PT の padding-only RTP
      const media = sentPackets.filter((p) => !p.header.padding);
      const padding = sentPackets.filter((p) => p.header.padding);
      expect(media.map((p) => p.header.ssrc)).toEqual([sender.ssrc]);
      expect(padding.length).toBeGreaterThan(0);
      for (const p of padding) {
        expectProbePaddingPacket(p);
        expect(p.header.ssrc).toBe(sender.rtxSsrc);
        expect(p.header.payloadType).toBe(97);
      }
    });

    test("BUNDLE で pacing 中の TSN は wire send 順と一致する", async () => {
      // Arrange: video が pacer で止まり、audio が先に送る
      const gccVideo = new GccBandwidthEstimator(100_000);
      const gccAudio = new GccBandwidthEstimator(100_000);
      // RTX なし: padding を出さず media の TSN 順だけを見る
      const {
        sender: video,
        dtls,
        sentPackets,
      } = await prepareConnectedSender(gccVideo, { rtx: false });
      startGccProbing(gccVideo);
      startGccProbing(gccAudio);
      settleGccProbe(gccVideo, { pacingBps: 1_000_000 });
      settleGccProbe(gccAudio, { pacingBps: 1_000_000 });
      const audio = attachSender(dtls, gccAudio, {
        kind: "audio",
        codecs: [opusCodec()],
        muxId: "1",
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
      const opus = createRtpPacket(1, 1000, Buffer.alloc(80));
      opus.header.payloadType = 111;

      // Act: video が pacing 待ちのあいだに audio を送る
      const videoSend = video.sendRtp(
        createRtpPacket(1, 1000, Buffer.alloc(80)),
      );
      await flushMicrotasks();
      await audio.sendRtp(opus);
      releaseVideo();
      await videoSend;

      // Assert: 先に出た audio が TSN 1、後着 video が 2（確保→待ちの逆転ではない）
      expect(sentPackets.map(wireTsnOf)).toEqual([1, 2]);
    });

    test("送信しない方向に変わったら、pacing 待ち・キュー内の RTP と probe padding を送らず、再開後は新しい RTP だけを送る", async () => {
      // Arrange: 実際の GCC（probe padding は止める）と遅い pacer。2 件目は FIFO で待つ
      const gcc = new GccBandwidthEstimator(300_000);
      const { sender, sentPackets } = await prepareConnectedSender(gcc);
      const inject = vi
        .spyOn(sender, "maybeInjectProbePadding")
        .mockResolvedValue(0);
      settleGccProbe(gcc, { configured: true, pacingBps: 8_000 });
      const sends = [1, 2].map((seq) =>
        sender.sendRtp(createRtpPacket(seq, seq * 3000, Buffer.alloc(80))),
      );
      await flushMicrotasks();

      // Act: 受付直後に recvonly / inactive 相当へ変える
      sender.setSendSuppressed(true);
      await Promise.all(sends);
      await new Promise((r) => setTimeout(r, 300));

      // Assert: 受付済みの 2 件は抑止後に DTLS へ書かれない
      expect(sentPackets).toHaveLength(0);

      // Act: 抑止中に probe padding を求める
      inject.mockRestore();
      startGccProbing(gcc);
      const padded = await sender.maybeInjectProbePadding();

      // Assert: padding も送らない
      expect(padded).toBe(0);
      expect(sentPackets).toHaveLength(0);

      // Act: 送信を再開して新しい RTP を送る
      settleGccProbe(gcc, { configured: true });
      sender.setSendSuppressed(false);
      await sender.sendRtp(createRtpPacket(3, 9000, Buffer.alloc(80)));

      // Assert: 再開後の RTP だけが media として出る
      const media = sentPackets.filter((p) => !p.header.padding);
      expect(media).toHaveLength(1);
      sender.stop();
    }, 10_000);

    test("pacing 中の stop は packetCount / NACK cache を commit しない", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      settleGccProbe(gcc, { pacingBps: 1_000_000 });
      const sendSpy = dtls.sendRtp as ReturnType<typeof vi.fn>;
      sendSpy.mockClear();
      const countBefore = (sender as any).stats.packetCount;
      const cacheBefore = (sender as any).rtpCache.filter(Boolean).length;
      (sender as any).awaitPacingBudget = async () => {
        sender.stop();
        return false;
      };

      // Act
      await sender.sendRtp(createRtpPacket(1, 1000, Buffer.alloc(80)));

      // Assert
      expect((sender as any).stats.packetCount).toBe(countBefore);
      expect((sender as any).rtpCache.filter(Boolean)).toHaveLength(
        cacheBefore,
      );
      expect(sendSpy).not.toHaveBeenCalled();
    });

    test("outgoing FIFO 超過時は古い video を落とす", async () => {
      // Arrange: DTLS を遅くし、キュー上限を超える
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      settleGccProbe(gcc);
      const { release } = holdFirstWrite(dtls);

      // Act: 1 本 in-flight + 60 キュー
      const pending = [
        sender.sendRtp(createRtpPacket(1, 1000, Buffer.alloc(80))),
      ];
      await Promise.resolve();
      for (let i = 2; i <= 61; i++) {
        pending.push(
          sender.sendRtp(createRtpPacket(i, i * 1000, Buffer.alloc(80))),
        );
      }
      release();
      await Promise.all(pending);

      // Assert: 上限 48 + 実行中 1 を超えて送らない
      const writes = (dtls.sendRtp as ReturnType<typeof vi.fn>).mock.calls
        .length;
      expect(writes).toBeLessThanOrEqual(49);
      expect(writes).toBeGreaterThan(1);
    });

    test("probe padding は待ち media に譲る", async () => {
      // Arrange: 初回 media の DTLS を止め、その間に次 media を積む
      const gcc = new GccBandwidthEstimator(1_000_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      startGccProbing(gcc);
      const order: string[] = [];
      const { release } = holdFirstWrite(dtls, (_, header) =>
        order.push(header.padding ? "pad" : "media"),
      );

      // Act
      const first = sender.sendRtp(createRtpPacket(1, 1000, Buffer.alloc(80)));
      await flushMicrotasks();
      const second = sender.sendRtp(createRtpPacket(2, 2000, Buffer.alloc(80)));
      release();
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
      // Arrange: DTLS write に 25ms かかる
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      settleGccProbe(gcc, { configured: true });
      const write = dtls.sendRtp.bind(dtls);
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        return write(payload, header);
      }) as typeof dtls.sendRtp;
      const spy = vi.spyOn(gcc, "rtpPacketSent");

      // Act
      await sender.sendRtp(createRtpPacket(1, 1000, Buffer.alloc(80)));

      // Assert: ICE wait は sentAtMs に入り、sendingAtMs には入らない
      expect(spy).toHaveBeenCalledTimes(1);
      const [info] = spy.mock.calls[0];
      expect(info.sentAtMs - info.sendingAtMs).toBeGreaterThanOrEqual(15);
    });

    test("pacer は RED 構築後のパケットサイズを使う", async () => {
      // Arrange: audio/red + opus を交渉した sender
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender } = await prepareConnectedSender(gcc, {
        codecs: [
          new RTCRtpCodecParameters({
            mimeType: "audio/red",
            clockRate: 48000,
            payloadType: 63,
            parameters: "111/111",
          }),
          opusCodec(),
        ],
      });
      settleGccProbe(gcc, { configured: true });
      const paced: number[] = [];
      const orig = (sender as any).awaitPacingBudget.bind(sender);
      (sender as any).awaitPacingBudget = async (
        n: number,
        ...rest: unknown[]
      ) => {
        paced.push(n);
        return orig(n, ...rest);
      };
      const opus = createRtpPacket(1, 1000, Buffer.alloc(20));
      opus.header.payloadType = 111;

      // Act: 小さな payload を RED 経路で送る
      await sender.sendRtp(opus);

      // Assert: 生 payload 20+header より大きい（RED + TWCC extension）
      expect(paced.length).toBeGreaterThan(0);
      expect(paced[0]).toBeGreaterThan(20 + 12);
    });

    test("TWCC 未交渉では probe padding を送らない", async () => {
      // Arrange: headerExtensions に transport-cc 無し
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, sentPackets } = await prepareConnectedSender(gcc, {
        twcc: false,
      });
      const rtp = createRtpPacket(1, 1000, Buffer.alloc(200));
      rtp.header.extension = false;

      // Act
      await sender.sendRtp(rtp);

      // Assert: media のみ、padding なし、BWE にも送っていない
      expect(sentPackets.length).toBe(1);
      expect(sentPackets.every((p) => !p.header.padding)).toBe(true);
      expect(gcc.availableBitrate).toBe(0);
    });
  });

  describe("estimator の差し替え・停止", () => {
    test("差し替え後 TWCC が新 estimator に渡り帯域が更新される", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(300_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      const fired: number[] = [];
      sender.onAvailableBitrate.subscribe((v) => fired.push(v));
      // Arrange: 複数 sendRtp（probe padding 含む）
      for (let i = 0; i < 15; i++) {
        await sender.sendRtp(createRtpPacket(i, i * 3000, Buffer.alloc(500)));
      }

      // Act: 直近 40 パケット分を受信済みとして handleRtcpPacket 経路で返す
      sender.handleRtcpPacket(
        makeTwccRtcp(
          receivedTail(dtls.transportSequenceNumber, 40, Date.now() - 1000, 15),
        ),
      );

      // Assert: 新 estimator が更新され、sender の通知は最新値と一致する
      expect(sender.senderBWE).toBe(gcc);
      expect(gcc.availableBitrate).toBeGreaterThan(0);
      expect(fired.length).toBeGreaterThanOrEqual(1);
      expect(fired.at(-1)).toBe(gcc.availableBitrate);
    });

    test.each([
      {
        action: "stop",
        act: (sender: RTCRtpSender) => sender.stop(),
      },
      {
        action: "legacy への差し替え",
        act: (sender: RTCRtpSender) =>
          sender.setBandwidthEstimator(new SenderBandwidthEstimator()),
      },
    ])(
      "GCC は ProcessInterval ごとに process され、$action で旧 GCC の timer が止まる",
      ({ act }) => {
        // Arrange: production wiring（runRtcp の 500–1500ms ではなく processIntervalMs 周期）
        vi.useFakeTimers();
        const gcc = new GccBandwidthEstimator(300_000);
        const spy = vi.spyOn(gcc, "process");
        const sender = new RTCRtpSender("video");
        try {
          sender.setBandwidthEstimator(gcc);
          expect(spy).not.toHaveBeenCalled();

          // Act: 2 周期進める
          vi.advanceTimersByTime(gcc.processIntervalMs * 2);

          // Assert: 周期ごとに process される
          expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);

          // Act: stop / 差し替えのあとさらに進める
          act(sender);
          const n = spy.mock.calls.length;
          vi.advanceTimersByTime(gcc.processIntervalMs * 4);

          // Assert: 旧 GCC へはもう process せず、周期 timer も残らない
          expect(spy.mock.calls.length).toBe(n);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          sender.stop();
          vi.useRealTimers();
        }
      },
    );

    test.each([
      { kind: "legacy", create: () => new SenderBandwidthEstimator() },
      { kind: "gcc", create: () => new GccBandwidthEstimator(300_000) },
    ])(
      "別の DTLS transport に移ると、新 transport の TSN で送った packet が TWCC に照合される ($kind)",
      async ({ create }) => {
        // Arrange: 旧 transport で TSN 50001 まで送った sender
        const estimator = create();
        const { dtls: oldDtls } = connectedDtlsTransport(50_000);
        const sender = attachSender(oldDtls, estimator);
        await sender.sendRtp(createRtpPacket(0, 0, Buffer.alloc(500)));
        expect(oldDtls.transportSequenceNumberExtended).toBeGreaterThan(50_000);
        const matched = captureMatchedFeedback(estimator);

        // Act: TSN 1 から始まる新 transport に移り、20 packet 送って TWCC を受け取る
        const { dtls: newDtls } = connectedDtlsTransport(0);
        sender.setDtlsTransport(newDtls);
        for (let i = 1; i <= 20; i++) {
          await sender.sendRtp(createRtpPacket(i, i * 3000, Buffer.alloc(500)));
        }
        const lastTsn = newDtls.transportSequenceNumberExtended;
        sender.handleRtcpPacket(
          makeTwccRtcp(receivedTail(lastTsn, 20, Date.now(), 15)),
        );

        // Assert: 新 transport の直近 20 TSN がすべて受信として照合される
        const received = matched
          .flat()
          .filter((p) => p.received)
          .map((p) => p.extSeq);
        expect(received).toEqual(
          Array.from({ length: 20 }, (_, i) => lastTsn - 19 + i),
        );
      },
    );

    test("別の DTLS transport に移っても、アプリ指定の min/max は保たれ probe は max を超えない", async () => {
      // Arrange: 旧 transport の GCC sender に min 50k / start 100k / max 150k を指定する
      const gcc = new GccBandwidthEstimator(300_000);
      const { dtls: oldDtls } = connectedDtlsTransport(50_000);
      const sender = attachSender(oldDtls, gcc);
      gcc.setBitrates(50_000, 100_000, 150_000);
      const probeTargets: number[] = [];
      gcc.onProbeClusterConfig.subscribe((cfg) =>
        probeTargets.push(cfg.targetBps),
      );

      // Act: 新 transport に移り、probe を開始させる
      sender.setDtlsTransport(connectedDtlsTransport(0).dtls);
      startGccProbing(gcc);

      // Assert: 経路の初期化後も probe は要求され、その目標は max 150 kbps 以下
      expect(probeTargets.length).toBeGreaterThan(0);
      expect(Math.max(...probeTargets)).toBeLessThanOrEqual(150_000);
      sender.stop();
    });

    test("使用済み estimator の再注入で reset され履歴が残らない", async () => {
      // Arrange: 一度 TWCC を処理して availableBitrate を立てる
      // （送信 sender の process は壁時計で呼ぶので、送信時刻も壁時計にする）
      const gcc = new GccBandwidthEstimator(300_000);
      const t0 = Date.now();
      for (let i = 0; i < 20; i++) {
        gcc.rtpPacketSent(sent(i + 1, 800, t0 + i * 20));
      }
      gcc.receiveTWCC(makeTwccFeedback(receivedTail(20, 20, t0 + 30, 20)));
      expect(gcc.availableBitrate).toBeGreaterThan(0);

      // Act: 別 sender に同じインスタンスを注入 → setBandwidthEstimator が reset
      const { sender } = await prepareConnectedSender();
      sender.setBandwidthEstimator(gcc);

      // Assert: 履歴クリア（availableBitrate は 0 に戻る）、再観測なしでは通知しない
      expect(gcc.availableBitrate).toBe(0);
      const fired: number[] = [];
      sender.onAvailableBitrate.subscribe((v) => fired.push(v));
      expect(fired).toEqual([]);
    });

    test("送信中の estimator 差し替えで in-flight が新 estimator を汚染しない", async () => {
      // Arrange: 旧 GCC で send を開始し、DTLS で止まっている間に差し替える
      const oldGcc = new GccBandwidthEstimator(300_000);
      const newGcc = new GccBandwidthEstimator(100_000);
      const { sender, dtls } = await prepareConnectedSender(oldGcc);
      const { release } = holdFirstWrite(dtls);
      const oldSpy = vi.spyOn(oldGcc, "rtpPacketSent");
      const newSpy = vi.spyOn(newGcc, "rtpPacketSent");
      const sendPromise = sender.sendRtp(
        createRtpPacket(1, 1000, Buffer.alloc(200)),
      );
      await flushMicrotasks();

      // Act: in-flight のまま差し替えてから完了させる
      sender.setBandwidthEstimator(newGcc);
      expect(sender.senderBWE).toBe(newGcc);
      release();
      await sendPromise;

      // Assert: 差し替え後に完了したパケットは新旧どちらにも渡らない（世代不一致で discard）
      expect(newSpy).not.toHaveBeenCalled();
      expect(oldSpy).not.toHaveBeenCalled();
      expect(newGcc.availableBitrate).toBe(0);
      expect(twccHistoryOf(newGcc).size).toBe(0);

      // Act: 差し替え後の新規送信
      await sender.sendRtp(createRtpPacket(2, 2000, Buffer.alloc(200)));

      // Assert: 新 estimator だけに届き、旧世代の in-flight バイトを priorUnackedBytes に混ぜない
      expect(newSpy).toHaveBeenCalled();
      expect(newSpy.mock.calls[0][0].priorUnackedBytes).toBe(0);
      expect(oldSpy).not.toHaveBeenCalled();
    });

    test.each([
      {
        action: "legacy への差し替え",
        act: (sender: RTCRtpSender) =>
          sender.setBandwidthEstimator(new SenderBandwidthEstimator()),
      },
      { action: "stop", act: (sender: RTCRtpSender) => sender.stop() },
    ])(
      "in-flight probe padding 中の $action で、dispose 済み GCC を再駆動しない",
      async ({ act }) => {
        // Arrange: GCC probe padding を非同期開始し、最初の DTLS write で止める
        const gcc = new GccBandwidthEstimator(1_000_000);
        const { sender, dtls } = await prepareConnectedSender(gcc);
        startGccProbing(gcc);
        const { release } = holdFirstWrite(dtls);
        const pendingSpy = vi.spyOn(gcc, "pendingProbePaddingPackets");
        const padPromise = sender.maybeInjectProbePadding();
        await flushMicrotasks();

        // Act: in-flight のまま差し替え / stop（generation bump で padding ループは cancel）
        act(sender);
        release();
        const n = await padPromise;

        // Assert: その後 pendingProbePaddingPackets で probe を再生成しない
        const callsAtEnd = pendingSpy.mock.calls.length;
        await flushMicrotasks();
        expect(pendingSpy.mock.calls.length).toBe(callsAtEnd);
        // Assert: 最初の 1 パケットは wire に出うるが、大量完遂にはならず、履歴も解放される
        expect(n).toBeLessThan(16);
        expect(gcc.pendingProbePaddingPackets()).toBe(0);
        expect(twccHistoryOf(gcc).size).toBe(0);
      },
    );

    test("差し替え中に発火した新 GCC probe は旧 padding in-flight を跨いで送信される", async () => {
      // Arrange: 旧 GCC の padding 送信を DTLS で止め、その間に新 GCC へ差し替える
      const oldGcc = new GccBandwidthEstimator(1_000_000);
      const { sender, dtls } = await prepareConnectedSender(oldGcc);
      startGccProbing(oldGcc);
      const { release } = holdFirstWrite(dtls);
      const oldPadPromise = sender.maybeInjectProbePadding();
      await flushMicrotasks();
      const newGcc = new GccBandwidthEstimator(1_000_000);
      const newSent = vi.spyOn(newGcc, "rtpPacketSent");
      sender.setBandwidthEstimator(newGcc);

      // Act: 切替後に新 estimator の probe cluster を発火させる
      startGccProbing(newGcc);
      release();
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

    test("RTCRtpSender.stop は世代無効化・padding 停止・estimator dispose する", async () => {
      // Arrange: GCC + 送信履歴 + probe mapping
      const gcc = new GccBandwidthEstimator(300_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      startGccProbing(gcc);
      // 送信時刻は GCC の clock（壁時計）と同じ domain にする
      const t0 = Date.now();
      gcc.rtpPacketSent(sent(1, 200, t0, { isProbation: true }));
      gcc.rtpPacketSent(sent(2, 200, t0 + 10, { isProbation: true }));
      expect(twccHistoryOf(gcc).size).toBeGreaterThan(0);
      await flushMicrotasks();
      const writes = dtls.sendRtp as ReturnType<typeof vi.fn>;
      const sendsBeforeStop = writes.mock.calls.length;

      // Act
      sender.stop();

      // Assert: 履歴は dispose で解放される
      expect(twccHistoryOf(gcc).size).toBe(0);
      expect((gcc as any).probe.seqToCluster.size).toBe(0);
      expect((gcc as any).probe.seqToSendInfo.size).toBe(0);
      expect((gcc as any).lossBwe.partial.numPackets).toBe(0);
      expect((gcc as any).lossBwe.partial.lostPackets.size).toBe(0);
      expect((gcc as any).disposed).toBe(true);

      // Act: stop 後の padding / send
      const n = await sender.maybeInjectProbePadding();
      await sender.sendRtp(createRtpPacket(9, 9, Buffer.alloc(100)));

      // Assert: stop 後に追加の RTP / padding は出ない
      expect(n).toBe(0);
      expect(writes.mock.calls.length).toBe(sendsBeforeStop);
      expect(gcc.pendingProbePaddingPackets()).toBe(0);
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

/** Arrange: the last `count` TSNs up to `lastSeq`, all received `stepMs` apart. */
function receivedTail(
  lastSeq: number,
  count: number,
  baseMs: number,
  stepMs: number,
): PacketResult[] {
  const n = Math.min(count, lastSeq);
  return Array.from(
    { length: n },
    (_, i) =>
      new PacketResult({
        sequenceNumber: (lastSeq - n + 1 + i) & 0xffff,
        received: true,
        receivedAtMs: baseMs + i * stepMs,
      }),
  );
}

/** Assert: RFC 3550 padding-only probe packet that reparses from the wire. */
function expectProbePaddingPacket(p: CapturedRtp) {
  expect(p.header.padding).toBe(true);
  expect(p.header.paddingSize).toBe(kProbePaddingPacketBytes);
  // 実 payload は padding だけ（ゼロ埋め + 末尾 length）
  expect(p.payload.length).toBe(kProbePaddingPacketBytes);
  expect(p.payload[p.payload.length - 1]).toBe(kProbePaddingPacketBytes);
  expect(p.payload.subarray(0, -1).every((b) => b === 0)).toBe(true);
  // フル RTP を再パース可能
  const parsed = RtpPacket.deSerialize(
    new RtpPacket(p.header, p.payload).serialize(),
  );
  expect(parsed.header.padding).toBe(true);
  expect(parsed.header.paddingSize).toBe(kProbePaddingPacketBytes);
}

/** Wire 16-bit TSN of a captured packet (extension id 3), or -1. */
function wireTsnOf(p: CapturedRtp): number {
  const twcc = p.header.extensions.find((ext) => ext.id === 3);
  return twcc ? twcc.payload.readUInt16BE(0) : -1;
}

function opusCodec() {
  return new RTCRtpCodecParameters({
    mimeType: "audio/opus",
    clockRate: 48000,
    payloadType: 111,
  });
}
