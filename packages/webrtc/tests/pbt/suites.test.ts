import { describe, expect, test } from "vitest";

import { failureSignature, STATISTICAL_FAILURE_MARKER } from "../../../pbt/src";
import { detectLeak, type MemorySample } from "../memleak/heapUtils";
import { UNMARKED_HEAP_VERDICT } from "./suites";

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

describe("pbt:deep P3 heap verdict of a baseline from before the marker", () => {
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
      expect(unmarked.message).toMatch(UNMARKED_HEAP_VERDICT);
      expect(
        failureSignature(unmarked, "/root", UNMARKED_HEAP_VERDICT),
      ).toEqual(failureSignature(marked, "/root", UNMARKED_HEAP_VERDICT));
    },
  );

  test("another assertion of the heap test does not match", () => {
    // Act / Assert: 判定の理由を持たない assertion や、後ろに続きのある文言は合わない。
    for (const message of [
      '["re-offer"]: the session ended: expected true to be false // Object.is equality',
      "the scene failed: expected true to be false // Object.is equality",
      '["re-offer"]: slope 20.00 KiB/cycle (R²=0.99) exceeds 16.00 KiB/cycle: expected 1 to be 2',
    ]) {
      expect(message).not.toMatch(UNMARKED_HEAP_VERDICT);
    }
  });
});
