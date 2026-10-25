import { describe, expect, test } from "vitest";
import {
  type BandwidthEstimator,
  GccBandwidthEstimator,
  PacketResult,
  SenderBandwidthEstimator,
  TWCC_REFERENCE_TIME_MOD,
  TWCC_REFERENCE_TIME_UNIT_MS,
  TwccFeedbackAdapter,
  type TwccPacketFeedback,
  TwccReferenceTimeUnwrapper,
  kSendTimeHistoryWindowMs,
  sortPacketResultsByWideSeq,
} from "../../../src";
import {
  captureMatchedFeedback,
  twccHistoryOf,
  twccSentInfo,
  wireTwccFeedback,
} from "../../media/twccTestUtils";
import { seededRandom } from "../shared/random";
import { propertySeeds } from "../shared/seeds";
import {
  type FeedbackWindow,
  randomHistoryOps,
  randomReferenceTimes,
  randomTransport,
  randomTwccWindow,
} from "./generator";

/**
 * TWCC property test: claims about how TWCC feedback is encoded, normalized,
 * and kept in the send history, for any input a seed draws
 * (`twcc/generator.ts`).
 *
 * CI runs `WERIFT_TWCC_SEEDS` (default 24) seeds per property from
 * `WERIFT_TWCC_SEED` (default 1); `WERIFT_TWCC_STEPS` (default 3000) is the
 * length of the operation sequences (transport packets, history operations,
 * reference-time points). A failing title prints the replay environment.
 */
const { seeds, steps, replay } = propertySeeds("WERIFT_TWCC", {
  seeds: 24,
  steps: 3_000,
});
const cases = seeds.map((seed) => ({
  seed,
  kind: (seed % 2 === 1 ? "legacy" : "gcc") as "legacy" | "gcc",
}));
const title = (claim: string) =>
  `${claim}: seed $seed (replay: ${replay("$seed")})`;

const createEstimator = (kind: "legacy" | "gcc"): BandwidthEstimator =>
  kind === "legacy"
    ? new SenderBandwidthEstimator()
    : new GccBandwidthEstimator(300_000);

/** Act: feed every delivery and collect what each feedback reported. */
function deliver(
  deliveries: FeedbackWindow[],
  onFeedback: (
    feedback: ReturnType<typeof wireTwccFeedback>,
  ) => TwccPacketFeedback[],
) {
  return deliveries.map((w, i) => ({
    covered: new Set(w.recvUs.map((_, j) => w.baseExt + j)),
    out: onFeedback(wireTwccFeedback(w.baseExt, w.recvUs, i & 0xff)),
  }));
}

