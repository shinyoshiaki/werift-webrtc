/**
 * GCC + TWCC 輻輳シミュレーション（CI 対象外）。
 *
 * 2 つの werift Peer を仮想ボトルネック経由で接続し、
 * 上限帯域を超える送信で遅延・ロスが発生したとき GCC が送信推奨帯域を下げ、
 * アプリがその帯域に追従すると輻輳（ドロップ）が緩和されることを検証する。
 * feedback 途絶・容量回復への応答は、決定的な制御応答テスト
 * （`tests/media/bandwidthEstimator.test.ts` の「GCC 制御応答（仕様ベース）」）で確かめる。
 */
import { describe, expect, test } from "vitest";
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
      maxQueueBytes: 12_000,
      startBitrateBps: 700_000,
    });

    // 輻輳期: メディア token-bucket を外し、生成 700kbps をボトルネックへ出す。
    // probe の next_probe_time は常に有効（BitrateProber を壊さない）。
    pair.sender.mediaPacingEnabled = false;
    let targetBps = 700_000;
    const media = startMediaSource(pair.track, () => targetBps, {
      payloadBytes: 800,
    });

    try {
      // Act 1: 容量を大幅に超える固定レートで送信し輻輳を誘発
      await sleep(5_000);
      const congestedStats = pair.link.stats("a2b");
      const bitrateAfterCongestion = pair.bitrateSamples.slice();
      const lastEstimateAfterCongestion =
        bitrateAfterCongestion[bitrateAfterCongestion.length - 1] ??
        pair.gcc.availableBitrate;

      // Assert 1: ドロップが発生し、推定帯域が容量近傍以下へ下がる
      // 日本語: ボトルネック超過により a→b 方向でロスが発生していること
      expect(congestedStats.dropped).toBeGreaterThan(5);
      // 日本語: TWCC 経由で onAvailableBitrate が少なくとも 1 回は発火していること
      expect(bitrateAfterCongestion.length).toBeGreaterThan(0);
      // 日本語: 推定が初期 700kbps より明確に下がっていること
      expect(lastEstimateAfterCongestion).toBeLessThan(550_000);
      expect(lastEstimateAfterCongestion).toBeLessThan(700_000 * 0.85);

      // Act 2: 低レートでキューを空け、追従期は本番 pacer を戻す
      targetBps = 40_000;
      await sleep(800);
      pair.link.resetStats("a2b");
      pair.sender.mediaPacingEnabled = true;
      targetBps = Math.max(
        40_000,
        Math.min(lastEstimateAfterCongestion, Math.floor(capacityBps * 0.75)),
      );
      const unsub = pair.sender.onAvailableBitrate.subscribe((bps) => {
        if (bps > 0) {
          targetBps = Math.max(
            40_000,
            Math.min(bps, Math.floor(capacityBps * 0.75)),
          );
        }
      });

      await sleep(4_000);
      unsub.unSubscribe();

      const afterAdapt = pair.link.stats("a2b");
      const dropsDuringAdapt = afterAdapt.dropped;
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
  }, 35_000);

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
      // 日本語: 初期 probe の padding は RTX SSRC にだけ出て、media SSRC には出ない
      expect(pair.wire.rtxPadding).toBeGreaterThan(0);
      expect(pair.wire.mediaPadding).toBe(0);
    } finally {
      media.stop();
      await pair.close();
    }
  }, 20_000);
});
