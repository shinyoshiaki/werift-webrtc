import { describe, expect, test } from "vitest";

import {
  abnormalExit,
  baselinePackageDir,
  type DeepSearchConfig,
  failureSignature,
  planDeepSearch,
  SEED_TITLE_PATTERN,
  sameFailure,
  seedRanges,
} from "../src";
import { passingSource, runFixtureDeepSearch, throwingSource } from "./utils";

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
    expect(output).toContain("1 passed, 0 failed, 0 pre-existing, 0 flaky");
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
    expect(lines.join("\n")).toContain("1 failed, 0 pre-existing, 0 flaky");
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

describe("deep search against a baseline", () => {
  test("a confirmed failure the baseline passes stays in the exit code", async () => {
    // Act: 比較元では同じ題名のテストが通るようにして --baseline で動かす。
    const { exit, lines, output } = await runFixtureDeepSearch(["failing"], {
      baseline: { failing: passingSource("a failing fixture") },
    });

    // Assert: 変更起因の失敗として終了コード 1 で、比較元の結果を添えて報告する。
    expect(exit).toBe(1);
    expect(lines).toContain("  FAILED a failing fixture");
    expect(lines).toContain("    baseline: passed");
    expect(output).toContain(
      "summary: 1 confirmed (exit code), 0 pre-existing",
    );
  }, 60_000);

  test("a failure the baseline repeats in the same form is pre-existing and leaves the exit code", async () => {
    // Act: 比較元も同じフィクスチャ (同じ題名・同じメッセージで失敗) のまま動かす。
    const { exit, lines, output } = await runFixtureDeepSearch(
      ["failing", "passing"],
      { baseline: {} },
    );

    // Assert: 以前からの失敗として報告し、終了コードは 0。
    expect(exit).toBe(0);
    expect(lines).toContain("  pre-existing a failing fixture");
    expect(output).toContain(
      "failed the same way on the baseline (attempt 1): failed: AssertionError: expected <n> to be <n> // Object.is equality",
    );
    expect(output).toContain(
      "failing: 1 shards, 1 tests, 0 passed, 0 failed, 1 pre-existing",
    );
    expect(output).toMatch(
      /summary: 0 confirmed \(exit code\), 1 pre-existing \(same failure on .*\.baseline-/,
    );
  }, 60_000);

  test("a failure the baseline shows in another form stays confirmed", async () => {
    // Act: 比較元では同じ題名のテストが別のメッセージで失敗する。
    const { exit, lines } = await runFixtureDeepSearch(["failing"], {
      baseline: {
        failing: throwingSource("a failing fixture", "another error"),
      },
    });

    // Assert: 同じ形ではないので確定した失敗のまま終了コード 1。
    expect(exit).toBe(1);
    expect(lines).toContain("  FAILED a failing fixture");
    expect(lines).toContain("    baseline: failed: Error: another error");
  }, 60_000);

  test("an abnormal exit the baseline repeats is pre-existing", async () => {
    // Act: 未処理の rejection で終わるフィクスチャを、比較元も同じまま動かす。
    const { exit, lines } = await runFixtureDeepSearch(["unhandled"], {
      baseline: {},
    });

    // Assert: 同じ異常終了の理由なので以前からの失敗とし、終了コードは 0。
    expect(exit).toBe(0);
    expect(lines).toContain(
      "  pre-existing unhandled shard: vitest exited with code 1 (an error outside the test results, e.g. an unhandled rejection)",
    );
  }, 60_000);

  test("a statistical failure is not judged without a baseline and is judged against one", async () => {
    // Act: 統計的な分割の失敗を --baseline なしで動かす。
    const alone = await runFixtureDeepSearch(["failing"], {
      statistical: ["failing"],
    });

    // Assert: statistical として示し、終了コードに含めない。
    expect(alone.exit).toBe(0);
    expect(alone.lines).toContain(
      "  statistical (judged only with --baseline) a failing fixture",
    );
    expect(alone.output).toContain(
      "1 statistical (not judged without --baseline)",
    );

    // Act: 比較元では通るようにして --baseline で動かす。
    const compared = await runFixtureDeepSearch(["failing"], {
      statistical: ["failing"],
      baseline: { failing: passingSource("a failing fixture") },
    });

    // Assert: 比較元で通るので確定した失敗として終了コード 1。
    expect(compared.exit).toBe(1);
    expect(compared.lines).toContain("  FAILED a failing fixture");
  }, 60_000);

  test("a baseline without the package is an error before any shard runs", async () => {
    // Act: パッケージのないディレクトリを比較元に渡す。
    const { exit, output } = await runFixtureDeepSearch(["passing"], {
      argv: ["--baseline", "/nonexistent-baseline"],
    });

    // Assert: 終了コード 2 で理由を示し、分割は実行しない。
    expect(exit).toBe(2);
    expect(output).toContain("has no package.json");
    expect(output).not.toContain("passing: 1 shards");
  });

  test("the failure form ignores colors and numbers; the same form needs the same title", () => {
    // Act / Assert: 色と数値の違いは同じ形、最初の空でない行だけを見る。
    expect(
      failureSignature(
        "\u001b[31m\nheap seed 4: slope 16.01 KiB/cycle > 16.00\nat x.ts:3:1",
      ),
    ).toBe("heap seed <n>: slope <n> KiB/cycle > <n>");
    const failure = {
      title: "t seed 4",
      kind: "test" as const,
      signatures: ["Error: the transport did not settle"],
    };
    const run = {
      failed: ["t seed 4"],
      messages: { "t seed 4": "Error: the transport did not settle" },
      exitCode: 1,
      signal: null,
      reported: true,
    };
    expect(sameFailure(failure, run)).toBe(true);
    // Act / Assert: 題名が違えば同じメッセージでも同じ形ではない。
    expect(sameFailure({ ...failure, title: "t seed 5" }, run)).toBe(false);
    // Act / Assert: 比較元が通った (失敗の題名がない) なら同じ形ではない。
    expect(
      sameFailure(failure, { ...run, failed: [], messages: {}, exitCode: 0 }),
    ).toBe(false);
  });

  test("the baseline package is the same path relative to the worktree root", () => {
    // Act / Assert: 作業ツリーの根からの相対パスを比較元の根に付ける。
    expect(baselinePackageDir("/tmp/base", __dirname)).toBe(
      "/tmp/base/packages/pbt/tests",
    );
  });
});
