import { describe, expect, test } from "vitest";

import {
  abnormalExit,
  baselinePackageDir,
  type DeepSearchConfig,
  failureSignature,
  planDeepSearch,
  SEED_TITLE_PATTERN,
  STATISTICAL_FAILURE_MARKER,
  sameFailure,
  seedRanges,
} from "../src";
import {
  passingSource,
  rejection,
  runFixtureCli,
  runFixtureDeepSearch,
  testSource,
  throwingSource,
} from "./utils";

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

  test("the CLI of npm run pbt:deep (node, not vitest) runs shards and reads their reports", () => {
    // Act: package の npm script と同じく、node の型除去で cli.ts を起動する。
    const { status, stdout } = runFixtureCli("passing");

    // Assert: reporter を読み込んで結果を集計し、終了コード 0。
    expect(stdout).toContain("passing: 1 shards, 1 tests, 1 passed, 0 failed");
    expect(status).toBe(0);
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

/** The webrtc heap slope verdict (P3): a statistical assertion on a measured value. */
const slopeAssertion = (slope: number) =>
  `expect(true, ${JSON.stringify(`${STATISTICAL_FAILURE_MARKER} slope ${slope} KiB/cycle`)}).toBe(false);`;
const slopeSource = (slope: number) => testSource(slopeAssertion(slope));

/** A failing test whose first run executes `first` and whose later runs (the replay alone) `later`. */
const onceThen = (first: string, later: string) =>
  testSource(`const marker = new URL("./ran", import.meta.url);
  if (!existsSync(marker)) {
    writeFileSync(marker, "");
    ${first}
  }
  ${later}`);

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
      "failed the same way on the baseline (attempt 1): failed: AssertionError: expected 2 to be 3 // Object.is equality",
    );
    expect(output).toContain(
      "failing: 1 shards, 1 tests, 0 passed, 0 failed, 1 pre-existing",
    );
    expect(output).toMatch(
      /summary: 0 confirmed \(exit code\), 1 pre-existing \(same failure on .*\.worktree-/,
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
    // Act: 統計的な分割の、統計的な assertion の失敗を --baseline なしで動かす。
    const current = { failing: slopeSource(16.01) };
    const alone = await runFixtureDeepSearch(["failing"], {
      current,
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
      current,
      statistical: ["failing"],
      baseline: { failing: passingSource("a failing fixture") },
    });

    // Assert: 比較元で通るので確定した失敗として終了コード 1。
    expect(compared.exit).toBe(1);
    expect(compared.lines).toContain("  FAILED a failing fixture");

    // Act: 比較元でも同じ判定が別の測定値で失敗するようにして動かす。
    const repeated = await runFixtureDeepSearch(["failing"], {
      current,
      statistical: ["failing"],
      baseline: { failing: slopeSource(17.5) },
    });

    // Assert: 数値だけの違いは同じ形なので以前からの失敗。
    expect(repeated.exit).toBe(0);
    expect(repeated.lines).toContain("  pre-existing a failing fixture");
  }, 90_000);

  test.each([
    {
      name: "an operation that throws",
      source: testSource('throw new Error("the operation failed");'),
    },
    {
      name: "a timeout",
      source: testSource("await new Promise(() => {});", { timeout: 200 }),
    },
    {
      name: "an unhandled error besides the threshold",
      source: testSource(
        `${rejection("unhandled in the measurement")}\n  ${slopeAssertion(16.01)}`,
      ),
    },
    {
      name: "a failing hook besides the threshold",
      source: testSource(slopeAssertion(16.01), {
        setup: 'afterAll(() => {\n  throw new Error("cleanup failed");\n});',
      }),
    },
    {
      name: "a threshold on the first run and another error on the replay",
      source: onceThen(
        slopeAssertion(16.01),
        'throw new Error("the operation failed");',
      ),
    },
    {
      name: "a killed process",
      source: testSource('process.kill(process.ppid, "SIGKILL");'),
    },
  ])(
    "a statistical shard still fails on $name without a baseline",
    async ({ source }) => {
      // Act: 統計的な分割で、閾値の判定ではない失敗を起こす。
      const { exit, output } = await runFixtureDeepSearch(["failing"], {
        current: { failing: source },
        statistical: ["failing"],
      });

      // Assert: 通常の失敗として終了コード 1。
      expect(exit).toBe(1);
      expect(output).toMatch(/summary: [1-9]\d* confirmed/);
    },
    60_000,
  );

  test.each([
    {
      name: "the same first line and another second line (a scene error)",
      current: testSource('throw new Error("seed 4 scene {}\\ncause A");'),
      baseline: testSource('throw new Error("seed 4 scene {}\\ncause B");'),
    },
    {
      name: "another cause",
      current: testSource(
        'throw new Error("failed", { cause: new Error("cause A") });',
      ),
      baseline: testSource(
        'throw new Error("failed", { cause: new Error("cause B") });',
      ),
    },
    {
      name: "other actual values the message abbreviates",
      current: testSource(
        'expect(["a socket of the first transport was left open"]).toEqual([]);',
      ),
      baseline: testSource(
        'expect(["a timer of the second transport was left running"]).toEqual([]);',
      ),
    },
    {
      name: "the same message from another assertion",
      current: testSource("const left = 1;\n  expect(left).toBe(0);"),
      baseline: testSource("const right = 1;\n  expect(right).toBe(0);"),
    },
    {
      name: "another number",
      current: testSource('throw new Error("2 sockets left");'),
      baseline: testSource('throw new Error("1 sockets left");'),
    },
    {
      name: "another error type",
      current: testSource('throw new TypeError("failed");'),
      baseline: testSource('throw new RangeError("failed");'),
    },
    {
      name: "a first-run cause (another one on the replay) not seen",
      current: onceThen(
        'throw new Error("new on this revision");',
        'throw new Error("old flake");',
      ),
      baseline: testSource('throw new Error("old flake");'),
    },
  ])(
    "a test failing with $name than on the baseline stays confirmed",
    async ({ current, baseline }) => {
      // Act: 同じ題名のテストが、比較元では別の原因で失敗する。
      const { exit, lines } = await runFixtureDeepSearch(["failing"], {
        current: { failing: current },
        baseline: { failing: baseline },
      });

      // Assert: 確定した失敗のまま終了コード 1。
      expect(exit).toBe(1);
      expect(lines).toContain("  FAILED a failing fixture");
    },
    60_000,
  );

  test.each([
    {
      name: "a failed assertion",
      baseline: testSource("expect(1).toBe(2);"),
    },
    {
      name: "another unhandled error",
      baseline: testSource(rejection("another unhandled error")),
    },
  ])(
    "an unhandled error is not matched by $name on the baseline",
    async ({ baseline }) => {
      // Act: 現行は未処理の rejection、比較元は同じ終了コードの別の原因で失敗する。
      const { exit, output } = await runFixtureDeepSearch(["failing"], {
        current: { failing: testSource(rejection("new unhandled error")) },
        baseline: { failing: baseline },
      });

      // Assert: 原因が違うので確定した失敗のまま終了コード 1。
      expect(exit).toBe(1);
      expect(output).toContain("  FAILED failing shard: vitest exited");
      expect(output).toContain("summary: 1 confirmed (exit code)");
    },
    60_000,
  );

  test("a new unhandled error is not hidden by a pre-existing test failure of its shard", async () => {
    // Act: テストの失敗は比較元と同じで、現行にだけ未処理の rejection が加わる。
    const body = 'throw new Error("old failure");';
    const { exit, lines, output } = await runFixtureDeepSearch(["failing"], {
      current: {
        failing: testSource(body, { setup: rejection("new unhandled error") }),
      },
      baseline: { failing: testSource(body, { setup: "// nothing" }) },
    });

    // Assert: テストの失敗は以前からのもの、テストの外のエラーは確定として終了コード 1。
    expect(exit).toBe(1);
    expect(lines).toContain("  pre-existing a failing fixture");
    expect(output).toContain("  FAILED failing shard: ");
  }, 60_000);

  test("a killed process has no comparable cause and stays confirmed", async () => {
    // Act: 現行も比較元も vitest がシグナルで終了する。
    const source = testSource('process.kill(process.ppid, "SIGKILL");');
    const { exit, output } = await runFixtureDeepSearch(["failing"], {
      current: { failing: source },
      baseline: { failing: source },
    });

    // Assert: 原因を照合できないので確定した失敗とし、その理由を示す。
    expect(exit).toBe(1);
    expect(output).toContain(
      "not compared with the baseline: vitest was killed by SIGKILL",
    );
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

  test("the failure form keeps the whole cause and drops only run-to-run differences", () => {
    // Act: 作業ツリーの根・行番号・時間・色を含むエラーの形を作る。
    const error = {
      name: "Error",
      message: "\u001b[31mseed 4\ntimed out after 5012 ms in /a/b/x.ts:3:1",
      cause: { name: "TypeError", message: "2 sockets left" },
    };
    const form = failureSignature(error, "/a/b");

    // Assert: 2 行目以降と cause と数を残し、根・行番号・時間・色だけを除く。
    expect(form).toBe(
      "Error: seed 4\ntimed out after <n> ms in <root>/x.ts:<n>:<n>\ncaused by: TypeError: 2 sockets left",
    );
    // Act / Assert: メッセージのないエラー (cause を含む) は比較できる形がない。
    expect(failureSignature({}, "/a/b")).toBeUndefined();
    expect(failureSignature({ ...error, cause: {} }, "/a/b")).toBeUndefined();
  });

  test("the same form needs the same test and every observed cause", () => {
    // Arrange: 2 つの原因を示した失敗と、その 1 つだけを示す比較元の実行。
    const failure = {
      id: "t seed 4",
      kind: "test" as const,
      forms: ["Error: A", "Error: B"],
    };
    const run = (id: string, signature: string) => ({
      failed: [{ id, title: id, signature, statistical: false }],
      outside: [],
      signal: null,
      reported: true,
    });

    // Act / Assert: 片方の原因だけでは同じ形ではなく、両方がそろえば同じ形。
    expect(sameFailure(failure, [run("t seed 4", "Error: A")])).toBe(false);
    expect(
      sameFailure(failure, [
        run("t seed 4", "Error: A"),
        run("t seed 4", "Error: B"),
      ]),
    ).toBe(true);
    // Act / Assert: 別のテストの同じ原因は同じ形ではない。
    expect(
      sameFailure({ ...failure, forms: ["Error: A"] }, [
        run("t seed 5", "Error: A"),
      ]),
    ).toBe(false);
    // Act / Assert: 比較できる原因がない失敗は同じ形にならない。
    expect(
      sameFailure({ ...failure, forms: [] }, [run("t seed 4", "Error: A")]),
    ).toBe(false);
  });

  test("the baseline package is the same path relative to the worktree root", () => {
    // Act / Assert: 作業ツリーの根からの相対パスを比較元の根に付ける。
    expect(baselinePackageDir("/tmp/base", __dirname)).toBe(
      "/tmp/base/packages/pbt/tests",
    );
  });
});
