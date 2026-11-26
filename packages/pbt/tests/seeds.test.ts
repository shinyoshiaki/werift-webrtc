import { afterEach, describe, expect, test } from "vitest";

import { propertyOptions, propertySeeds, SEED_TITLE_PATTERN } from "../src";

describe("propertySeeds", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test("defaults: the CI seeds from 1, the steps, no selected seed", () => {
    // Act: 環境変数なしで seed を求める。
    const p = propertySeeds("WERIFT_PBT_TEST", { seeds: 3, steps: 20 });

    // Assert: 1 から 3 個、steps は既定値、seed は選ばれていない。
    expect(p.seeds).toEqual([1, 2, 3]);
    expect(p.cases).toEqual([{ seed: 1 }, { seed: 2 }, { seed: 3 }]);
    expect(p.steps).toBe(20);
    expect(p.seedSelected).toBe(false);
  });

  test("the environment selects the seeds and steps; replay and title name them", () => {
    // Arrange: 1 つの seed の再実行と同じ環境変数。
    process.env.WERIFT_PBT_TEST_SEED = "17";
    process.env.WERIFT_PBT_TEST_SEEDS = "2";
    process.env.WERIFT_PBT_TEST_STEPS = "5";

    // Act: seed を求める。
    const p = propertySeeds("WERIFT_PBT_TEST", { seeds: 3 });

    // Assert: 17 から 2 個、steps 5、選ばれた seed。replay は同じ環境を表す。
    expect(p.seeds).toEqual([17, 18]);
    expect(p.steps).toBe(5);
    expect(p.seedSelected).toBe(true);
    expect(p.replay(18)).toBe(
      "WERIFT_PBT_TEST_SEED=18 WERIFT_PBT_TEST_SEEDS=1 WERIFT_PBT_TEST_STEPS=5",
    );
    // Assert: title の seed を埋めた名前は、deep search が選ぶパターンに合う。
    const name = p.title("claim").replaceAll("$seed", "18");
    expect(name).toBe(
      "claim: seed 18 (replay: WERIFT_PBT_TEST_SEED=18 WERIFT_PBT_TEST_SEEDS=1 WERIFT_PBT_TEST_STEPS=5)",
    );
    expect(new RegExp(SEED_TITLE_PATTERN).test(name)).toBe(true);
  });

  test("steps default to 1 when the property has none", () => {
    // Act / Assert: steps のない property。
    expect(propertySeeds("WERIFT_PBT_TEST", { seeds: 1 }).steps).toBe(1);
  });

  test("propertyOptions never retries", () => {
    // Act / Assert: retry は常に 0、timeout は指定したときだけ。
    expect(propertyOptions()).toEqual({ retry: 0 });
    expect(propertyOptions(5000)).toEqual({ retry: 0, timeout: 5000 });
  });
});
