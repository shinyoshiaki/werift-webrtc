import { describe, expect, test } from "vitest";

import {
  failureSignature,
  isStatisticalError,
  STATISTICAL_FAILURE_MARKER,
  sameFailure,
  statisticalExcess,
} from "../../../pbt/src";
import { detectLeak, type MemorySample } from "../memleak/heapUtils";
import { HEAP_VERDICT, heapVerdictExcess } from "./suites";

const MiB = 1024 * 1024;

/** Heap samples whose heapUsed after cycle `i` is `heapUsed(i)`. */
const samples = (heapUsed: (cycle: number) => number) =>
  [...Array(40).keys()].map(
    (cycle) => ({ cycle, heapUsed: heapUsed(cycle) }) as MemorySample,
  );

/** The AssertionError of the P3 verdict over `heapUsed`, with `prefix` before its message. */
function verdictError(heapUsed: (cycle: number) => number, prefix = "") {
  const verdict = detectLeak(samples(heapUsed), {
    warmup: 0,
    slopeThresholdBytes: 16 * 1024,
    marginRatio: 0.3,
  });
  try {
    expect(
      verdict.leaked,
      `${prefix}${JSON.stringify(["re-offer"])}: ${verdict.reason}`,
    ).toBe(false);
  } catch (error) {
    const { name, message } = error as Error;
    return { name, message };
  }
  throw new Error("the verdict did not fail");
}

