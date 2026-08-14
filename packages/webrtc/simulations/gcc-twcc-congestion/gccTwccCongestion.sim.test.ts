/**
 * GCC + TWCC 輻輳シミュレーション（CI 対象外）。
 *
 * 2 つの werift Peer を仮想ボトルネック経由で接続し、
 * 上限帯域を超える送信で遅延・ロスが発生したとき GCC が送信推奨帯域を下げ、
 * アプリがその帯域に追従すると輻輳（ドロップ）が緩和されることを検証する。
 */
import { describe, expect, test } from "vitest";
import {
  kRttBasedBackOffDropFraction,
  kRttBasedBackOffHighRttMs,
} from "../../src";
import {
  createGccTwccPeerPair,
  sleep,
  startMediaSource,
} from "../helpers/peerHarness";

describe("simulations/gcc-twcc-congestion", () => {
  test("上限帯域超過で GCC が帯域を下げ、追従後にドロップが減る", async () => {
    // Arrange: 容量 200kbps のボトルネック + 開始推定 700kbps
    const capacityBps = 200_000;
    const pair = await createGccTwccPeerPair({
      capacityBps,
      baseDelayMs: 50,
      maxQueueBytes: 24_000,
      startBitrateBps: 700_000,
    });

    let targetBps = 700_000;
    const media = startMediaSource(pair.track, () => targetBps, {
      payloadBytes: 800,
    });

    try {
      // Act 1: 容量を大幅に超える固定レートで送信し輻輳を誘発
      await sleep(4_000);
      const congestedStats = pair.link.stats("a2b");
      const bitrateAfterCongestion = pair.bitrateSamples.slice();
      const lastEstimateAfterCongestion =
        bitrateAfterCongestion[bitrateAfterCongestion.length - 1] ??
        pair.gcc.availableBitrate;

      // Assert 1: ドロップが発生し、推定帯域が容量近傍以下へ下がる
      // 日本語: ボトルネック超過により a→b 方向でロスが発生していること
      expect(congestedStats.dropped).toBeGreaterThan(0);
      // 日本語: TWCC 経由で onAvailableBitrate が少なくとも 1 回は発火していること
      expect(bitrateAfterCongestion.length).toBeGreaterThan(0);
      // 日本語: 推定が初期 700kbps より明確に下がっていること（容量の 2 倍未満）
      expect(lastEstimateAfterCongestion).toBeLessThan(capacityBps * 2);
      expect(lastEstimateAfterCongestion).toBeLessThan(550_000);

      // Act 2: 推定帯域に追従して送信レートを下げる（輻輳解消フェーズ）
      const dropsAtCongestion = congestedStats.dropped;
      targetBps = Math.max(
        40_000,
        Math.min(lastEstimateAfterCongestion, capacityBps),
      );
      // 推定更新に追従
      const unsub = pair.sender.onAvailableBitrate.subscribe((bps) => {
        if (bps > 0) {
          targetBps = Math.max(40_000, Math.min(bps, capacityBps * 1.05));
        }
      });

      await sleep(4_000);
      unsub.unSubscribe();

      const afterAdapt = pair.link.stats("a2b");
      const dropsDuringAdapt = afterAdapt.dropped - dropsAtCongestion;
      const finalEstimate =
        pair.bitrateSamples[pair.bitrateSamples.length - 1] ??
        pair.gcc.availableBitrate;

      // Assert 2: 追従後は追加ドロップが抑えられ、推定が容量オーダーに収まる
      // 日本語: 適応後の新規ドロップは輻輳期より少ない（完全ゼロでなくてよい）
      expect(dropsDuringAdapt).toBeLessThan(congestedStats.dropped);
      // 日本語: 最終推定が極端な高値（開始 700kbps 帯）に戻っていない
      expect(finalEstimate).toBeLessThan(500_000);
      // 日本語: ゼロ張り付きではない（有効な推定が継続）
      expect(finalEstimate).toBeGreaterThan(20_000);
      // 日本語: 5kbps floor に張り付いていない
      expect(finalEstimate).toBeGreaterThan(5_000 * 3);

      // 診断用（失敗時の差分確認）
      // eslint-disable-next-line no-console
      console.log({
        capacityBps,
        congested: {
          dropped: congestedStats.dropped,
          lastEstimate: lastEstimateAfterCongestion,
          samples: bitrateAfterCongestion.length,
        },
        adapted: {
          dropsDuringAdapt,
          finalEstimate,
          queueBytes: pair.link.queueBytes("a2b"),
          totalSamples: pair.bitrateSamples.length,
        },
      });
    } finally {
      media.stop();
      await pair.close();
    }
  }, 30_000);

  test("低レート送信ではボトルネック容量内でドロップがほぼ起きない", async () => {
    // Arrange: 容量に対して十分低い送信
    const capacityBps = 500_000;
    const pair = await createGccTwccPeerPair({
      capacityBps,
      baseDelayMs: 20,
      maxQueueBytes: 80_000,
      startBitrateBps: 150_000,
    });
    const media = startMediaSource(pair.track, () => 120_000, {
      payloadBytes: 600,
    });

    try {
      // Act
      await sleep(3_000);
      const stats = pair.link.stats("a2b");

      // Assert: 容量内なのでロスはごく僅か（0 またはごく少数）
      // 日本語: 低レートではほぼロスしない
      expect(stats.dropped).toBeLessThan(5);
      // 日本語: 転送は進んでいる
      expect(stats.forwarded).toBeGreaterThan(20);
    } finally {
      media.stop();
      await pair.close();
    }
  }, 20_000);

  test("TWCC feedback stall では推定が安全側へ下がる", async () => {
    // Arrange: 容量内で一度推定を立ててから b→a（TWCC）を全ドロップ
    const pair = await createGccTwccPeerPair({
      capacityBps: 400_000,
      baseDelayMs: 20,
      maxQueueBytes: 80_000,
      startBitrateBps: 300_000,
    });
    const media = startMediaSource(pair.track, () => 200_000, {
      payloadBytes: 600,
    });

    try {
      // Act: まず TWCC が回り availableBitrate が立つ
      await sleep(2_000);
      const beforeStall =
        pair.bitrateSamples[pair.bitrateSamples.length - 1] ??
        pair.gcc.availableBitrate;
      expect(beforeStall).toBeGreaterThan(20_000);

      // Act: feedback を止め、1s ごとに推定 / CorrectedRtt / backoff を記録
      pair.link.setDropAll("b2a", true);
      const stallLog: Array<{
        t: number;
        bps: number;
        correctedRttMs: number;
        above: boolean;
      }> = [];
      const stallT0 = Date.now();
      for (let i = 0; i < 5; i++) {
        await sleep(1_000);
        stallLog.push({
          t: Date.now() - stallT0,
          bps: pair.gcc.availableBitrate,
          correctedRttMs: pair.gcc.correctedRttMs,
          above: pair.gcc.rttAboveLimit,
        });
      }
      const afterStall =
        pair.bitrateSamples[pair.bitrateSamples.length - 1] ??
        pair.gcc.availableBitrate;

      // Assert: CorrectedRtt は送信継続で伸び、3s 超で limit を超える
      // 日本語: 2s 時点ではまだ 3s limit 未満
      expect(stallLog[1].above).toBe(false);
      expect(stallLog[1].correctedRttMs).toBeLessThan(
        kRttBasedBackOffHighRttMs,
      );
      // 日本語: 3s 時点で CorrectedRtt > 3s
      expect(stallLog[2].above).toBe(true);
      expect(stallLog[2].correctedRttMs).toBeGreaterThan(
        kRttBasedBackOffHighRttMs,
      );

      // Assert: pin drop_fraction=0.8 を 1s ごとに適用
      const drops: number[] = [];
      let prev = beforeStall;
      for (const row of stallLog) {
        if (row.bps < prev * 0.95) {
          const ratio = row.bps / prev;
          expect(ratio).toBeGreaterThan(kRttBasedBackOffDropFraction - 0.03);
          expect(ratio).toBeLessThan(kRttBasedBackOffDropFraction + 0.03);
          drops.push(row.bps);
          prev = row.bps;
        }
      }
      // 日本語: 5s stall で 3s 超過後に少なくとも 2 回は ×0.8
      expect(drops.length).toBeGreaterThanOrEqual(2);
      // 日本語: 最終推定は stall 前 × 0.8^dropCount 近傍
      const expected =
        beforeStall * kRttBasedBackOffDropFraction ** drops.length;
      expect(afterStall / expected).toBeGreaterThan(0.95);
      expect(afterStall / expected).toBeLessThan(1.05);
      expect(afterStall).toBeLessThan(beforeStall);
    } finally {
      media.stop();
      await pair.close();
    }
  }, 20_000);

  test("容量が回復すると推定は floor に張り付かず上向きに動く", async () => {
    // Arrange: 狭いボトルネックで下げたあと容量を広げる
    const pair = await createGccTwccPeerPair({
      capacityBps: 150_000,
      baseDelayMs: 40,
      maxQueueBytes: 20_000,
      startBitrateBps: 600_000,
      periodicAlrProbing: true,
    });
    let targetBps = 600_000;
    const media = startMediaSource(pair.track, () => targetBps, {
      payloadBytes: 700,
    });
    const unsub = pair.sender.onAvailableBitrate.subscribe((bps) => {
      if (bps > 0) targetBps = Math.max(40_000, bps);
    });

    try {
      await sleep(4_000);
      const congested =
        pair.bitrateSamples[pair.bitrateSamples.length - 1] ??
        pair.gcc.availableBitrate;
      expect(congested).toBeLessThan(400_000);
      expect(congested).toBeGreaterThan(15_000);

      // Act: 容量を回復し、推定に追従
      pair.link.setCapacityBps(700_000);
      await sleep(6_000);
      const recovered =
        pair.bitrateSamples[pair.bitrateSamples.length - 1] ??
        pair.gcc.availableBitrate;

      // Assert: floor 張り付きではなく、輻輳期より回復方向
      // 日本語: 5kbps 下限に張り付いていない
      expect(recovered).toBeGreaterThan(15_000);
      // 日本語: 回復後は輻輳期推定の 80% 以上、または少なくとも下がっていない
      expect(recovered).toBeGreaterThanOrEqual(congested * 0.8);
    } finally {
      unsub.unSubscribe();
      media.stop();
      await pair.close();
    }
  }, 25_000);
});
