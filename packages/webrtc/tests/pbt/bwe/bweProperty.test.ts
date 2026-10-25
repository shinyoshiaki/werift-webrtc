import { describe, expect, test } from "vitest";
import { PacketResult, SenderBandwidthEstimator } from "../../../src";
import { runGccSimulation } from "../../media/gccSimulation";
import { syntheticTwccFeedback, twccSentInfo } from "../../media/twccTestUtils";
import { seededRandom } from "../shared/random";
import { propertySeeds } from "../shared/seeds";
import {
  randomBitrateUpdates,
  randomConstantRateStream,
  randomGccScenario,
} from "./generator";

/**
 * Bandwidth-estimator property test: claims that hold for the legacy and GCC
 * estimators on any input a seed draws (`bwe/generator.ts`). GCC runs in the
 * bottleneck simulation of `tests/media/gccSimulation.ts`.
 *
 * CI runs `WERIFT_BWE_SEEDS` (default 24) seeds per property from
 * `WERIFT_BWE_SEED` (default 1); `WERIFT_BWE_STEPS` (default 3) is the number
 * of phases of a GCC scenario. A failing title prints the replay environment.
 */
const { seeds, steps, replay } = propertySeeds("WERIFT_BWE", {
  seeds: 24,
  steps: 3,
});
const cases = seeds.map((seed) => ({ seed }));
const title = (claim: string) =>
  `${claim}: seed $seed (replay: ${replay("$seed")})`;

describe("bandwidth estimator property", () => {
  test.each(cases)(
    title(
      "gcc: 通知は有限・[min, max] 内・値が変わったときだけで、公開値は最後の通知値",
    ),
    ({ seed }) => {
      // Arrange: 制約と、経路・送信レート・ロス・feedback 途絶がランダムなフェーズ列
      const scenario = randomGccScenario(seededRandom(seed), steps, seed);

      // Act
      const result = runGccSimulation(scenario);

      // Assert: 通知値は有限で、アプリが設定した範囲から出ない
      const values = result.events.map((e) => e.bps);
      expect(values.length).toBeGreaterThan(0);
      for (const bps of values) {
        expect(Number.isFinite(bps)).toBe(true);
        expect(bps).toBeGreaterThanOrEqual(scenario.minBps!);
        expect(bps).toBeLessThanOrEqual(scenario.maxBps!);
      }
      // Assert: 同じ値を続けて通知せず、公開値は最後の通知値と一致する
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).not.toBe(values[i - 1]);
      }
      expect(result.estimator.availableBitrate).toBe(values.at(-1));
    },
  );

  test.each(cases)(
    title(
      "legacy: 推定値は受信できたパケットの min(送信レート, 受信レート) と一致する",
    ),
    ({ seed }) => {
      // Arrange: ランダムなサイズ・送信間隔・ボトルネック倍率の一定レート列
      const { packets, sizeBytes, intervalMs, stretch } =
        randomConstantRateStream(seededRandom(seed));
      const bwe = new SenderBandwidthEstimator();
      const t0 = Date.now() - 2_000;
      for (let i = 0; i < packets; i++) {
        bwe.rtpPacketSent(twccSentInfo(i + 1, sizeBytes, t0 + i * intervalMs));
      }
      const results = Array.from(
        { length: packets },
        (_, i) =>
          new PacketResult({
            sequenceNumber: i + 1,
            received: true,
            receivedAtMs: t0 + 20 + i * intervalMs * stretch,
          }),
      );

      // Act
      bwe.receiveTWCC(syntheticTwccFeedback(results));

      // Assert: 累積バイトを、入力した送信・受信時刻の幅で割った低い方（独立に再計算）
      const totalBits = packets * sizeBytes * 8 * 1_000;
      const sendSpanMs = (packets - 1) * intervalMs;
      const recvSpanMs = results.at(-1)!.receivedAtMs - results[0].receivedAtMs;
      const sendBps = Math.trunc(totalBits / sendSpanMs);
      const recvBps = Math.trunc(totalBits / recvSpanMs);
      expect(bwe.availableBitrate).toBe(Math.min(sendBps, recvBps));
    },
  );

  test.each(cases)(
    title(
      "legacy: onAvailableBitrate は値が変わったときだけ、その値で通知する",
    ),
    ({ seed }) => {
      // Arrange: 少数の値から重複を多く含む更新列
      const updates = randomBitrateUpdates(seededRandom(seed), 50);
      const bwe = new SenderBandwidthEstimator();
      const fired: number[] = [];
      bwe.onAvailableBitrate.subscribe((v) => fired.push(v));

      // Act
      for (const v of updates) bwe.availableBitrate = v;

      // Assert: 直前の値と違う更新だけが、その値のまま通知される
      const expected = updates.filter(
        (v, i) => v !== (i === 0 ? 0 : updates[i - 1]),
      );
      expect(fired).toEqual(expected);
    },
  );
});