describe("pbt:deep P3 heap verdict", () => {
  test.each([
    // 傾きだけ・margin だけ・両方が閾値を超える heapUsed の推移。
    { reason: "slope", heapUsed: (i: number) => 100 * MiB + i * 20_000 },
    { reason: "margin", heapUsed: (i: number) => (i < 35 ? 1 : 2) * MiB },
    { reason: "slope and margin", heapUsed: (i: number) => MiB + i * 100_000 },
  ])(
    "the unmarked $reason verdict has the form of the marked one",
    ({ heapUsed }) => {
      // Act: develop と同じマーカーなしの assertion と、現行のマーカー付きの assertion を失敗させる。
      const unmarked = verdictError(heapUsed);
      const marked = verdictError(heapUsed, `${STATISTICAL_FAILURE_MARKER} `);

      // Assert: マーカーなしの全文がパターンに合い、両方の形が一致する。
      expect(unmarked.message).toMatch(HEAP_VERDICT);
      expect(failureSignature(unmarked, "/root", HEAP_VERDICT)).toEqual(
        failureSignature(marked, "/root", HEAP_VERDICT),
      );
    },
  );

  test("another assertion of the heap test does not match", () => {
    // Act / Assert: 判定の理由を持たない assertion や、後ろに続きのある文言は合わない。
    for (const message of [
      '["re-offer"]: the session ended: expected true to be false // Object.is equality',
      "the scene failed: expected true to be false // Object.is equality",
      '["re-offer"]: slope 20.00 KiB/cycle (R²=0.99) exceeds 16.00 KiB/cycle: expected 1 to be 2',
    ]) {
      expect(message).not.toMatch(HEAP_VERDICT);
    }
  });

  test.each([
    { reason: "slope", heapUsed: (i: number) => 100 * MiB + i * 20_000 },
    { reason: "margin", heapUsed: (i: number) => (i < 35 ? 1 : 2) * MiB },
    { reason: "slope and margin", heapUsed: (i: number) => MiB + i * 100_000 },
  ])(
    "the marked $reason verdict is statistical and its excess grows with the leak",
    ({ heapUsed }) => {
      // Act: 同じ推移と、その 2 倍で増える推移の判定を失敗させる。
      const marker = `${STATISTICAL_FAILURE_MARKER} `;
      const small = verdictError(heapUsed, marker);
      const large = verdictError((i) => 2 * heapUsed(i) - heapUsed(0), marker);

      // Assert: マーカー付きの判定は統計的な assertion で、判定ごとの超過量を読める。
      expect(isStatisticalError(small, HEAP_VERDICT)).toBe(true);
      const smallExcess = statisticalExcess(
        [small],
        HEAP_VERDICT,
        heapVerdictExcess,
      );
      const largeExcess = statisticalExcess(
        [large],
        HEAP_VERDICT,
        heapVerdictExcess,
      );
      expect(smallExcess?.every(Number.isFinite)).toBe(true);
      // Assert: 大きく増える推移は、どの判定でも小さい推移以上に超える。
      expect(largeExcess).toHaveLength(smallExcess?.length ?? -1);
      largeExcess?.forEach((n, i) => {
        expect(n).toBeGreaterThanOrEqual(smallExcess?.[i] ?? Infinity);
      });
      // Assert: 同じ名前の Error (assertion でないもの) は統計的な判定ではない。
      expect(
        isStatisticalError(
          { name: "Error", message: small.message },
          HEAP_VERDICT,
        ),
      ).toBe(false);
    },
  );

  test("the excess is in bytes over each threshold", () => {
    // Act / Assert: 単位をそろえて、閾値を超えた量を判定ごとに返す。
    expect(
      heapVerdictExcess(
        '["re-offer"]: slope 16.01 KiB/cycle (R²=0.97) exceeds 16.00 KiB/cycle and final median 1.50 MiB exceeds baseline 1.00 MiB + margin 300.00 KiB: expected true to be false // Object.is equality',
      ),
    ).toEqual([16.01 * 1024 - 16 * 1024, 1.5 * MiB - MiB - 300 * 1024]);
    // Act / Assert: 判定の理由のない文言は読めない。
    expect(heapVerdictExcess("the session ended")).toBeUndefined();
  });

  /** A P3 verdict failure (an AssertionError) with `reason` as `detectLeak` writes it; `marked` adds the marker. */
  const reasonError = (reason: string, marked = true) => ({
    name: "AssertionError",
    message: `${marked ? `${STATISTICAL_FAILURE_MARKER} ` : ""}["re-offer"]: ${reason}: expected true to be false // Object.is equality`,
  });
  /** Whether a baseline failing with `baseline` is the same failure as `current` here (as `pbt:deep --baseline` compares them). */
  const sameAsBaseline = (
    current: ReturnType<typeof reasonError>,
    baseline: ReturnType<typeof reasonError>,
  ) => {
    const form = failureSignature(current, "/root", HEAP_VERDICT) as string;
    const here = statisticalExcess([current], HEAP_VERDICT, heapVerdictExcess);
    return sameFailure(
      {
        id: "heap seed 4",
        kind: "test",
        forms: [form],
        excess: here ? { [form]: here } : undefined,
      },
      [
        {
          failed: [
            {
              id: "heap seed 4",
              title: "heap seed 4",
              signature: failureSignature(baseline, "/root", HEAP_VERDICT),
              statistical: true,
              excess: statisticalExcess(
                [baseline],
                HEAP_VERDICT,
                heapVerdictExcess,
              ),
            },
          ],
          outside: [],
          signal: null,
          reported: true,
        },
      ],
    );
  };
  const slopeReason = (slope: string) =>
    `slope ${slope}/cycle (R²=0.98) exceeds 16.00 KiB/cycle`;
  const marginReason = (median: string) =>
    `final median ${median} exceeds baseline 512.00 B + margin 200.00 B`;

  test.each([
    {
      name: "a KiB slope here and a larger MiB slope on the baseline",
      current: reasonError(slopeReason("900.00 KiB")),
      baseline: reasonError(slopeReason("1.00 MiB"), false),
    },
    {
      name: "a B median here and a larger KiB median on the baseline",
      current: reasonError(marginReason("900.00 B")),
      baseline: reasonError(marginReason("1.50 KiB"), false),
    },
  ])(
    "the same verdict in other units is the same failure: $name",
    ({ current, baseline }) => {
      // Act: 単位をまたいで比較元の方が閾値を大きく超えた同じ判定を比べる。
      const same = sameAsBaseline(current, baseline);

      // Assert: 測定値と単位をまとめて置き換えるので同じ形になり、bytes の超過量も比較元以下なので以前からの失敗。
      expect(failureSignature(current, "/root", HEAP_VERDICT)).toEqual(
        failureSignature(baseline, "/root", HEAP_VERDICT),
      );
      expect(same).toBe(true);
    },
  );

  test.each([
    {
      name: "a MiB slope here and a smaller KiB slope on the baseline",
      current: reasonError(slopeReason("1.00 MiB")),
      baseline: reasonError(slopeReason("900.00 KiB")),
    },
    {
      name: "a KiB median here and a smaller B median on the baseline",
      current: reasonError(marginReason("1.50 KiB")),
      baseline: reasonError(marginReason("900.00 B")),
    },
  ])(
    "a verdict past the baseline's in other units stays confirmed: $name",
    ({ current, baseline }) => {
      // Act: 単位をまたいで現行の方が閾値を大きく超えた同じ判定を比べる。
      const same = sameAsBaseline(current, baseline);

      // Assert: 形は同じでも、bytes に換算した超過量が比較元より大きいので同じ失敗ではない。
      expect(failureSignature(current, "/root", HEAP_VERDICT)).toEqual(
        failureSignature(baseline, "/root", HEAP_VERDICT),
      );
      expect(same).toBe(false);
    },
  );
});
