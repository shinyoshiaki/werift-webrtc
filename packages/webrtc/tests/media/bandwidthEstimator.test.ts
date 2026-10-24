import { describe, expect, test, vi } from "vitest";
import type { Config } from "../../../rtp/src/srtp/session";
import { SrtpSession } from "../../../rtp/src/srtp/srtp";
import {
  type BandwidthEstimator,
  DisabledBandwidthEstimator,
  GccBandwidthEstimator,
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
  TwccReferenceTimeUnwrapper,
  appendRfc3550Padding,
  hasTwccReceiveTiming,
  isBandwidthEstimatorProcessor,
  isNetworkAvailabilityConsumer,
  isProbePacingController,
  isRoundTripTimeConsumer,
  isSenderBandwidthEstimator,
  kGoogCcProcessIntervalMs,
  kProbePaddingPacketBytes,
  kSendTimeHistoryWindowMs,
  sortPacketResultsByWideSeq,
} from "../../src";
import { RTP_EXTENSION_URI } from "../../src/imports/rtp";
import { createDtlsTransport } from "../fixture";
import {
  type GccLink,
  type GccPhase,
  bitrateAt,
  runGccSimulation,
} from "./gccSimulation";
import { seededRandom, twccHistoryOf } from "./twccTestUtils";

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

/** pin OnNetworkAvailability(true) then first ProcessInterval SetBitrates. */
function startGccProbing(gcc: GccBandwidthEstimator, nowMs?: number) {
  gcc.setNetworkAvailable(true);
  // 合成 clock の GCC では Date.now() を使わない（ALR origin が壁時計になる）。
  gcc.process(nowMs ?? (gcc as unknown as { clock: () => number }).clock());
}

/**
 * 3x/6x を開始するが、RTCRtpSender の onProbeClusterConfig 自動 padding は抑止する。
 * sendRtp 後の注入や maybeInjectProbePadding 自体を検証するテスト用。
 */
function startGccProbingWithoutSenderPadding(
  sender: RTCRtpSender,
  gcc: GccBandwidthEstimator,
  nowMs?: number,
) {
  const spy = vi.spyOn(sender, "maybeInjectProbePadding").mockResolvedValue(0);
  try {
    startGccProbing(gcc, nowMs);
  } finally {
    spy.mockRestore();
  }
}

/**
 * Connected video sender with VP8 + TWCC. RTX (PT 97) is negotiated by
 * default because probe / loss padding is only sent on the RTX SSRC.
 */
