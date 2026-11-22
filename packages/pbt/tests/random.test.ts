import { describe, expect, test } from "vitest";

import { seededRandom } from "../src";

describe("seededRandom", () => {
  /**
   * The first values of a few seeds, recorded from the stream every package
   * used before this base (webrtc `tests/pbt/shared/random.ts`, ice / sctp /
   * rtp copies): a recorded seed must keep replaying the same inputs.
   */
  const GOLDEN: Record<number, number[]> = {
    0: [
      0.26642920868471265, 0.0003297457005828619, 0.2232720274478197,
      0.1462021479383111,
    ],
    1: [
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
      0.9810509674716741,
    ],
    42: [
      0.6011037519201636, 0.44829055899754167, 0.8524657934904099,
      0.6697340414393693,
    ],
    4294967295: [
      0.8964226141106337, 0.189478256739676, 0.7156526781618595,
      0.9440599093213677,
    ],
  };

  test.each(Object.keys(GOLDEN).map(Number))(
    "seed %i yields the recorded stream (every recorded seed replays)",
    (seed) => {
      // Act: 同じ seed で 4 個引く。
      const random = seededRandom(seed);
      const values = [...Array(4)].map(() => random.next());

      // Assert: 記録した列と一致する。
      expect(values).toEqual(GOLDEN[seed]);
    },
  );

  test("a negative or fractional seed is taken as its uint32 (as before)", () => {
    // Act / Assert: -1 は 2^32 - 1 と同じ列。
    const a = seededRandom(-1);
    const b = seededRandom(4294967295);
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
  });

  test("the helpers stay in their ranges", () => {
    // Arrange: seed 7 の乱数。
    const random = seededRandom(7);

    // Act / Assert: int は [min, max)、between は [min, max)、pick は要素のどれか、next は [0, 1)。
    for (let i = 0; i < 1000; i++) {
      const n = random.int(-3, 4);
      expect(Number.isInteger(n) && n >= -3 && n < 4).toBe(true);
      const x = random.between(1.5, 2.5);
      expect(x >= 1.5 && x < 2.5).toBe(true);
      expect(["a", "b", "c"]).toContain(random.pick(["a", "b", "c"]));
      const v = random.next();
      expect(v >= 0 && v < 1).toBe(true);
    }
  });
});
