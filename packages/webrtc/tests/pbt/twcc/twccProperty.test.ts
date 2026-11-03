import { describe, expect, test } from "vitest";
import {
  type BandwidthEstimator,
  GccBandwidthEstimator,
  kSendTimeHistoryWindowMs,
  PacketResult,
  SenderBandwidthEstimator,
  sortPacketResultsByWideSeq,
  TWCC_REFERENCE_TIME_MOD,
  TWCC_REFERENCE_TIME_UNIT_MS,
  TwccFeedbackAdapter,
  type TwccPacketFeedback,
  TwccReferenceTimeUnwrapper,
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

const createEstimator = (
  kind: "legacy" | "gcc",
  clock?: () => number,
): BandwidthEstimator =>
  kind === "legacy"
    ? new SenderBandwidthEstimator({ clock })
    : new GccBandwidthEstimator(300_000, { clock });

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
      "adapter: 周回・送信確認の逆順・重複・並べ替え・corrective を混ぜても、受信した送信パケットは正しい世代でちょうど 1 回対応する",
    ),
    ({ seed }) => {
      // Arrange: 他 sender の TSN、順序外の送信確認、重複・遅延・corrective を含む feedback 列
      const { owned, sendOrder, deliveries } = randomTransport(
        seededRandom(seed),
        steps,
      );
      const adapter = new TwccFeedbackAdapter(60_000);
      for (const info of sendOrder) adapter.onSent(info);
      const feedbackAtMs = Math.max(...sendOrder.map((i) => i.sentAtMs)) + 100;

      // Act
      const reports = deliver(deliveries, (fb) =>
        adapter.onFeedback(fb, feedbackAtMs),
      );

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
      // Assert: どれかの feedback が受信と報告した自分の送信パケットは、取りこぼさず対応する
      const reportedReceived = new Set<number>();
      for (const w of deliveries) {
        w.recvUs.forEach((us, i) => {
          if (us !== undefined && owned.has(w.baseExt + i)) {
            reportedReceived.add(w.baseExt + i);
          }
        });
      }
      expect([...receivedCount.keys()].sort((a, b) => a - b)).toEqual(
        [...reportedReceived].sort((a, b) => a - b),
      );
    },
  );

  test.each(cases)(
    title(
      "estimator ($kind): estimator に渡る受信報告は送信パケットごとに高々 1 回",
    ),
    ({ seed, kind }) => {
      // Arrange: legacy / GCC は共通 adapter の出力だけを使う
      const { owned, sendOrder, deliveries } = randomTransport(
        seededRandom(seed),
        steps,
      );
      const estimator = createEstimator(kind);
      const matched = captureMatchedFeedback(estimator);
      for (const info of sendOrder) estimator.rtpPacketSent(info);

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
      "history ($kind): 送信完了の遅れ・送信停止後の feedback を混ぜても、照合で返るパケットは照合時点で時間窓内・番号 span 32768 未満で、範囲内の項目は消えない",
    ),
    ({ seed, kind }) => {
      // Arrange: legacy は 10 秒窓、GCC は 60 秒窓。送信確認・process・feedback の時刻を同じ clock で与える
      const windowMs = kind === "legacy" ? 10_000 : kSendTimeHistoryWindowMs;
      let clockMs = Number.NEGATIVE_INFINITY;
      const estimator = createEstimator(kind, () => clockMs);
      const matched = captureMatchedFeedback(estimator);
      const ops = randomHistoryOps(
        seededRandom(seed),
        steps,
        kind === "gcc",
        windowMs,
      );
      const confirmed: { seq: number; sendingAtMs: number }[] = [];
      const acked = new Set<number>();
      let latest = Number.NEGATIVE_INFINITY;

      for (const [i, op] of ops.entries()) {
        // Act: 送信確認（拡張 TSN、周回・飛び・順序外・完了の遅れあり）、process、または feedback
        clockMs = Math.max(clockMs, op.atMs);
        if (op.type === "send") {
          estimator.rtpPacketSent(
            twccSentInfo(op.seq, 100, op.sendingAtMs, { sentAtMs: op.atMs }),
          );
          confirmed.push(op);
          latest = Math.max(latest, op.seq);
        } else if (op.type === "process") {
          estimator.process(op.atMs);
        } else {
          const before = matched.length;
          const recvUs = Array.from(
            { length: op.count },
            (_, j) => op.atMs * 1_000 + j * 100,
          );
          estimator.receiveTWCC(wireTwccFeedback(op.baseSeq, recvUs));
          // Assert: 照合で返るパケットは、照合時点で時間窓の内側・最新の番号から span 32768 未満・feedback が覆った番号
          for (const p of matched.slice(before).flat()) {
            expect(clockMs - p.sent.sendingAtMs).toBeLessThanOrEqual(windowMs);
            expect(latest - p.extSeq).toBeLessThan(0x8000);
            expect(p.extSeq - op.baseSeq).toBeGreaterThanOrEqual(0);
            expect(p.extSeq - op.baseSeq).toBeLessThan(op.count);
            acked.add(p.extSeq);
          }
        }
        if (i % 97 !== 0 && i !== ops.length - 1) continue;

        // Assert: 残っているのは現在時刻から窓内だけで、どの番号も最新から span 32768 未満
        const history = twccHistoryOf(estimator);
        for (const [key, info] of history) {
          expect(clockMs - info.sendingAtMs).toBeLessThanOrEqual(windowMs);
          expect(latest - key).toBeLessThan(0x8000);
        }
        // Assert: 受信と照合されていない送信のうち、現在も窓内・span 内のものは消えていない
        for (const c of confirmed) {
          if (acked.has(c.seq)) continue;
          if (clockMs - c.sendingAtMs <= windowMs && latest - c.seq < 0x8000) {
            expect(history.has(c.seq)).toBe(true);
          }
        }
      }
    },
  );
});