async function prepareConnectedSender(
  estimator?: BandwidthEstimator,
  { rtx = true }: { rtx?: boolean } = {},
) {
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
  dtls.transportSequenceNumberExtended = 0;
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
      ...(rtx
        ? [
            new RTCRtpCodecParameters({
              mimeType: "video/rtx",
              clockRate: 90000,
              payloadType: 97,
              parameters: "apt=96",
            }),
          ]
        : []),
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

    test("legacy sentInfos は 2048 件ではなく時間窓で prune する", () => {
      // Arrange
      const legacy = new SenderBandwidthEstimator();
      for (let i = 1; i <= 3_000; i++) {
        legacy.rtpPacketSent({
          wideSeq: i & 0xffff,
          size: 100,
          sendingAtMs: 1_000 + i,
          sentAtMs: 1_000 + i,
        });
      }

      // Assert: 1s 以内なら 2048 を超えて残る
      expect(twccHistoryOf(legacy).size).toBeGreaterThan(2048);

      // Act: 10s 超の古い packet
      legacy.rtpPacketSent({
        wideSeq: 10,
        size: 100,
        sendingAtMs: 1_000 + 3_000 + 10_001,
        sentAtMs: 1_000 + 3_000 + 10_001,
      });

      // Assert: 時間窓外は消える
      const remaining = [...twccHistoryOf(legacy).values()];
      expect(remaining.every((s) => s.sendingAtMs >= 1_000 + 3_000 + 1)).toBe(
        true,
      );
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

    test("process() は送信停止後も 60s 超の sentInfos を prune する", () => {
      // Arrange: 1 パケット送信後、rtpPacketSent は呼ばない
      const t0 = 80_000;
      const gcc = new GccBandwidthEstimator(300_000);
      gcc.rtpPacketSent(sent(1, 400, t0));
      gcc.rtpPacketSent(sent(2, 400, t0 + 10));
      expect(twccHistoryOf(gcc).has(1)).toBe(true);
      expect(twccHistoryOf(gcc).size).toBe(2);

      // Act: 送信停止後の periodic process（窓内）
      gcc.process(t0 + 30_000);

      // Assert: 60s 未満は late TWCC 用に残る
      expect(twccHistoryOf(gcc).has(1)).toBe(true);
      expect(twccHistoryOf(gcc).has(2)).toBe(true);

      // Act: packet 1 だけ 60s 超（packet 2 はまだ窓内）
      gcc.process(t0 + kSendTimeHistoryWindowMs + 1);

      // Assert: 期限切れだけ消え、新しい方は残る
      expect(twccHistoryOf(gcc).has(1)).toBe(false);
      expect(twccHistoryOf(gcc).has(2)).toBe(true);

      // Act: packet 2 も 60s 超
      gcc.process(t0 + 10 + kSendTimeHistoryWindowMs + 1);

      // Assert: process 経路だけで履歴が空になる（rtpPacketSent 依存ではない）
      expect(twccHistoryOf(gcc).size).toBe(0);
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

  describe("GCC 不変条件（性質テスト）", () => {
    // ランダムな経路・送信レート・ロス・feedback 途絶を混ぜても常に成り立つ性質。
    test.each(Array.from({ length: 24 }, (_, i) => i + 1))(
      "seed %i: 通知は有限・[min, max] 内・値が変わったときだけ",
      (seed) => {
        // Arrange: seed から制約と 3 フェーズの経路を作る
        const rand = seededRandom(seed);
        const pick = (a: number, b: number) => a + rand() * (b - a);
        const minBps = Math.round(pick(30_000, 200_000));
        const maxBps = Math.round(pick(600_000, 4_000_000));
        const startBps = Math.round(pick(minBps, maxBps));
        const phases: GccPhase[] = Array.from({ length: 3 }, () => ({
          durationMs: Math.round(pick(1_000, 4_000)),
          link: {
            capacityBps: pick(100_000, 5_000_000),
            baseDelayMs: pick(5, 200),
            queueLimitBytes: pick(5_000, 100_000),
            lossRate: rand() < 0.3 ? pick(0, 0.3) : 0,
          },
          source: rand() < 0.5 ? "follow" : pick(50_000, 6_000_000),
          feedback: rand() > 0.15,
        }));

        // Act
        const result = runGccSimulation({
          startBps,
          minBps,
          maxBps,
          phases,
          seed,
        });

        // Assert: 通知値は有限で、アプリが設定した範囲から出ない
        const values = result.events.map((e) => e.bps);
        expect(values.length).toBeGreaterThan(0);
        for (const bps of values) {
          expect(Number.isFinite(bps)).toBe(true);
          expect(bps).toBeGreaterThanOrEqual(minBps);
          expect(bps).toBeLessThanOrEqual(maxBps);
        }
        // Assert: 同じ値を続けて通知しない（変化時のみ）
        for (let i = 1; i < values.length; i++) {
          expect(values[i]).not.toBe(values[i - 1]);
        }
        // Assert: 公開値は最後の通知値と一致する
        expect(result.estimator.availableBitrate).toBe(values.at(-1));
      },
    );
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

    test("並行 sendRtp は FIFO 直列化され SentInfo.wideSeq が重複しない", async () => {
      // Arrange: 遅延する transport で 2 件を並行送信
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      // setBandwidthEstimator の reset 後に complete へ。初期 probe の
      // onProbeClusterConfig が media と DTLS を重ねないようにする。
      (gcc as any).probe.abort(0);
      (gcc as any).probe.state = "complete";
      (gcc as any).probingConfigured = true;
      let inFlight = 0;
      let maxInFlight = 0;
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
        inFlight--;
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

      // Act
      const p1 = sender.sendRtp(mk(1));
      const p2 = sender.sendRtp(mk(2));
      await Promise.all([p1, p2]);

      // Assert: DTLS write は同時に 1 本。TWCC seq は 1,2
      expect(maxInFlight).toBe(1);
      expect(wideSeqs).toEqual([1, 2]);
    });

    test("probe 中の並行 sendRtp でも DTLS write は同時に 1 本", async () => {
      // Arrange: 初期 probe を残したまま 2 media を並行投入
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      startGccProbing(gcc);
      // media の probe tag / cluster event は残し、padding 連打で
      // テストが 15ms×N に膨らむのを避ける
      vi.spyOn(gcc, "pendingProbePaddingPackets").mockReturnValue(0);

      let inFlight = 0;
      let maxInFlight = 0;
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
        inFlight--;
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
      await Promise.all([sender.sendRtp(mk(1)), sender.sendRtp(mk(2))]);

      // Assert: probe padding が挟まっても DTLS は直列
      expect(maxInFlight).toBe(1);
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
      const pads = sentPackets.filter((p) => p.header.padding);
      expect(pads.length).toBe(5);
      // padding は RTX SSRC の連番（media の穴 11 を使わない）
      expect(pads.every((p) => p.header.ssrc === sender.rtxSsrc)).toBe(true);
      const padSeqs = pads.map((p) => p.header.sequenceNumber);
      for (let i = 1; i < padSeqs.length; i++) {
        expect(padSeqs[i]).toBe((padSeqs[i - 1] + 1) & 0xffff);
      }

      await sendMedia(11);

      // Assert: media は source 相対のまま 10, 12, 11
      expect(
        sentPackets
          .filter((p) => p.header.ssrc === sender.ssrc)
          .map((p) => p.header.sequenceNumber),
      ).toEqual([10, 12, 11]);

      // rtpCache は media のみ。padding seq では上書きしない
      const cache = (sender as any).rtpCache as Array<
        { header: { sequenceNumber: number } } | undefined
      >;
      const history = 128;
      const mediaSeqs = sentPackets
        .filter((p) => !p.header.padding)
        .map((p) => p.header.sequenceNumber);
      for (const seq of mediaSeqs) {
        const slot = cache[seq % history];
        expect(slot).toBeDefined();
        expect(slot!.header.sequenceNumber).toBe(seq);
      }
      for (const seq of padSeqs) {
        const slot = cache[seq % history];
        expect(slot?.header.sequenceNumber).not.toBe(seq);
      }

      expect(mediaSeqs).toEqual([10, 12, 11]);
    });

    test("padding 挿入後の遅着 media が既送信 media の連番を再利用しない", async () => {
      // Arrange: レビュー再現。10 → padding → 11 → 遅着 9 で旧実装は
      // offset 再計算後に late 9 が wire 10 を再利用し rtpCache を上書きした。
      const { sender, sentPackets } = await prepareConnectedSender();

      const sendMedia = async (
        seq: number,
        payload = Buffer.alloc(40, seq),
      ) => {
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
            payload,
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

      // Act: media 10 → padding → media 11 → 遅着 media 9
      await sendMedia(10, Buffer.from([10]));
      await sendPad();
      await sendMedia(11, Buffer.from([11]));
      await sendMedia(9, Buffer.from([9]));

      // Assert: padding は RTX SSRC なので media は source 相対のまま。
      //         遅着 9 も既送信の 10 / 11 を再利用しない
      const media = sentPackets.filter((p) => p.header.ssrc === sender.ssrc);
      expect(media.map((p) => p.header.sequenceNumber)).toEqual([10, 11, 9]);
      expect(
        sentPackets.filter((p) => p.header.ssrc === sender.rtxSsrc),
      ).toHaveLength(1);
      expect(media[0]!.payload[0]).toBe(10);
      expect(media[2]!.payload[0]).toBe(9);

      const cache = (sender as any).rtpCache as Array<
        { header: { sequenceNumber: number }; payload: Buffer } | undefined
      >;
      const history = 128;
      const cached10 = cache[10 % history];
      expect(cached10?.header.sequenceNumber).toBe(10);
      expect(cached10?.payload[0]).toBe(10);
      const cached9 = cache[9 % history];
      expect(cached9?.header.sequenceNumber).toBe(9);
      expect(cached9?.payload[0]).toBe(9);
    });

    test("media → padding → media で sequence 衝突せず source 相対は維持", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, sentPackets } = await prepareConnectedSender(gcc);
      // Arrange: media 送信より先に cluster を埋めない
      startGccProbingWithoutSenderPadding(sender, gcc);
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
      // Assert: media 10 の後に padding が RTX SSRC で注入される
      expect(sentPackets.some((p) => p.header.padding)).toBe(true);

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
      // Assert: media は source 相対のまま（10 → 12 の gap も維持）
      const media = sentPackets.filter((p) => p.header.ssrc === sender.ssrc);
      expect(media.map((p) => p.header.sequenceNumber)).toEqual([10, 12]);
      // Assert: padding は全て RTX SSRC で、media SSRC には出ない
      expect(media.every((p) => !p.header.padding)).toBe(true);
      const pads = sentPackets.filter((p) => p.header.padding);
      expect(pads.every((p) => p.header.ssrc === sender.rtxSsrc)).toBe(true);
    });

    test("media → padding → media で RTP sequence が重複しない", async () => {
      // Arrange
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, sentPackets } = await prepareConnectedSender(gcc);
      startGccProbing(gcc);

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