describe("twcc property", () => {
  test.each(cases)(
    title(
      "adapter: 周回・重複・並べ替え・corrective を混ぜても受信は高々 1 回で、正しい世代だけに対応する",
    ),
    ({ seed }) => {
      // Arrange: 他 sender の TSN と、重複・遅延・corrective を含む feedback 列
      const { owned, deliveries } = randomTransport(seededRandom(seed), steps);
      const adapter = new TwccFeedbackAdapter(60_000);
      for (const info of owned.values()) adapter.onSent(info);

      // Act
      const reports = deliver(deliveries, (fb) => adapter.onFeedback(fb));

      // Assert: 出力はその feedback が覆った TSN（= 正しい世代）で、送信記録もその TSN のもの
      const receivedCount = new Map<number, number>();
      for (const { covered, out } of reports) {
        for (const p of out) {
          expect(covered.has(p.extSeq)).toBe(true);
          expect(p.sent).toBe(owned.get(p.extSeq));
          if (p.received) {
            receivedCount.set(p.extSeq, (receivedCount.get(p.extSeq) ?? 0) + 1);
          }
        }
      }
      // Assert: どの送信パケットも受信として数えるのは 1 回以下で、他 sender の TSN は数えない
      expect(Math.max(0, ...receivedCount.values())).toBeLessThanOrEqual(1);
      for (const ext of receivedCount.keys()) expect(owned.has(ext)).toBe(true);
    },
  );

  test.each(cases)(
    title(
      "estimator ($kind): estimator に渡る受信報告は送信パケットごとに高々 1 回",
    ),
    ({ seed, kind }) => {
      // Arrange: legacy / GCC は共通 adapter の出力だけを使う
      const { owned, deliveries } = randomTransport(seededRandom(seed), steps);
      const estimator = createEstimator(kind);
      const matched = captureMatchedFeedback(estimator);
      for (const info of owned.values()) estimator.rtpPacketSent(info);

      // Act
      deliver(deliveries, (fb) => {
        estimator.receiveTWCC(fb);
        return matched.at(-1) ?? [];
      });

      // Assert: 受信報告に重複がなく、すべて自分が送った TSN
      const received = matched.flat().filter((p) => p.received);
      const unique = new Set(received.map((p) => p.extSeq));
      expect(received.length).toBe(unique.size);
      for (const ext of unique) expect(owned.has(ext)).toBe(true);
    },
  );

  test.each(cases)(
    title(
      "wire: 往復で番号・受信状態・受信時刻（250µs 切り捨ての累積誤差内）が復元される",
    ),
    ({ seed }) => {
      // Arrange: 周回・ロス・大きな間隔・並べ替えを含む連続窓
      const { base16, recvUs } = randomTwccWindow(seededRandom(seed));

      // Act: RunLength chunk で符号化 → serialize → deserialize → packetResults
      const results = wireTwccFeedback(base16, recvUs).packetResults;

      // Assert: 番号は base から連続（16-bit で周回）し、受信状態も一致する
      expect(results.map((r) => r.sequenceNumber)).toEqual(
        recvUs.map((_, i) => (base16 + i) & 0xffff),
      );
      expect(results.map((r) => r.received)).toEqual(
        recvUs.map((us) => us !== undefined),
      );
      // Assert: 受信時刻の誤差は受信 1 件ごとに最大 0.25ms の累積以内
      let received = 0;
      results.forEach((r, i) => {
        const us = recvUs[i];
        if (us === undefined) return;
        received++;
        expect(Math.abs(r.receivedAtMs - us / 1_000)).toBeLessThanOrEqual(
          0.25 * received + 1e-9,
        );
      });
    },
  );

  test.each(cases)(
    title("sort: 周回をまたぐ窓を送信順に並べる"),
    ({ seed }) => {
      // Arrange: 周回付近を含む連続窓をシャッフルする
      const rng = seededRandom(seed);
      const { base16, recvUs } = randomTwccWindow(rng);
      const ordered = recvUs.map(
        (_, i) => new PacketResult({ sequenceNumber: (base16 + i) & 0xffff }),
      );
      const shuffled = [...ordered].sort(() => rng.next() - 0.5);

      // Act
      const sorted = sortPacketResultsByWideSeq(shuffled);

      // Assert: base から番号順（65535 の次は 0）
      expect(sorted.map((r) => r.sequenceNumber)).toEqual(
        ordered.map((r) => r.sequenceNumber),
      );
    },
  );

  test.each(cases)(
    title(
      "reference_time: 周回・並べ替えをまたいでも展開後の時刻差は真の時刻差と一致する",
    ),
    ({ seed }) => {
      // Arrange: 周回付近を前後する真の reference_time 列
      const truth = randomReferenceTimes(
        seededRandom(seed),
        TWCC_REFERENCE_TIME_MOD,
        steps,
      );
      const unwrapper = new TwccReferenceTimeUnwrapper();

      // Act: 下位 24 bit だけを順に渡す
      const unwrapped = truth.map((units) =>
        unwrapper.unwrapBaseMs(units % TWCC_REFERENCE_TIME_MOD),
      );

      // Assert: 最初からの差は真の差と一致する（約 12 日戻ったりしない）
      unwrapped.forEach((ms, i) => {
        expect(ms - unwrapped[0]).toBe(
          (truth[i] - truth[0]) * TWCC_REFERENCE_TIME_UNIT_MS,
        );
      });
    },
  );

  test.each(cases)(
    title(
      "history ($kind): 送信履歴は時間窓内・番号 span 32768 未満・送信順に保たれる",
    ),
    ({ seed, kind }) => {
      // Arrange: legacy は送信時だけ 10 秒窓、GCC は送信時と process 時に 60 秒窓で掃除する
      const estimator = createEstimator(kind);
      const windowMs = kind === "legacy" ? 10_000 : kSendTimeHistoryWindowMs;
      const ops = randomHistoryOps(seededRandom(seed), steps, kind === "gcc");

      for (const [i, op] of ops.entries()) {
        // Act: 送信（16-bit TSN、周回・飛びあり）または process
        if (op.type === "send") {
          estimator.rtpPacketSent(twccSentInfo(op.seq16, 100, op.atMs));
        } else {
          estimator.process(op.atMs);
        }
        if (i % 97 !== 0 && i !== ops.length - 1) continue;

        // Assert: 残っているのは窓内だけで、拡張番号は昇順・span 32768 未満
        const entries = [...twccHistoryOf(estimator).entries()];
        for (const [, info] of entries) {
          expect(op.atMs - info.sendingAtMs).toBeLessThanOrEqual(windowMs);
        }
        const keys = entries.map(([key]) => key);
        for (let k = 1; k < keys.length; k++) {
          expect(keys[k]).toBeGreaterThan(keys[k - 1]);
        }
        if (keys.length > 0) {
          expect(keys.at(-1)! - keys[0]).toBeLessThan(0x8000);
        }
      }
    },
  );
});
