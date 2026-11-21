import { describe, expect, test } from "vitest";

import {
  abnormalExit,
  type DeepSearchConfig,
  planDeepSearch,
  SEED_TITLE_PATTERN,
  seedRanges,
} from "../src";
import { runFixtureDeepSearch } from "./utils";

const config: DeepSearchConfig = {
  cwd: "/tmp/pkg",
  suites: {
    slow: {
      file: "tests/pbt/slow/slowProperty.test.ts",
      prefix: "P_SLOW",
      seeds: 10,
    },
    fast: {
      file: "tests/pbt/fast/fastProperty.test.ts",
      prefix: "P_FAST",
      steps: 50,
    },
    custom: {
      file: "tests/pbt/custom/customProperty.test.ts",
      shards: ({ ranges, option }) => [
        { label: "custom fixed", file: "f", pattern: "fixed: ", env: {} },
        ...ranges(Number(option("custom-count") ?? 2), 1).map(({ first }) => ({
          label: `custom ${first}`,
          file: "f",
          env: { P_CUSTOM_SEED: String(first) },
        })),
      ],
    },
  },
  defaultSuites: ["slow", "custom"],
};

describe("deep search plan", () => {
  test("seed ranges cover the seeds once, at least jobs × 3 ranges", () => {
    // Act: 100 seed を 4 job で分ける。
    const ranges = seedRanges(100, { first: 11, jobs: 4 });

    // Assert: 11 から 110 まで重ならずに並び、12 個以上に分かれる。
    expect(ranges.length).toBeGreaterThanOrEqual(12);
    const all = ranges.flatMap(({ first, count }) =>
      [...Array(count)].map((_, i) => first + i),
    );
    expect(all).toEqual([...Array(100)].map((_, i) => 11 + i));
  });

  test("the default suites run in the config's order; a prefix suite shards its seed titles", () => {
    // Act: 引数なしで計画する。
    const plan = planDeepSearch(config, [], 2);

    // Assert: 既定の suite だけが設定の順に並ぶ。
    expect([...new Set(plan.map((p) => p.suite))]).toEqual(["slow", "custom"]);
    // Assert: prefix の suite は seed の範囲ごとの環境と seed の題名のパターンで分かれ、10 seed を覆う。
    const slow = plan.filter((p) => p.suite === "slow").map((p) => p.shard);
    expect(slow.every((s) => s.pattern === SEED_TITLE_PATTERN)).toBe(true);
    expect(slow.reduce((n, s) => n + Number(s.env.P_SLOW_SEEDS), 0)).toBe(10);
    expect(slow[0].env).toEqual({ P_SLOW_SEED: "1", P_SLOW_SEEDS: "2" });
  });

  test("--suite, --seeds, --steps and --seed override the defaults; a suite's own shards read its options", () => {
    // Act: suite・seed 数・steps・開始 seed・独自の option を指定する。
    const plan = planDeepSearch(
      config,
      [
        "--suite",
        "fast,custom",
        "--seeds",
        "6",
        "--steps",
        "9",
        "--seed",
        "100",
        "--custom-count",
        "3",
      ],
      1,
    );

    // Assert: fast は 100 から 6 seed、steps 9。custom は独自の分割 (固定 1 + 3)。
    const fast = plan.filter((p) => p.suite === "fast").map((p) => p.shard);
    expect(fast.map((s) => s.env.P_FAST_SEED)).toEqual(["100", "102", "104"]);
    expect(fast.every((s) => s.env.P_FAST_STEPS === "9")).toBe(true);
    const custom = plan
      .filter((p) => p.suite === "custom")
      .map((p) => p.shard.label);
    expect(custom).toEqual([
      "custom fixed",
      "custom 100",
      "custom 101",
      "custom 102",
    ]);
  });

  test("a suite's steps are passed when --steps is not given; an unknown suite is an error", () => {
    // Act / Assert: steps を持つ suite は既定の steps を渡す。
    const fast = planDeepSearch(config, ["--suite", "fast", "--seeds", "1"], 1);
    expect(fast[0].shard.env.P_FAST_STEPS).toBe("50");
    // Act / Assert: 知らない suite は例外。
    expect(() => planDeepSearch(config, ["--suite", "nope"], 1)).toThrow(
      /unknown pbt:deep suite nope/,
    );
  });
});

describe("deep search run", () => {
  test("a shard whose tests pass and whose vitest exits 0 passes", async () => {
    // Act: 通るだけのフィクスチャを実行器で動かす。
    const { exit, output } = await runFixtureDeepSearch(["passing"]);

    // Assert: 終了コード 0 で、1 件通過・失敗なしと報告する。
    expect(exit).toBe(0);
    expect(output).toContain("1 passed, 0 failed, 0 flaky");
  }, 60_000);

  test("an unhandled error after the assertions passed fails the search", async () => {
    // Act: assertion は通るが、その後に未処理の rejection で vitest が終了コード 1 になるフィクスチャを動かす。
    const { exit, lines } = await runFixtureDeepSearch(["unhandled"]);

    // Assert: テストの結果がすべて通過でも、実行器は終了コード 1 を返す。
    expect(exit).toBe(1);
    // Assert: 単独での再実行でも異常終了するので flaky ではなく失敗とし、分割名と終了コードを示す。
    expect(lines).toContain(
      "  FAILED unhandled shard: vitest exited with code 1 (an error outside the test results, e.g. an unhandled rejection)",
    );
    expect(lines.join("\n")).toContain("1 failed, 0 flaky");
  }, 60_000);

  test("a failing assertion fails the search under its test title", async () => {
    // Act: assertion が失敗するフィクスチャと、通るフィクスチャを同じ pool で動かす。
    const { exit, lines } = await runFixtureDeepSearch(["failing", "passing"]);

    // Assert: 終了コード 1 で、失敗はテストの題名で報告し、異常終了の行は重ねて出さない。
    expect(exit).toBe(1);
    expect(lines).toContain("  FAILED a failing fixture");
    expect(lines.some((line) => line.includes("vitest exited"))).toBe(false);
    // Assert: 通るフィクスチャは失敗にならない。
    expect(lines.join("\n")).toContain(
      "passing: 1 shards, 1 tests, 1 passed, 0 failed",
    );
  }, 60_000);

  test("an exit by a signal, an exit code or a missing report is abnormal; exit code 0 with a report is not", () => {
    // Act / Assert: シグナルで終わったプロセスは異常終了。
    expect(
      abnormalExit({ exitCode: null, signal: "SIGKILL", reported: true }),
    ).toBe("vitest was killed by SIGKILL");
    // Act / Assert: 終了コードが 0 以外なら異常終了。
    expect(abnormalExit({ exitCode: 2, signal: null, reported: true })).toMatch(
      /^vitest exited with code 2/,
    );
    // Act / Assert: 終了コード 0 でもレポートがなければ異常終了。
    expect(abnormalExit({ exitCode: 0, signal: null, reported: false })).toBe(
      "vitest wrote no report",
    );
    // Act / Assert: 終了コード 0 でレポートがあれば正常。
    expect(
      abnormalExit({ exitCode: 0, signal: null, reported: true }),
    ).toBeUndefined();
  });
});
